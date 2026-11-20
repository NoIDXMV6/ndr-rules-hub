import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// DNS-цикл как полноценная часть расписания:
//  • dnsCycleMode — off/inline/deferred по настройкам dnsCronEnabled/dnsCronSchedule;
//  • runDnsCycle — отдельное уведомление Telegram/Gotify «DNS-списки»;
//  • listDnsExportFiles — список файлов каталога экспорта DNS.
// dns-service замокан на уровне функций fetch/build — сеть и БД не нужны.

const ROOT = path.resolve(__dirname, '..')

// ── мок dns-service: fetchAllDomainSources/buildDomainList заменяются, остальное реально ──
const fetchMock = vi.fn()
const buildMock = vi.fn()
vi.mock('@/lib/engine/dns-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/dns-service')>()
  return {
    ...actual,
    fetchAllDomainSources: (...args: unknown[]) => fetchMock(...args),
    buildDomainList: (...args: unknown[]) => buildMock(...args),
  }
})

// ── мок undici.request (транспорт Telegram/Gotify) ──────────────────────────
type ReqRec = { url: string; opts: { method?: string; headers?: Record<string, string>; body?: string } }
const reqs: ReqRec[] = []
let responder: (r: ReqRec) => { status: number; body: string } = () => ({ status: 200, body: '{"ok":true}' })

vi.mock('undici', () => {
  return {
    request: (url: string, opts: ReqRec['opts']) => {
      const rec: ReqRec = { url, opts }
      reqs.push(rec)
      const r = responder(rec)
      return {
        statusCode: r.status,
        body: { text: async () => r.body, dump: async () => undefined },
      }
    },
    ProxyAgent: class {},
    Agent: class {},
  }
})

vi.mock('fetch-socks', () => ({ socksDispatcher: () => ({}) }))

let work: string
let db: import('@prisma/client').PrismaClient
let service: typeof import('@/lib/engine/service')
let dnsSvc: typeof import('@/lib/engine/dns-service')

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value, updatedAt: new Date() }, update: { value, updatedAt: new Date() } })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-dns-cycle-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  service = await import('@/lib/engine/service')
  dnsSvc = await import('@/lib/engine/dns-service')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('dnsCycleMode: как запускать DNS-цикл', () => {
  it('выключен настройкой (dnsCronEnabled=false) — off, расписание игнорируется', () => {
    expect(service.dnsCycleMode('false', '30 4 * * *')).toBe('off')
    expect(service.dnsCycleMode('false', '')).toBe('off')
    expect(service.dnsCycleMode('false', undefined)).toBe('off')
  })

  it('корректное отдельное расписание — deferred (разнос пиков)', () => {
    expect(service.dnsCycleMode('true', '30 4 * * *')).toBe('deferred')
    expect(service.dnsCycleMode(undefined, '0 5 * * *')).toBe('deferred')
    expect(service.dnsCycleMode('true', '  30 4 * * *  ')).toBe('deferred')
  })

  it('пустое/неверное расписание — inline (вместе с основным циклом)', () => {
    expect(service.dnsCycleMode('true', '')).toBe('inline')
    expect(service.dnsCycleMode('true', undefined)).toBe('inline')
    expect(service.dnsCycleMode('true', 'каждый день')).toBe('inline')
    expect(service.dnsCycleMode('true', '99 99 * * *')).toBe('inline')
  })
})

