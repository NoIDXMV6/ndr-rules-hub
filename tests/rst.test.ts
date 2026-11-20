import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Интеграция RST Cloud (api.rstcloud.net):
//  • parseRstFeedCsv — разбор CSV-фидов (ip/domain/url/hash): колонка индикатора,
//    фильтры fp_alarm/minScore, предохранитель maxValues, подсчёт пропусков;
//  • convertHashList — SHA-256 → правила filesha256 (дедуп, предохранитель);
//  • rstIocVerdict — человекочитаемый вердикт IoC Lookup;
//  • serveDomainList — БЕЗ ТОКЕНА отдача списка доменов запрещена: персональный
//    токен (scope domains/both) или сессия кабинета; легаси-ключ dnsServeToken
//    (сущность удалена) доступа больше не даёт.
//
// Клиент REST API (rstCheckKey/rstIocLookup/…) тестируется через мок global.fetch.

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let dl: typeof import('@/lib/security/download-token')
let rate: typeof import('@/lib/security/ratelimit')
let rst: typeof import('@/lib/engine/rst')
let convert: typeof import('@/lib/engine/convert')
let dnsServe: typeof import('@/lib/engine/dns-serve')

const RST_CSV = [
  '"domain","ports","fseen","lseen","collect","src_name","score_total","fp_alarm","tags_str"',
  '"evil.example.com","[-1]","1","2","3","[\'src1\']","42","false","[\'phishing\']"',
  '"sinkholed.example.net","[-1]","1","2","3","[\'src1\']","16","true","[\'phishing\']"',
  '"low.example.org","[-1]","1","2","3","[\'src2\']","5","false","[]"',
  '"bad value with spaces","[-1]","1","2","3","[]","10","false","[]"',
  '"nota-domain","[-1]","1","2","3","[]","10","false","[]"',
].join('\n')

const RST_IP_CSV = [
  '"ip_v4","ip_num","ports","score_total","fp_alarm","tags_str"',
  '"185.222.5.100","3109917860","[-1]","60","false","[\'c2\']"',
  '"1.2.3.4","16909060","[-1]","10","false","[]"',
  '"999.999.1.1","0","[-1]","10","false","[]"',
].join('\n')

async function addDomainBuild(): Promise<void> {
  const file = path.join(work, 'blocked-domains.txt')
  await fs.writeFile(file, 'evil.example.com\nmalware.test\n')
  await db.domainBuild.create({
    data: {
      createdAt: new Date(),
      totalDomains: 2,
      statsJson: '{}',
      fileName: 'blocked-domains.txt',
      filePath: file,
      sha256: 'test-sha',
      sizeBytes: 25,
      source: 'manual',
    },
  })
}

let adminUser: { id: string }

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'rst-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  dl = await import('@/lib/security/download-token')
  rate = await import('@/lib/security/ratelimit')
  rst = await import('@/lib/engine/rst')
  convert = await import('@/lib/engine/convert')
  dnsServe = await import('@/lib/engine/dns-serve')

  adminUser = await db.user.create({
    data: {
      email: 'admin@test.local',
      displayName: 'Админ',
      passwordHash: 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88),
      role: 'admin',
      status: 'active',
      verifiedAt: new Date(),
    },
    select: { id: true },
  })
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('rst.ts: разбор CSV-фидов', () => {
  it('parseCsvLine разбирает кавычки, запятые внутри полей и двойные кавычки', () => {
    expect(rst.parseCsvLine('"a","b, c","d""e"')).toEqual(['a', 'b, c', 'd"e'])
    expect(rst.parseCsvLine('plain,line')).toEqual(['plain', 'line'])
    expect(rst.parseCsvLine('')).toEqual([''])
  })

  it('parseRstFeedCsv: колонка домена, некорректные строки считаются отдельно', () => {
    const p = rst.parseRstFeedCsv(RST_CSV, 'domain')
    expect(p.values).toEqual(['evil.example.com', 'sinkholed.example.net', 'low.example.org'])
    expect(p.skippedInvalid).toBe(2)
    expect(p.skippedFpAlarm).toBe(0)
    expect(p.total).toBe(5)
  })

  it('parseRstFeedCsv: skipFpAlarm пропускает сикхоулы, minScore — низкие баллы', () => {
    const p = rst.parseRstFeedCsv(RST_CSV, 'domain', { skipFpAlarm: true, minScore: 20 })
    expect(p.values).toEqual(['evil.example.com'])
    expect(p.skippedFpAlarm).toBe(1)
    expect(p.skippedScore).toBe(1) // low.example.org (score 5 < 20)
    expect(p.skippedInvalid).toBe(2)
  })

  it('parseRstFeedCsv: колонка ip_v4, некорректный IP отбрасывается, maxValues режет список', () => {
    const p = rst.parseRstFeedCsv(RST_IP_CSV, 'ip')
    expect(p.values).toEqual(['185.222.5.100', '1.2.3.4'])
    expect(p.skippedInvalid).toBe(1)
    const capped = rst.parseRstFeedCsv(RST_IP_CSV, 'ip', { maxValues: 1 })
    expect(capped.values).toEqual(['185.222.5.100'])
  })

  it('isValidRstValue: валидация по типам (ip/domain/url/hash)', () => {
    expect(rst.isValidRstValue('ip', '1.2.3.4')).toBe(true)
    expect(rst.isValidRstValue('ip', '999.1.1.1')).toBe(false)
    expect(rst.isValidRstValue('domain', 'evil.example.com')).toBe(true)
    expect(rst.isValidRstValue('domain', 'nota-domain')).toBe(false)
    expect(rst.isValidRstValue('url', 'http://evil.example.com/payload.exe')).toBe(true)
    expect(rst.isValidRstValue('hash', 'a'.repeat(64))).toBe(true)
    expect(rst.isValidRstValue('hash', 'a'.repeat(63))).toBe(false)
  })

  it('maybeGunzip распаковывает gzip-тело, не-gzip возвращает как есть', () => {
    const { gzipSync } = require('zlib') as typeof import('zlib')
    const gz = gzipSync(Buffer.from('hello rst'))
    expect(rst.isGzipBody(gz)).toBe(true)
    expect(rst.maybeGunzip(gz).toString()).toBe('hello rst')
    const plain = Buffer.from('plain')
    expect(rst.maybeGunzip(plain).equals(plain)).toBe(true)
  })

  it('rstIocVerdict: балл/теги/fp_alarm', () => {
    const v = rst.rstIocVerdict({ score: { total: '16' }, tags: { str: ['phishing'] }, fp: { alarm: 'false' } })
    expect(v.score).toBe(16)
    expect(v.malicious).toBe(true)
    expect(v.tags).toEqual(['phishing'])
    const fp = rst.rstIocVerdict({ score: { total: '16' }, tags: { str: ['phishing'] }, fp: { alarm: 'true' } })
    expect(fp.malicious).toBe(false)
    const zero = rst.rstIocVerdict({})
    expect(zero.score).toBe(0)
    expect(zero.malicious).toBe(false)
  })
})

