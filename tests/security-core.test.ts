import { describe, it, expect, beforeEach } from 'vitest'

// Модули защиты: пароли (scrypt), примитивы (токены/хеши), rate limit,
// очередь запросов, троттлинг канала, редакции, санитизация настроек.

import { hashPassword, verifyPassword, passwordIssues } from '@/lib/security/password'
import { randomToken, sha256hex, safeEqual } from '@/lib/security/ids'
import { rateLimit, recordFailure, peekBlocked, resetRate, resetAllRates } from '@/lib/security/ratelimit'
import { withQueue, QueueFullError, queueStats, resetQueues, queueConfig } from '@/lib/security/queue'
import { Bandwidth, throttledStream, globalDownloadBandwidth, resetGlobalBandwidth } from '@/lib/security/throttle'
import { edition, multiUserEnabled } from '@/lib/edition'
import { sanitizeSettings, sameOriginOk } from '@/lib/security/guard'

describe('пароли (scrypt)', () => {
  it('хеш и проверка: верный пароль проходит, неверный нет', () => {
    const h = hashPassword('S3cure-pass')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('S3cure-pass', h)).toBe(true)
    expect(verifyPassword('s3cure-pass', h)).toBe(false)
    expect(verifyPassword('S3cure-pass', 'мусор')).toBe(false)
  })

  it('соль уникальна: два хеша одного пароля не совпадают, оба проходят', () => {
    const a = hashPassword('S3cure-pass')
    const b = hashPassword('S3cure-pass')
    expect(a).not.toBe(b)
    expect(verifyPassword('S3cure-pass', a)).toBe(true)
    expect(verifyPassword('S3cure-pass', b)).toBe(true)
  })

  it('политика пароля: короткий/без цифр/без букв', () => {
    expect(passwordIssues('a1b2c3d4')).toEqual([])
    expect(passwordIssues('a1b2')).toContain('минимум 8 символов')
    expect(passwordIssues('абвгдеёж')).toContain('нужна хотя бы одна цифра')
    expect(passwordIssues('12345678')).toContain('нужна хотя бы одна буква')
  })
})

describe('примитивы (ids.ts)', () => {
  it('randomToken: 32 байта → base64url без «=», уникален', () => {
    const t1 = randomToken(32)
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(t1).not.toBe(randomToken(32))
  })

  it('sha256hex и константное сравнение safeEqual', () => {
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(safeEqual('k1', 'k1')).toBe(true)
    expect(safeEqual('k1', 'k2')).toBe(false)
    expect(safeEqual('короткий', 'длинный-ключ')).toBe(false)
  })
})

describe('rate limit (скользящее окно)', () => {
  beforeEach(() => resetAllRates())

  it('лимит: N запросов проходят, лишние — отказ с Retry-After', () => {
    const rule = { limit: 3, windowMs: 60_000 }
    for (let i = 0; i < 3; i++) expect(rateLimit('k', rule).ok).toBe(true)
    const v = rateLimit('k', rule)
    expect(v.ok).toBe(false)
    expect(v.retryAfterSec).toBeGreaterThan(0)
  })

  it('blockMs: после превышения адрес заблокирован (peekBlocked > 0), resetRate снимает', () => {
    const rule = { limit: 1, windowMs: 60_000, blockMs: 120_000 }
    expect(rateLimit('b', rule).ok).toBe(true)
    expect(rateLimit('b', rule).ok).toBe(false)
    expect(peekBlocked('b')).toBeGreaterThan(0)
    resetRate('b')
    expect(peekBlocked('b')).toBe(0)
    expect(rateLimit('b', rule).ok).toBe(true)
  })

  it('recordFailure копит неудачи, блокирует по limit и blockMs', () => {
    const rule = { limit: 3, windowMs: 60_000, blockMs: 180_000 }
    for (let i = 0; i < 2; i++) expect(recordFailure('f', rule).ok).toBe(true)
    expect(recordFailure('f', rule).ok).toBe(false) // третья неудача → блок
    expect(peekBlocked('f')).toBe(180)
  })

  it('ключи независимы: лимит одного не задевает другой', () => {
    const rule = { limit: 1, windowMs: 60_000 }
    expect(rateLimit('x1', rule).ok).toBe(true)
    expect(rateLimit('x1', rule).ok).toBe(false)
    expect(rateLimit('x2', rule).ok).toBe(true)
  })
})

describe('очередь запросов', () => {
  beforeEach(() => resetQueues())

  it('параллельность: не больше maxConcurrent одновременно, потом — очередь', async () => {
    let running = 0
    let peak = 0
    const task = () => new Promise<void>((r) => {
      running++
      peak = Math.max(peak, running)
      setTimeout(() => { running--; r() }, 60)
    })
    const cfg = { maxConcurrent: 2, maxWaiting: 8, maxWaitMs: 5000 }
    await Promise.all(Array.from({ length: 5 }, () => withQueue('test-peak', task, cfg)))
    expect(peak).toBeLessThanOrEqual(2)
    expect(queueStats('test-peak')).toEqual({ running: 0, waiting: 0 })
  })

  it('переполнение очереди — мгновенный QueueFullError (429)', async () => {
    const gate = new Promise(() => undefined) // никогда не завершится
    const cfg = { maxConcurrent: 1, maxWaiting: 2, maxWaitMs: 5000 }
    // 1 выполняется (gate), 2 ждут — очередь заполнена до maxWaiting
    void withQueue('full', () => gate, cfg)
    void withQueue('full', () => gate, cfg)
    void withQueue('full', () => gate, cfg)
    await expect(withQueue('full', async () => 'ok', cfg)).rejects.toBeInstanceOf(QueueFullError)
    expect(queueStats('full').waiting).toBe(2)
    resetQueues()
  })

  it('истечение ожидания — QueueFullError с Retry-After', async () => {
    const gate = new Promise(() => undefined)
    const cfg = { maxConcurrent: 1, maxWaiting: 4, maxWaitMs: 120 }
    void withQueue('timeout', () => gate, cfg)
    const started = Date.now()
    await expect(withQueue('timeout', async () => 'ok', cfg)).rejects.toMatchObject({ retryAfterSec: expect.any(Number) })
    expect(Date.now() - started).toBeGreaterThanOrEqual(100) // ждало ~120 мс, не мгновенный отказ
    resetQueues()
  })

  it('queueConfig: дефолты и перекрытие', () => {
    expect(queueConfig('download').maxConcurrent).toBe(2)
    expect(queueConfig('build').maxConcurrent).toBe(1)
    expect(queueConfig('download', { maxConcurrent: 5 }).maxConcurrent).toBe(5)
  })
})