describe('runDnsCycle: свой цикл со своим уведомлением', () => {
  it('успешный цикл: уведомление «DNS-списки» в Telegram и Gotify со строками источников и сборки', async () => {
    await setSetting('notifyTgEnabled', 'true')
    await setSetting('notifyGotifyEnabled', 'true')
    await setSetting('tgBotToken', '12345:ABC')
    await setSetting('tgChatId', '-10042')
    await setSetting('gotifyUrl', 'https://gotify.local/')
    await setSetting('gotifyToken', 'Akey123')
    await setSetting('notifyOnDns', 'true')
    fetchMock.mockResolvedValue({ ok: 3, failed: 1, total: 4 })
    buildMock.mockResolvedValue({ ok: true, total: 123456, fileName: 'blocked-domains.txt' })
    reqs.length = 0
    const r = await service.runDnsCycle('cron')
    // один источник с ошибкой → общий итог не «успех», но уведомление уходит (warn)
    expect(r.ok).toBe(false)
    expect(reqs).toHaveLength(2)
    const tg = reqs.find((x) => x.url.includes('api.telegram.org'))!
    const tgText = JSON.parse(tg.opts.body!).text as string
    expect(tgText).toContain('DNS-списки')
    expect(tgText).toContain('DNS-цикл (cron)')
    expect(tgText).toMatch(/123\s456/u) // ru-RU формат числа с неразрывным пробелом
    expect(tgText).toContain('источники: успешно 3, ошибок 1 (всего 4)')
    expect(tgText).toMatch(/сборка списка: 123\s456 доменов → blocked-domains\.txt/u)
    const go = reqs.find((x) => x.url.includes('gotify.local/message'))!
    expect(JSON.parse(go.opts.body!).title).toContain('DNS-списки')
  })

  it('notifyOnDns=false — уведомление не уходит, но цикл выполняется', async () => {
    await setSetting('notifyOnDns', 'false')
    fetchMock.mockResolvedValue({ ok: 2, failed: 0, total: 2 })
    buildMock.mockResolvedValue({ ok: true, total: 10, fileName: 'blocked-domains.txt' })
    reqs.length = 0
    const r = await service.runDnsCycle('cron')
    expect(r.ok).toBe(true)
    expect(reqs).toEqual([])
    await setSetting('notifyOnDns', 'true')
  })

  it('ошибка сборки списка: уровень error и текст ошибки в уведомлении', async () => {
    fetchMock.mockResolvedValue({ ok: 0, failed: 2, total: 2 })
    buildMock.mockResolvedValue({ ok: false, error: 'нет включённых DNS-источников' })
    reqs.length = 0
    const r = await service.runDnsCycle('cron')
    expect(r.ok).toBe(false)
    expect(reqs).toHaveLength(2)
    const tgText = JSON.parse(reqs.find((x) => x.url.includes('api.telegram.org'))!.opts.body!).text as string
    expect(tgText).toContain('Ошибка DNS-цикла')
    expect(tgText).toContain('нет включённых DNS-источников')
    expect(tgText).toContain('сборка списка: ОШИБКА')
  })

  it('fetch/build вызываются с origin цикла (cron)', async () => {
    fetchMock.mockClear()
    buildMock.mockClear()
    fetchMock.mockResolvedValue({ ok: 1, failed: 0, total: 1 })
    buildMock.mockResolvedValue({ ok: true, total: 1, fileName: 'f.txt' })
    await service.runDnsCycle('cron')
    expect(fetchMock).toHaveBeenCalledWith('cron')
    expect(buildMock).toHaveBeenCalledWith('cron')
  })
})

describe('listDnsExportFiles: файлы каталога экспорта DNS', () => {
  it('список файлов по времени изменения (свежие сверху), подкаталоги не попадают', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-dns-export-'))
    await fs.writeFile(path.join(dir, 'blocked-domains.txt'), 'a'.repeat(10))
    await new Promise((r) => setTimeout(r, 20))
    await fs.writeFile(path.join(dir, 'hosts-file.txt'), 'b'.repeat(30))
    await fs.mkdir(path.join(dir, 'nested'))
    const files = await dnsSvc.listDnsExportFiles(dir)
    expect(files.map((f) => f.name)).toEqual(['hosts-file.txt', 'blocked-domains.txt'])
    expect(files[0].size).toBe(30)
    expect(files[1].size).toBe(10)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('каталога нет — пустой список (сборка ещё не выполнялась)', async () => {
    const files = await dnsSvc.listDnsExportFiles(path.join(work, 'no-such-dir'))
    expect(files).toEqual([])
  })
})