describe('convertHashList: SHA-256 → правила filesha256', () => {
  it('создаёт правила filesha256 с дедупом и предохранителем', () => {
    const a = 'a'.repeat(64)
    const text = [a, a.toUpperCase(), '# comment', 'b'.repeat(64), 'short', 'c'.repeat(64)].join('\n')
    const all = convert.convertHashList(text, { sidStart: 1_800_000 })
    // дедуп: 'A'*64 — тот же хэш в верхнем регистре → отдельного правила нет
    expect(all.map((r) => r.sid)).toEqual([1_800_000, 1_800_001, 1_800_002])
    expect(all[0].raw).toContain(`filesha256:"${a}"`)
    expect(all[0].raw).toContain('msg:')
    expect(all.some((r) => r.raw.includes('b'.repeat(64)))).toBe(true)
    expect(all.some((r) => r.raw.includes('c'.repeat(64)))).toBe(true)
    expect(all.some((r) => r.raw.includes('short'))).toBe(false)
    // предохранитель maxRules
    const capped = convert.convertHashList(text, { sidStart: 1_800_000, maxRules: 2 })
    expect(capped.length).toBe(2)
    expect(capped[1].sid).toBe(1_800_001)
  })
})

describe('rstCheckKey / rstIocLookup: REST-клиент (мок fetch)', () => {
  it('без ключа — ошибка с подсказкой, запрос не уходит', async () => {
    const calls: string[] = []
    const orig = global.fetch
    global.fetch = (async (u: string | URL) => { calls.push(String(u)); throw new Error('must not be called') }) as typeof fetch
    try {
      const r = await rst.rstCheckKey('  ')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('не задан')
      expect(calls.length).toBe(0)
    } finally {
      global.fetch = orig
    }
  })

  it('rstCheckKey разбирает auth/check (валидность, entitlements, квота)', async () => {
    const orig = global.fetch
    let seenHeaders: Record<string, string> | null = null
    global.fetch = (async (_u: string | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ check: { name: 'CheckApiKey', status: 'valid' }, entitlements: ['RST Threat Feed', 'RST IoC Lookup'], quota: { used: 3, limit: 1000, remaining: 997, period: 'DAY' } }), { status: 200 })
    }) as typeof fetch
    try {
      const r = await rst.rstCheckKey('KEY123')
      expect(r.ok).toBe(true)
      expect(r.valid).toBe(true)
      expect(r.entitlements).toContain('RST Threat Feed')
      expect(r.quota?.remaining).toBe(997)
      expect(seenHeaders!['X-Api-Key']).toBe('KEY123')
    } finally {
      global.fetch = orig
    }
  })

  it('rstIocLookup: неверный ключ → HTTP 403 превращается в ошибку с сообщением сервера', async () => {
    const orig = global.fetch
    global.fetch = (async () => new Response('{"message":"Forbidden"}', { status: 403 })) as typeof fetch
    try {
      const r = await rst.rstIocLookup('evil.example.com', 'WRONG')
      expect(r.ok).toBe(false)
      expect(r.status).toBe(403)
      expect(r.error).toContain('Forbidden')
    } finally {
      global.fetch = orig
    }
  })
})

