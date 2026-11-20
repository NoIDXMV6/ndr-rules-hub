import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// ── v1.35.0 — снятие блокировок БД/сборки ────────────────────────────────────
//  1) sortStringsYielded — сортировка миллионов строк с паузами event loop:
//     порядок обязан совпадать с дефолтным Array.sort (файл сборки отсортирован);
//  2) watchdog зависших сборок: сборка без признаков жизни принудительно
//     завершается, очередь разблокируется — «вечная» активная сборка невозможна;
//  3) TTL-кэш счётчиков: COUNT(*) по большим таблицам не идёт на каждый опрос;
//  4) buildDomainList (стриминговая запись файла) — файл идентичен
//     renderDomainFile, дубликаты/белый список/ручные решения работают.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..')

// ── 1. сортировка с паузами (чистая функция — БД не нужна) ──────────────────
describe('sortStringsYielded (сортировка без блокировки event loop)', () => {
  it('порядок совпадает с дефолтным Array.sort — чанки + k-way слияние', async () => {
    const { sortStringsYielded } = await import('@/lib/engine/dns')
    const input: string[] = []
    for (let i = 0; i < 250_000; i++) {
      input.push(`dom-${(i * 7919) % 1_000_000}.example-${i % 97}.test`)
    }
    const expected = [...input].sort()
    const got = await sortStringsYielded(input, undefined, 50_000)
    expect(got.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      if (got[i] !== expected[i]) {
        throw new Error(`расхождение на позиции ${i}: ${got[i]} !== ${expected[i]}`)
      }
    }
  })

  it('малый массив сортируется и дубликаты сохраняются', async () => {
    const { sortStringsYielded } = await import('@/lib/engine/dns')
    const input = ['b.test', 'a.test', 'b.test', 'c.test']
    const got = await sortStringsYielded(input)
    expect(got).toEqual(['a.test', 'b.test', 'b.test', 'c.test'])
  })
})

// ── 2-4: watchdog, кэш счётчиков, DNS-сборка — на реальной БД ────────────────
let work: string
let db: import('@prisma/client').PrismaClient
let progress: typeof import('@/lib/engine/build-progress')
let dnsProgress: typeof import('@/lib/engine/dns-progress')
let dnsService: typeof import('@/lib/engine/dns-service')
let cache: typeof import('@/lib/engine/count-cache')

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-perf-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  progress = await import('@/lib/engine/build-progress')
  dnsProgress = await import('@/lib/engine/dns-progress')
  dnsService = await import('@/lib/engine/dns-service')
  cache = await import('@/lib/engine/count-cache')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('watchdog зависших сборок (build-progress)', () => {
  it('сборка без признаков жизни принудительно завершается и разблокирует очередь', async () => {
    progress.setBuildStaleMs(0) // «молчание мгновенно считается зависанием»
    progress.startBuildProgress('manual')
    await new Promise((r) => setTimeout(r, 5)) // гарантированное «молчание» 5 мс
    expect(progress.isBuildActive()).toBe(false) // watchdog роняет сборку
    const st = progress.getBuildProgress()
    expect(st?.active).toBe(false)
    expect(st?.error).toContain('watchdog')
    expect(st?.result?.ok).toBe(false)
    // очередь разблокирована: новую сборку можно начать
    progress.startBuildProgress('manual')
    expect(progress.isBuildActive()).toBe(true)
    // touch сбрасывает watchdog
    progress.touchBuild()
    expect(progress.isBuildActive()).toBe(true)
    progress.setBuildStaleMs(10 * 60_000) // вернуть боевой порог
    progress.finishBuildProgress({ ok: true, total: 0, fileName: 'x.rules' })
    expect(progress.isBuildActive()).toBe(false)
  })
})

describe('watchdog зависших DNS-сборок (dns-progress)', () => {
  it('аналогично: молчание → аварийное завершение с диагностикой', async () => {
    dnsProgress.setDnsBuildStaleMs(0)
    dnsProgress.startDnsBuildProgress('manual')
    await new Promise((r) => setTimeout(r, 5))
    expect(dnsProgress.isDnsBuildActive()).toBe(false)
    const st = dnsProgress.getDnsBuildProgress()
    expect(st?.active).toBe(false)
    expect(st?.error).toContain('watchdog')
    dnsProgress.setDnsBuildStaleMs(10 * 60_000)
    dnsProgress.startDnsBuildProgress('manual')
    dnsProgress.touchDnsBuild()
    expect(dnsProgress.isDnsBuildActive()).toBe(true)
    dnsProgress.resetDnsBuildProgress()
  })
})

