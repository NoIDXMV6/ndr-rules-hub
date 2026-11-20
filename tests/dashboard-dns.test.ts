import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'

const execFileP = promisify(execFile)

// DNS-фильтрация на дашборде и токены в разделе «Аккаунт» (v1.31.0):
//   GET /api/dashboard — блок dns для администратора (агрегаты источников,
//                        доменов, категорий, последняя сборка) и null для
//                        пользователя Enterprise (карточки «Обзора» и плашки
//                        шапки строятся ровно на этом контракте);
//   GET/POST /api/tokens — токены со scope: пользователь видит только СВОИ,
//                        администратор — все с владельцами; scope домены/оба
//                        списка нормализуется при создании (карточка «Токены
//                        и доступ» переехала в «Аккаунт», контракт API прежний).

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let dashboard: typeof import('@/app/api/dashboard/route')
let tokensRoute: typeof import('@/app/api/tokens/route')
let session: typeof import('@/lib/security/session')

let adminCookie: string
let userCookie: string
let adminUserId: string
let userUserId: string

function req(url: string, cookie: string, init?: { method?: string; body?: Record<string, unknown> }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', cookie },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  }) as NextRequest
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-dashboard-dns-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  dashboard = await import('@/app/api/dashboard/route')
  tokensRoute = await import('@/app/api/tokens/route')
  session = await import('@/lib/security/session')

  const mk = async (email: string, role: 'admin' | 'user') =>
    db.user.create({
      data: {
        email,
        displayName: email.split('@')[0],
        passwordHash: 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88),
        role,
        status: 'active',
        verifiedAt: new Date(),
      },
      select: { id: true },
    })
  adminUserId = (await mk('dns-admin@test.local', 'admin')).id
  userUserId = (await mk('dns-user@test.local', 'user')).id
  adminCookie = `${session.SESSION_COOKIE}=${(await session.createSession(adminUserId, '10.7.0.1', 'vitest')).token}`
  userCookie = `${session.SESSION_COOKIE}=${(await session.createSession(userUserId, '10.7.0.2', 'vitest')).token}`

  // DNS-данные: включённый источник OK + выключенный + записи + категории + сборка
  const enabled = await db.domainSource.create({
    data: { name: 'test-blocklist', url: 'http://x/bl.txt', enabled: true, status: 'ok', priority: 5, purpose: 'block' },
  })
  await db.domainSource.create({
    data: { name: 'test-blocklist-off', url: 'http://x/bl2.txt', enabled: false, status: 'never', priority: 6, purpose: 'block' },
  })
  await db.domainRecord.create({ data: { sourceId: enabled.id, domain: 'ads.example.com', mode: 'block' } })
  await db.domainRecord.create({ data: { sourceId: enabled.id, domain: 'tracker.example.net', mode: 'block', categories: 'ifaro:1:Phishing' } })
  await db.domainRecord.create({ data: { sourceId: enabled.id, domain: 'ok.example.org', mode: 'allow' } })
  await db.domainCategory.create({ data: { name: 'ads' } })
  await db.domainCategory.create({ data: { name: 'ifaro:1:Phishing' } })
  await db.domainBuild.create({
    data: {
      totalDomains: 2,
      statsJson: JSON.stringify({ duplicateByDomain: 1 }),
      fileName: 'blocked-domains.txt',
      filePath: `${work}/blocked-domains.txt`,
      sha256: 'a'.repeat(64),
      sizeBytes: 32,
      source: 'manual',
    },
  })
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('GET /api/dashboard: блок dns', () => {
  it('администратору: агрегаты источников, доменов, категорий и последняя сборка', async () => {
    const res = await dashboard.GET(req('http://hub.local/api/dashboard', adminCookie))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.dns).not.toBeNull()
    // агрегаты сверяем с БД: ensureDnsSeed докатывает каталог списков, поэтому
    // точные числа зависят от содержимого базы, а ЛОГИКА агрегации — нет
    expect(j.dns.sources.total).toBe(await db.domainSource.count({ where: { deletedAt: null } }))
    expect(j.dns.sources.enabled).toBe(await db.domainSource.count({ where: { deletedAt: null, enabled: true } }))
    expect(j.dns.sources.ok).toBe(await db.domainSource.count({ where: { deletedAt: null, enabled: true, status: 'ok' } }))
    expect(j.dns.sources.error).toBe(await db.domainSource.count({ where: { deletedAt: null, enabled: true, status: 'error' } }))
    // сеяный включённый источник со статусом ok учтён в агрегате ok
    expect(j.dns.sources.ok).toBeGreaterThanOrEqual(1)
    expect(j.dns.domains).toBe(await db.domainRecord.count())
    expect(j.dns.domains).toBeGreaterThanOrEqual(3)
    expect(j.dns.categories).toBe(await db.domainCategory.count())
    expect(j.dns.lastBuild).not.toBeNull()
    expect(j.dns.lastBuild.totalDomains).toBe(2)
    expect(j.dns.lastBuild.fileName).toBe('blocked-domains.txt')
    expect(j.dns.lastBuild.sha256).toBe('a'.repeat(64))
    // прежние блоки дашборда на месте (контракт «Обзора»)
    expect(j.rules).toBeDefined()
    expect(Array.isArray(j.sources.list)).toBe(true)
  })

  it('пользователю Enterprise: dns === null (данные уровня системы не покидают админ-контур)', async () => {
    const res = await dashboard.GET(req('http://hub.local/api/dashboard', userCookie))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.dns).toBeNull()
  })
})

describe('GET/POST /api/tokens: свои / все + scope', () => {
  it('POST создаёт токен с нормализованным scope=domains', async () => {
    const res = await tokensRoute.POST(req('http://hub.local/api/tokens', userCookie, { method: 'POST', body: { name: 'dns-filter', ttlDays: 30, scope: 'domains' } }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.token.scope).toBe('domains')
    expect(j.token.token).toMatch(/^ndrt_/)
    const row = await db.downloadToken.findFirst({ where: { userId: userUserId, name: 'dns-filter' } })
    expect(row?.scope).toBe('domains')
    expect(row?.expiresAt).not.toBeNull()
  })

  it('GET пользователь видит только СВОИ токены, администратор — все с владельцами', async () => {
    // токен администратора — user его видеть не должен
    await tokensRoute.POST(req('http://hub.local/api/tokens', adminCookie, { method: 'POST', body: { name: 'admin-node', ttlDays: 0, scope: 'both' } }))

    const asUser = await tokensRoute.GET(req('http://hub.local/api/tokens', userCookie))
    expect(asUser.status).toBe(200)
    const ju = await asUser.json()
    expect(ju.tokens.length).toBe(1)
    expect(ju.tokens[0].name).toBe('dns-filter')
    expect(ju.tokens[0].own).toBe(true)

    const asAdmin = await tokensRoute.GET(req('http://hub.local/api/tokens', adminCookie))
    expect(asAdmin.status).toBe(200)
    const ja = await asAdmin.json()
    expect(ja.tokens.length).toBe(2)
    const names = ja.tokens.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual(['admin-node', 'dns-filter'])
    for (const t of ja.tokens) {
      expect(t.owner).toContain('@test.local')
      expect(typeof t.ownerName).toBe('string')
    }
  })

  it('без сессии — 401 (Enterprise: раздел «Аккаунт» только для вошедших)', async () => {
    expect((await tokensRoute.GET(req('http://hub.local/api/tokens', ''))).status).toBe(401)
    expect((await tokensRoute.POST(req('http://hub.local/api/tokens', '', { method: 'POST', body: { name: 'x' } }))).status).toBe(401)
  })
})
