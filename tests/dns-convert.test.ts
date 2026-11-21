// Тесты конвертации строк-не-доменов DNS-источников в правила Suricata
// (dns-convert.ts): классификация IP/CIDR/URL/regex, генерация правил,
// SID-блоки без перекрытий, авто-источник «DNS-конвертация: …».
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)
const ROOT = path.resolve(__dirname, '..')

let dnsConvert: typeof import('@/lib/engine/dns-convert')
let db: import('@prisma/client').PrismaClient

describe('dns-convert: classifyHostlistOther', () => { // до beforeAll: чистые функции из динамического импорта ниже

  it('распознаёт IP, CIDR, URL и regex', () => {
    expect(dnsConvert.classifyHostlistOther('93.184.216.34')).toBe('ip')
    expect(dnsConvert.classifyHostlistOther('185.100.85.25')).toBe('ip')
    expect(dnsConvert.classifyHostlistOther('185.100.85.0/24')).toBe('cidr')
    expect(dnsConvert.classifyHostlistOther('http://bad.example.com/path?q=1')).toBe('url')
    expect(dnsConvert.classifyHostlistOther('bad.example.com/login')).toBe('url')
    expect(dnsConvert.classifyHostlistOther('^https?://[a-z0-9-]+\\.phish\\.example')).toBe('regex')
    expect(dnsConvert.classifyHostlistOther(null as unknown as string)).toBe(null)
  })
  it('мусор и приватные адреса — null', () => {
    expect(dnsConvert.classifyHostlistOther('не домен и не ip')).toBe(null)
    expect(dnsConvert.classifyHostlistOther('10.0.0.1')).toBe(null) // приватный — правил не даёт
    expect(dnsConvert.classifyHostlistOther('192.168.1.0/24')).toBe(null)
    expect(dnsConvert.classifyHostlistOther('example.com')).toBe(null) // домен — не our case (уже разобран)
    expect(dnsConvert.classifyHostlistOther('')).toBe(null)
  })
})

describe('dns-convert: generateHostlistRules', () => {
  it('IP-чанкование: 600 адресов → 2 правила по 500, metadata dns-convert', () => {
    const ips = Array.from({ length: 600 }, (_, i) => (i < 256 ? `203.0.113.${i}` : `203.0.114.${i - 256}`))
    const rules = dnsConvert.generateHostlistRules('ip', ips, 1_900_000)
    expect(rules.length).toBe(2)
    expect(rules[0].sid).toBe(1_900_000)
    expect(rules[1].sid).toBe(1_900_001)
    expect(rules[0].raw).toContain('metadata:ruleset dns-convert')
    expect(rules[0].raw).toContain('msg:"DNS-LIST known unwanted IP/CIDR')
    expect(rules[0].raw).toContain('drop ip')
  })
  it('URL → HTTP-правила host+uri', () => {
    const rules = dnsConvert.generateHostlistRules('url', ['http://bad.example.com/login'], 1_900_100)
    expect(rules.length).toBe(1)
    expect(rules[0].raw).toContain('http.host; content:"bad.example.com"')
    expect(rules[0].raw).toContain('http.uri; content:"/login"')
    expect(rules[0].raw).toContain('metadata:ruleset dns-convert')
  })
  it('regex → pcre-правила на http.uri.raw', () => {
    const rules = dnsConvert.generateHostlistRules('regex', ['^https?://[a-z0-9-]+\\.phish\\.example'], 1_900_200)
    expect(rules.length).toBe(1)
    expect(rules[0].raw).toContain('http.uri.raw; pcre:"/')
    expect(rules[0].raw).toContain('metadata:ruleset dns-convert')
  })
})

// ── convertHostlistOthers: файл + источник-конвертер (БД) ────────────────────

let work: string

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-dns-convert-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work // файлы правил — во временный каталог
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  dnsConvert = await import('@/lib/engine/dns-convert')
  const dbmod = await import('@/lib/db')
  db = dbmod.db
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('dns-convert: convertHostlistOthers', () => {
  it('создаёт выключенный источник-конвертер и .rules-файл; повторный прогон переиспользует SID-блок', async () => {
    await db.source.deleteMany({ where: { name: { startsWith: 'DNS-конвертация:' } } })
    const src = await db.source.create({ data: { name: 'Тестовый DNS-источник', category: 'mixed', kind: 'url', format: 'plain', enabled: true } })
    const res = await dnsConvert.convertHostlistOthers({ id: src.id, name: src.name }, [
      '203.0.113.5',
      'http://bad.example.com/x',
      '^https?://[a-z]+\\.evil\\.example',
      'мусорная строка',
    ])
    expect(res).not.toBeNull()
    expect(res!.counts.ip).toBe(1)
    expect(res!.counts.url).toBe(1)
    expect(res!.counts.regex).toBe(1)
    expect(res!.rules).toBe(3)
    expect(res!.sourceName).toBe(`DNS-конвертация: ${src.name}`)

    // SID-блок: выделение из Setting, без перекрытий
    expect(res!.sidStart).toBeGreaterThanOrEqual(1_900_000)

    // источник создан выключенным (admin включает осознанно) с закреплённым блоком
    const conv = await db.source.findUnique({ where: { name: `DNS-конвертация: ${src.name}` } })
    expect(conv).not.toBeNull()
    expect(conv!.enabled).toBe(false)
    expect(conv!.kind).toBe('local')
    expect(conv!.format).toBe('suricata')
    const extra = JSON.parse(conv!.extraJson ?? '{}') as { dnsSourceId?: string; sidStart?: number }
    expect(extra.dnsSourceId).toBe(src.id)
    expect(extra.sidStart).toBe(res!.sidStart)

    // файл существует и содержит правила с правильными SID
    const file = conv!.url ?? ''
    const body = await fs.readFile(file, 'utf8')
    expect(body).toContain(`SID-блок / SID block: ${res!.sidStart}+`)
    expect(body).toContain(`sid:${res!.sidStart};`)

    // повторный прогон: тот же SID-блок (закреплён за DNS-источником), источник не дублируется
    const res2 = await dnsConvert.convertHostlistOthers({ id: src.id, name: src.name }, ['203.0.113.9'])
    expect(res2).not.toBeNull()
    expect(res2!.sidStart).toBe(res!.sidStart)
    const all = await db.source.findMany({ where: { extraJson: { contains: `"dnsSourceId":"${src.id}"` } } })
    expect(all.length).toBe(1)

    // без строк-не-доменов — ничего не делает
    expect(await dnsConvert.convertHostlistOthers({ id: 'no-such-source', name: 'пустой' }, ['мусор', 'ещё мусор'])).toBeNull()
    // чистим за собой (sid-счётчик не сбрасываем — тест идемпотентен в рамках каталога)
    await db.source.delete({ where: { id: conv!.id } })
    await db.source.delete({ where: { id: src.id } })
  })

  it('allocateHostlistSidBlock выдаёт непересекающиеся блоки по 40 000', async () => {
    const a = await dnsConvert.allocateHostlistSidBlock()
    const b = await dnsConvert.allocateHostlistSidBlock()
    expect(b).toBe(a + 40_000)
    expect(a).toBeGreaterThanOrEqual(1_900_000)
  })
})