describe('serveDomainList: без токена отдача запрещена', () => {
  it('анонимный запрос (без токена и сессии) — 403 с подсказкой создать токен', async () => {
    rate.resetAllRates()
    await addDomainBuild()
    const res = await dnsServe.serveDomainList({ ip: '10.2.0.1' })
    expect(res.status).toBe(403)
    expect(String(res.body)).toContain('отдача списка доменов запрещена')
    expect(String(res.body)).toContain('Аккаунт')
  })

  it('легаси-ключ dnsServeToken (сущность удалена) доступа больше не даёт', async () => {
    rate.resetAllRates()
    await db.setting.upsert({ where: { key: 'dnsServeToken' }, create: { key: 'dnsServeToken', value: 'LEGACY', updatedAt: new Date() }, update: { value: 'LEGACY' } })
    const res = await dnsServe.serveDomainList({ token: 'LEGACY', ip: '10.2.0.2' })
    expect(res.status).toBe(403)
    expect(String(res.body)).toContain('отдача списка доменов запрещена')
    await db.setting.deleteMany({ where: { key: 'dnsServeToken' } })
  })

  it('токен scope rules — 403 «только для правил»', async () => {
    rate.resetAllRates()
    const tok = (await dl.createDownloadToken(adminUser.id, 'rules-only', null, 'rules')).token
    const res = await dnsServe.serveDomainList({ token: tok, ip: '10.2.0.3' })
    expect(res.status).toBe(403)
    expect(String(res.body)).toContain('только для правил')
  })

  it('токен scope domains отдаёт список, счётчики токена растут', async () => {
    rate.resetAllRates()
    const tok = (await dl.createDownloadToken(adminUser.id, 'domains', null, 'domains')).token
    const res = await dnsServe.serveDomainList({ token: tok, ip: '10.2.0.4' })
    expect(res.status).toBe(200)
    expect((res.body as Buffer).toString()).toContain('evil.example.com')
    expect(res.fileName).toBe('blocked-domains.txt')
    const row = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(tok) } })
    expect(row!.downloadCount).toBe(1)
  })

  it('токен scope both отдаёт список', async () => {
    rate.resetAllRates()
    const tok = (await dl.createDownloadToken(adminUser.id, 'both', null, 'both')).token
    const res = await dnsServe.serveDomainList({ token: tok, ip: '10.2.0.5' })
    expect(res.status).toBe(200)
  })

  it('сессия кабинета отдаёт список без токена', async () => {
    rate.resetAllRates()
    const res = await dnsServe.serveDomainList({ ip: '10.2.0.6', sessionUserId: adminUser.id })
    expect(res.status).toBe(200)
  })

  it('перебор неверных токенов → 429 (rate-лимит)', async () => {
    rate.resetAllRates()
    const ip = '10.2.0.99'
    for (let i = 0; i < 10; i++) {
      const res = await dnsServe.serveDomainList({ token: `ndrt_wrong${i}`, ip })
      expect(res.status).toBe(403)
    }
    const blocked = await dnsServe.serveDomainList({ token: 'ndrt_wrong-more', ip })
    expect(blocked.status).toBe(429)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
  })
})

describe('seed: настройка rstApiKey, dnsServeToken удалён', () => {
  it('DEFAULT_SETTINGS содержит rstApiKey и не содержит dnsServeToken', async () => {
    const seed = await import('@/lib/engine/seed')
    expect(Object.keys(seed.DEFAULT_SETTINGS)).toContain('rstApiKey')
    expect(Object.keys(seed.DEFAULT_SETTINGS)).not.toContain('dnsServeToken')
    const dnsDefaults = Object.keys(seed.DNS_CATALOG)
    expect(dnsDefaults.length).toBeGreaterThan(0)
    // DNS-каталог содержит источник RST Cloud
    expect(seed.DNS_CATALOG.some((s) => s.name.includes('RST Cloud'))).toBe(true)
    // SEED_SOURCES содержит три NDR-источника RST Cloud
    const rstSources = seed.SEED_SOURCES.filter((s) => s.name.includes('RST Cloud'))
    expect(rstSources.length).toBe(3)
    for (const s of rstSources) {
      expect(s.authType).toBe('rstkey')
      expect(s.enabled).toBe(false)
      expect(s.adminOnly).toBe(true)
    }
    // DNS-источник RST Cloud: rst-csv + rstkey + выключен
    const dnsRst = seed.DNS_CATALOG.find((s) => s.name.includes('RST Cloud'))!
    expect(dnsRst.format).toBe('rst-csv')
    expect(dnsRst.authType).toBe('rstkey')
    expect(dnsRst.enabled).toBe(false)
  })

  it('SECRET_SETTING_KEYS содержит rstApiKey и не содержит dnsServeToken', async () => {
    const guard = await import('@/lib/security/guard')
    expect(guard.SECRET_SETTING_KEYS).toContain('rstApiKey')
    expect(guard.SECRET_SETTING_KEYS).not.toContain('dnsServeToken')
  })
})
