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

// ── Живучесть скана: чекпоинт, промежуточный сброс, автовозобновление ────────

function mkCkpt(patch: Partial<import('@/lib/engine/dns-alive').AliveCheckpoint> = {}): import('@/lib/engine/dns-alive').AliveCheckpoint {
  return {
    active: true, origin: 'manual', startedAt: new Date().toISOString(),
    processed: 0, alive: 0, dead: 0, errors: 0, skippedFresh: 0,
    finishedAt: null, updatedAt: new Date().toISOString(), ...patch,
  }
}

async function setSettingRaw(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function waitScanDone(maxMs = 15_000): Promise<void> {
  for (let i = 0; i < maxMs / 100 && dnsAlive.getDomainAliveProgress()?.active; i++) await new Promise((r) => setTimeout(r, 100))
}

describe('dns-alive: живучесть скана (чекпоинт, сброс, автовозобновление)', () => {
  it('чекпоинт: активен во время скана, погашен после завершения', async () => {
    await db.domainAlive.deleteMany({ where: { domain: { startsWith: 'ck.example' } } })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const gated: AliveResolver = {
      resolveNs: async () => { await gate; return ['ns1.ck.example'] },
      resolve4: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      resolve6: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      resolveCname: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      cancel: () => undefined,
    }
    const batches = async function * () { yield ['ck.example'] }
    const ok = await dnsAlive.startDomainAliveScan('test', {
      batches: batches(), resolverFactory: () => gated,
      concurrency: 1, timeoutMs: 10_000,
    })
    expect(ok).toBe(true)
    // чекпоинт активен, пока скан идёт (гейт держит скан открытым)
    let during: import('@/lib/engine/dns-alive').AliveCheckpoint | null = null
    for (let i = 0; i < 100; i++) {
      during = await dnsAlive.getAliveCheckpoint()
      if (during?.active) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(during?.active).toBe(true)
    expect(during?.origin).toBe('test')
    release()
    await waitScanDone()
    const after = await dnsAlive.getAliveCheckpoint()
    expect(after?.active).toBe(false)
    expect(after?.finishedAt).toBeTruthy()
    expect(after?.processed).toBe(1)
  }, 20_000)

  it('промежуточный сброс: вердикты в БД ДО конца партии (рестарт не теряет партию)', async () => {
    await db.domainAlive.deleteMany({ where: { domain: { startsWith: 'fl.example' } } })
    const domains = Array.from({ length: 12 }, (_, i) => `fl.example${String(i).padStart(2, '0')}`)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const answers: Record<string, { ns?: string[] }> = {}
    for (const d of domains) answers[d] = { ns: [`ns1.${d}`] }
    const gating: AliveResolver = {
      ...fakeResolver(answers),
      resolveNs: async (d: string) => {
        if (d === domains[6]) await gate // после 6 проверок скан замирает — «рестарт»
        return answers[d].ns ?? []
      },
    }
    const batches = async function * () { yield domains }
    await dnsAlive.startDomainAliveScan('test', {
      batches: batches(), resolverFactory: () => gating,
      concurrency: 1, timeoutMs: 5000, flushEvery: 5,
    })
    // ждём, пока проверены первые 6 (5 ушли в БД промежуточным сбросом, 6-я в очереди)
    for (let i = 0; i < 200 && (dnsAlive.getDomainAliveProgress()?.processed ?? 0) < 6; i++) await new Promise((r) => setTimeout(r, 50))
    expect(dnsAlive.getDomainAliveProgress()?.active).toBe(true) // скан ещё идёт — «рестарт» посреди партии
    const flushed = await db.domainAlive.findMany({ where: { domain: { startsWith: 'fl.example' } } })
    expect(flushed.length).toBe(5) // ровно flushEvery вердиктов уже в БД — партия НЕ потеряна
    release()
    await waitScanDone()
    const all = await db.domainAlive.findMany({ where: { domain: { startsWith: 'fl.example' } } })
    expect(all.length).toBe(12)
  }, 20_000)

  it('автовозобновление: чекпоинт активен → скан продолжается, свежие не перепроверяются', async () => {
    await db.domainAlive.deleteMany({ where: { domain: { in: ['res.fresh.example', 'res.stale.example'] } } })
    await db.domainAlive.create({ data: { domain: 'res.fresh.example', status: 'alive', checkedAt: new Date(), ns: 2 } })
    await db.domainAlive.create({ data: { domain: 'res.stale.example', status: 'error', checkedAt: new Date(Date.now() - 20 * 86_400_000), ns: 0 } })
    await setSettingRaw('dnsAliveCheckEnabled', 'true')
    await setSettingRaw('dnsAliveScanState', JSON.stringify(mkCkpt({ processed: 100, alive: 60, dead: 30, errors: 10 })))
    const probed: string[] = []
    const counting: AliveResolver = {
      resolveNs: async (d: string) => { probed.push(d); return d === 'res.stale.example' ? ['ns1.res.stale.example'] : [] },
      resolve4: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      resolve6: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      resolveCname: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) },
      cancel: () => undefined,
    }
    const batches = async function * () { yield ['res.fresh.example', 'res.stale.example'] }
    // подменяем batches через прямые опции недоступно (maybeResume сам вызывает
    // startDomainAliveScan) — поэтому домены резолвера проверяются против БД,
    // а кэш доменов не используется: resume-скан читает домены из DomainRecord.
    // Чтобы не зависеть от DomainRecord, проверяем механику через resume-семантику
    // startDomainAliveScan с resumeFrom (тот же путь, что и автовозобновление).
    const started = await dnsAlive.startDomainAliveScan('resume', {
      batches: batches(), resolverFactory: () => counting,
      concurrency: 1, timeoutMs: 1000, ttlDays: 14,
      resumeFrom: mkCkpt({ processed: 100, alive: 60, dead: 30, errors: 10 }),
    })
    expect(started).toBe(true)
    await waitScanDone()
    const p = dnsAlive.getDomainAliveProgress()
    expect(p?.active).toBe(false)
    expect(p?.origin).toBe('resume')
    expect(p?.processed).toBe(101) // 100 из чекпоинта + 1 перепроверенный
    expect(p?.alive).toBe(61) // 60 из чекпоинта + 1 (stale перепроверен → alive)
    expect(probed).toEqual(['res.stale.example']) // свежий не перепроверялся
    const ck = await dnsAlive.getAliveCheckpoint()
    expect(ck?.active).toBe(false)
    expect(ck?.processed).toBe(101)
    // постоянный журнал: партия записана в LogEntry
    const entry = await db.logEntry.findFirst({ where: { scope: 'dns', message: { contains: 'партия' } } })
    expect(entry).toBeTruthy()
  }, 20_000)

  it('автовозобновление: фильтр выключен → чекпоинт гасится, скан не запускается', async () => {
    await setSettingRaw('dnsAliveCheckEnabled', 'false')
    await setSettingRaw('dnsAliveScanState', JSON.stringify(mkCkpt({ processed: 77 })))
    const started = await dnsAlive.maybeResumeInterruptedScan()
    expect(started).toBe(false)
    const ck = await dnsAlive.getAliveCheckpoint()
    expect(ck?.active).toBe(false)
    expect(dnsAlive.getDomainAliveProgress()?.active).toBe(false)
  }, 20_000)

  it('maybeResumeInterruptedScan: активный чекпоинт + включённый фильтр → скан стартует', async () => {
    await setSettingRaw('dnsAliveCheckEnabled', 'true')
    await setSettingRaw('dnsAliveScanState', JSON.stringify(mkCkpt({ processed: 5 })))
    // домены берутся из DomainRecord — таблица пуста, скан завершится сразу
    const started = await dnsAlive.maybeResumeInterruptedScan()
    expect(started).toBe(true)
    await waitScanDone()
    expect(dnsAlive.getDomainAliveProgress()?.active).toBe(false)
    const ck = await dnsAlive.getAliveCheckpoint()
    expect(ck?.active).toBe(false)
  }, 20_000)
})