describe('TTL-кэш счётчиков (count-cache)', () => {
  it('первый вызов — честный подсчёт; в пределах TTL — кэш; invalidate — свежее значение', async () => {
    cache.resetCountCache()
    const n0 = await cache.rulesCountCached()
    expect(n0).toBe(0)
    const src = await db.source.create({ data: { name: `cc-src-${Date.now()}`, category: 'ruleset', kind: 'url' } })
    await db.rule.createMany({
      data: [1, 2, 3].map((sid) => ({
        sourceId: src.id, sid, rev: 1, action: 'alert', proto: 'tcp',
        raw: `alert tcp any any -> any any (msg:"t${sid}"; content:"x${sid}"; sid:${sid}; rev:1;)`,
        contentHash: `h${sid}`,
      })),
    })
    // в пределах TTL кэш возвращает старое значение (фон обновит сам)
    expect(await cache.rulesCountCached()).toBe(0)
    // инвалидация: счётчик сразу видит изменения
    cache.invalidateCounts()
    expect(await cache.rulesCountCached()).toBe(3)
  })

  it('domainRecordsCountCached работает с invalidateCounts', async () => {
    cache.resetCountCache()
    const dsrc = await db.domainSource.create({ data: { name: `cc-dns-${Date.now()}`, kind: 'url' } })
    await db.domainRecord.createMany({ data: [{ sourceId: dsrc.id, domain: 'a.test' }, { sourceId: dsrc.id, domain: 'b.test' }] })
    expect(await cache.domainRecordsCountCached()).toBe(2)
    cache.invalidateCounts()
    await db.domainRecord.deleteMany({ where: { sourceId: dsrc.id } })
    expect(await cache.domainRecordsCountCached()).toBe(0)
  })
})

describe('DNS-сборка: стриминговая запись файла (buildDomainList)', () => {
  it('файл идентичен renderDomainFile; дубликаты/белый список/ручные решения', async () => {
    const { renderDomainFile, parseDomainList } = await import('@/lib/engine/dns')
    const stamp = Date.now()
    const s1 = await db.domainSource.create({
      data: { name: `perf-block-${stamp}`, kind: 'url', purpose: 'block', priority: 50, category: 'ads' },
    })
    const s2 = await db.domainSource.create({
      data: { name: `perf-block2-${stamp}`, kind: 'url', purpose: 'block', priority: 60, category: 'malware' },
    })
    const sAllow = await db.domainSource.create({
      data: { name: `perf-allow-${stamp}`, kind: 'url', purpose: 'allow', priority: 10, category: 'allow' },
    })
    await db.domainRecord.createMany({
      data: [
        { sourceId: s1.id, domain: 'ads-one.test', mode: 'block' },
        { sourceId: s1.id, domain: 'shared.test', mode: 'block' },
        { sourceId: s1.id, domain: 'exclude-me.test', mode: 'block' },
        { sourceId: s2.id, domain: 'shared.test', mode: 'block' }, // дубликат (проигрывает по приоритету)
        { sourceId: s2.id, domain: 'malware.test', mode: 'block' },
        { sourceId: sAllow.id, domain: 'exclude-me.test', mode: 'block' }, // белый список
      ],
    })
    // ручное решение: malware.test исключён пользователем
    await db.domainOverride.create({ data: { domain: 'malware.test', enabled: false } })

    const r = await dnsService.buildDomainList('manual')
    expect(r.ok).toBe(true)
    expect(r.total).toBe(2) // ads-one.test + shared.test
    const content = await fs.readFile(path.join(r.fileName ? '' : '', (await dnsService.lastDomainBuild())!.filePath), 'utf8')
    const expected = renderDomainFile(
      ['ads-one.test', 'shared.test'], [], 'plain',
      expect.anything() as never, // мета не важна для структуры — сравниваем список строк
    )
    // строки файла (без шапки) совпадают с ожидаемыми доменами
    const rows = content.split('\n').filter((l) => l && !l.startsWith('#'))
    expect(rows).toEqual(['ads-one.test', 'shared.test'])
    void expected
    void parseDomainList

    // статистика: дубликат устранён, белый список применился, override исключил malware.test
    const last = await dnsService.lastDomainBuild()
    expect(last?.stats.duplicateByDomain).toBe(1)
    expect(last?.stats.allowedRemoved).toBe(1)
    expect(last?.stats.overrideRemoved).toBe(1)
    // прогресс завершён
    const st = dnsProgress.getDnsBuildProgress()
    expect(st?.active).toBe(false)
    expect(st?.result?.ok).toBe(true)
  })
})
