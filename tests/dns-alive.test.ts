// Тесты проверки живости доменов (dns-alive.ts):
//  • classifyAlive — вердикт по результатам DNS-запросов (чистая функция);
//  • probeDomain — цепочка NS → A/AAAA/CNAME с таймаутом (фейковый резолвер);
//  • скан: батчи уникальных доменов, вердикты пишутся в DomainAlive, свежие
//    записи не перепроверяются (TTL), запуск/повторный запуск/отмена.
// Модули импортируются ДИНАМИЧЕСКИ в beforeAll: DATABASE_URL и RULES_DATA_DIR
// задаются до первого обращения клиента Prisma к файлу БД.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)
const ROOT = path.resolve(__dirname, '..')

let dnsAlive: typeof import('@/lib/engine/dns-alive')
let db: import('@prisma/client').PrismaClient

// ── classifyAlive (чистая) ────────────────────────────────────────────────────

describe('dns-alive: classifyAlive', () => {
  const base = { nsErr: null, ns: 0, aErr: null, a: 0, aaaaErr: null, aaaa: 0, cnameErr: null, cname: 0 }
  it('NS есть — alive (домен делегирован)', () => {
    expect(dnsAlive.classifyAlive({ ...base, ns: 2 })).toBe('alive')
  })
  it('NS нет, но A/AAAA/CNAME отвечают — alive', () => {
    expect(dnsAlive.classifyAlive({ ...base, a: 1 })).toBe('alive')
    expect(dnsAlive.classifyAlive({ ...base, aaaa: 1 })).toBe('alive')
    expect(dnsAlive.classifyAlive({ ...base, cname: 1 })).toBe('alive')
  })
  it('все запросы NXDOMAIN — dead (неделегирован)', () => {
    expect(dnsAlive.classifyAlive({ ...base, nsErr: 'ENOTFOUND', aErr: 'ENOTFOUND', aaaaErr: 'ENOTFOUND', cnameErr: 'ENOTFOUND' })).toBe('dead')
  })
  it('SERVFAIL/таймаут — error (вердикта нет, домен остаётся в сборке)', () => {
    expect(dnsAlive.classifyAlive({ ...base, nsErr: 'ESERVFAIL', aErr: 'ENOTFOUND', aaaaErr: 'ENOTFOUND', cnameErr: 'ENOTFOUND' })).toBe('error')
    expect(dnsAlive.classifyAlive({ ...base, nsErr: 'ETIMEOUT', aErr: 'ETIMEOUT', aaaaErr: 'ENOTFOUND', cnameErr: 'ENOTFOUND' })).toBe('error')
  })
})

// ── probeDomain (фейковый резолвер) ──────────────────────────────────────────

type AliveResolver = import('@/lib/engine/dns-alive').AliveResolver

function fakeResolver(answers: Record<string, { ns?: string[]; a?: string[]; aaaa?: string[]; cname?: string[]; err?: string }>): AliveResolver {
  const q = (v?: string[], err?: string) => async () => {
    if (err) throw Object.assign(new Error(err), { code: err })
    await new Promise((r) => setTimeout(r, 1))
    return v ?? []
  }
  return {
    resolveNs: async (d: string) => q(answers[d]?.ns, answers[d]?.err)(),
    resolve4: async (d: string) => q(answers[d]?.a, answers[d]?.err)(),
    resolve6: async (d: string) => q(answers[d]?.aaaa, answers[d]?.err)(),
    resolveCname: async (d: string) => q(answers[d]?.cname, answers[d]?.err)(),
    cancel: () => undefined,
  }
}

describe('dns-alive: probeDomain', () => {
  it('делегированный домен: NS → alive', async () => {
    const r = await dnsAlive.probeDomain('ok.example', fakeResolver({ 'ok.example': { ns: ['ns1.ok.example'] } }), 1000)
    expect(r.verdict).toBe('alive')
    expect(r.ns).toBe(1)
  })
  it('NXDOMAIN по всем типам — dead, даже если NS-запрос вернул NXDOMAIN', async () => {
    const r = await dnsAlive.probeDomain('dead.example', fakeResolver({ 'dead.example': { err: 'ENOTFOUND' } }), 1000)
    expect(r.verdict).toBe('dead')
    expect(r.ns).toBe(0)
  })
  it('зона без NS, но с A-записью — alive', async () => {
    const r = await dnsAlive.probeDomain('bare.example', fakeResolver({ 'bare.example': { a: ['93.184.216.34'] } }), 1000)
    expect(r.verdict).toBe('alive')
  })
  it('SERVFAIL — error (ложные исключения хуже пропуска)', async () => {
    const r = await dnsAlive.probeDomain('srv.example', fakeResolver({ 'srv.example': { err: 'ESERVFAIL' } }), 1000)
    expect(r.verdict).toBe('error')
  })
})

// ── Скан с БД: вердикты в DomainAlive, TTL, повторный запуск, отмена ─────────