describe('троттлинг канала (token bucket)', () => {
  beforeEach(() => { resetGlobalBandwidth() })

  it('без ограничения take проходит мгновенно', async () => {
    const bw = new Bandwidth(0)
    const t0 = Date.now()
    await bw.take(10_000_000)
    expect(Date.now() - t0).toBeLessThan(100)
  })

  it('лимит 1000 Б/с при ведре 1024 Б: 3000 байт ≈ 2–3 с (не мгновенно)', async () => {
    const bw = new Bandwidth(1000, 1, 1024) // явный burst 1024 Б
    const t0 = Date.now()
    await bw.take(3000)
    const dt = Date.now() - t0
    expect(dt).toBeGreaterThanOrEqual(1000) // ~2 с дефицита на 1000 Б/с
    expect(dt).toBeLessThan(10_000)
  })

  it('запрос больше ёмкости ведра не дедлочится (частями)', async () => {
    const bw = new Bandwidth(20_000, 1, 4096)
    const t0 = Date.now()
    await bw.take(100_000) // 25 ведер по 4096
    const dt = Date.now() - t0
    expect(dt).toBeGreaterThanOrEqual(1000) // ~96 КБ дефицита / 20 КБ/с ≈ 4.8 с
  })

  it('throttledStream при лимите реально замедляет поток', async () => {
    const src = Buffer.alloc(64 * 1024, 7)
    const bw = new Bandwidth(16_384, 1, 4096) // 16 КБ/с, ведро 4 КБ
    const t0 = Date.now()
    const stream = throttledStream(src, bw, 16 * 1024)
    const reader = stream.getReader()
    let received = Buffer.alloc(0)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received = Buffer.concat([received, value])
    }
    const dt = Date.now() - t0
    expect(received.length).toBe(64 * 1024)
    // 64 КБ за 4 чанка по 16 КБ: в каждом чанке 12 КБ дефицита → ~0.75 с/чанк ≈ 2.3 с
    expect(dt).toBeGreaterThanOrEqual(1500)
    expect(dt).toBeLessThan(15_000)
  })

  it('globalDownloadBandwidth пересоздаётся при смене лимита', () => {
    const a = globalDownloadBandwidth(64)
    const b = globalDownloadBandwidth(64)
    const c = globalDownloadBandwidth(128)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })

  it('throttledStream отдаёт весь буфер чанками', async () => {
    const src = Buffer.alloc(300_000, 7)
    const stream = throttledStream(src, null, 64 * 1024)
    const reader = (stream as ReadableStream<Uint8Array>).getReader()
    let received = Buffer.alloc(0)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received = Buffer.concat([received, value])
    }
    expect(received.length).toBe(300_000)
    expect(received[299_999]).toBe(7)
  })
})

describe('редакции и guard-утилиты', () => {
  it('edition: дефолт community, enterprise по env', () => {
    const saved = process.env.NDR_EDITION
    process.env.NDR_EDITION = 'community'
    expect(edition()).toBe('community')
    expect(multiUserEnabled()).toBe(false)
    process.env.NDR_EDITION = 'enterprise'
    expect(edition()).toBe('enterprise')
    expect(multiUserEnabled()).toBe(true)
    process.env.NDR_EDITION = saved
  })

  it('sanitizeSettings: секреты вырезаются у не-админа', () => {
    const settings = { serveToken: 'K', oinkcode: 'OC', abusechAuthKey: 'AK', clearndrExportToken: 'TK', buildFormat: 'file' }
    expect(sanitizeSettings(settings, 'admin')).toEqual(settings)
    const userView = sanitizeSettings(settings, 'user')
    expect(userView.buildFormat).toBe('file')
    expect(userView.serveToken).toBeUndefined()
    expect(userView.oinkcode).toBeUndefined()
    expect(userView.abusechAuthKey).toBeUndefined()
    expect(userView.clearndrExportToken).toBeUndefined()
  })

  it('sameOriginOk: GET всегда ок; cross-site POST с Sec-Fetch-Site — отказ; без заголовков (curl/scirius) — пропуск', () => {
    const mk = (method: string, headers: Record<string, string>) => ({ method, headers: new Headers(headers) } as unknown as Request)
    expect(sameOriginOk(mk('GET', { 'sec-fetch-site': 'cross-site' }))).toBe(true)
    expect(sameOriginOk(mk('POST', { 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(sameOriginOk(mk('POST', { 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(sameOriginOk(mk('POST', {}))).toBe(true)
    expect(sameOriginOk(mk('POST', { origin: 'https://evil.example', host: 'hub.local' }))).toBe(false)
    expect(sameOriginOk(mk('POST', { origin: 'https://hub.local', host: 'hub.local' }))).toBe(true)
  })
})