let work: string

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-dns-alive-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  dnsAlive = await import('@/lib/engine/dns-alive')
  const dbmod = await import('@/lib/db')
  db = dbmod.db
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('dns-alive: скан живости (DomainAlive)', () => {
  it('пишет вердикты в DomainAlive и считает счётчики', async () => {
    await db.domainAlive.deleteMany()
    const batches = async function * () {
      yield ['alive.example', 'dead.example', 'servfail.example']
    }
    const started = await dnsAlive.startDomainAliveScan('test', {
      batches: batches(),
      resolverFactory: () => fakeResolver({
        'alive.example': { ns: ['ns1.alive.example'] },
        'dead.example': { err: 'ENOTFOUND' },
        'servfail.example': { err: 'ESERVFAIL' },
      }),
      concurrency: 3,
      timeoutMs: 1000,
      ttlDays: 14,
    })
    expect(started).toBe(true)
    // ждём завершения (скан фоновый)
    for (let i = 0; i < 100 && dnsAlive.getDomainAliveProgress()?.active; i++) await new Promise((r) => setTimeout(r, 100))
    expect(dnsAlive.getDomainAliveProgress()?.active).toBe(false)
    const rows = await db.domainAlive.findMany()
    const byDomain = Object.fromEntries(rows.map((r) => [r.domain, r.status]))
    expect(byDomain['alive.example']).toBe('alive')
    expect(byDomain['dead.example']).toBe('dead')
    expect(byDomain['servfail.example']).toBe('error')
    const counts = await dnsAlive.domainAliveCounts()
    expect(counts).toMatchObject({ alive: 1, dead: 1, error: 1, checked: 3 })
  })

  it('свежие вердикты не перепроверяются (TTL), устаревшие — перепроверяются', async () => {
    // alive.example устарел (20 дней назад) — перепроверится и сменится на error;
    // dead.example свежий (только что) — НЕ перепроверится, вердикт останется dead
    await db.domainAlive.update({
      where: { domain: 'alive.example' },
      data: { checkedAt: new Date(Date.now() - 20 * 86_400_000) },
    })
    const batches = async function * () {
      yield ['alive.example', 'dead.example']
    }
    await dnsAlive.startDomainAliveScan('test', {
      batches: batches(),
      resolverFactory: () => fakeResolver({
        'alive.example': { err: 'ESERVFAIL' }, // перепроверка даёт error
        'dead.example': { ns: ['ns1.revived.example'] }, // если бы проверялся — оживил бы
      }),
      concurrency: 2,
      timeoutMs: 1000,
      ttlDays: 14,
    })
    for (let i = 0; i < 100 && dnsAlive.getDomainAliveProgress()?.active; i++) await new Promise((r) => setTimeout(r, 100))
    const rows = await db.domainAlive.findMany()
    const byDomain = Object.fromEntries(rows.map((r) => [r.domain, r.status]))
    expect(byDomain['alive.example']).toBe('error') // устаревший перепроверен
    expect(byDomain['dead.example']).toBe('dead') // свежий не тронут
  })

  it('повторный запуск, пока скан активен, отклоняется; отмена работает', async () => {
    // медленный резолвер, чтобы скан оставался активным
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slowResolver: AliveResolver = {
      resolveNs: async () => { await gate; return ['ns1.slow.example'] },
      resolve4: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      resolve6: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      resolveCname: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      cancel: () => undefined,
    }
    const batches = async function * () { yield ['slow.example'] }
    const first = await dnsAlive.startDomainAliveScan('test', { batches: batches(), resolverFactory: () => slowResolver, concurrency: 1, timeoutMs: 5000 })
    expect(first).toBe(true)
    const second = await dnsAlive.startDomainAliveScan('test', { batches: batches(), resolverFactory: () => slowResolver })
    expect(second).toBe(false) // уже идёт
    // ждём, пока скан дойдёт до проверки (stage 'probe') — отмена ДО партии просто
    // пропустила бы её, и вердиктов не было бы вовсе
    for (let i = 0; i < 100 && dnsAlive.getDomainAliveProgress()?.stage !== 'probe'; i++) await new Promise((r) => setTimeout(r, 50))
    expect(dnsAlive.cancelDomainAliveScan()).toBe(true)
    release()
    for (let i = 0; i < 100 && dnsAlive.getDomainAliveProgress()?.active; i++) await new Promise((r) => setTimeout(r, 100))
    expect(dnsAlive.getDomainAliveProgress()?.active).toBe(false)
    // вердикт записан (отмена не теряет результат текущей партии)
    const row = await db.domainAlive.findUnique({ where: { domain: 'slow.example' } })
    expect(row?.status).toBe('alive')
  })

  it('сборка с deadDomains: неделегированные домены не попадают в итог', async () => {
    const { mergeDomainSources } = await import('@/lib/engine/dns')
    const sources = [
      { id: 'a', name: 'A', purpose: 'block' as const, priority: 10, category: 'mixed', enabled: true, entries: [['dead.example', 'block'] as [string, 'block' | 'allow'], ['live.example', 'block'] as [string, 'block' | 'allow']] },
    ]
    const r = await mergeDomainSources(sources, { deadDomains: new Set(['dead.example']) })
    expect(r.domains).toEqual(['live.example'])
    expect(r.stats.deadRemoved).toBe(1)
    expect(r.stats.perSource['A'].droppedDead).toBe(1)
  })
})
