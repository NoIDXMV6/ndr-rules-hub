// ─────────────────────────────────────────────────────────────────────────────
// Проверка «живости» доменов: делегирован ли домен / отвечает ли он.
//
// Зачем: в хостлистах копятся неделегированные (не продленные, удалённые,
// зарезервированные регистратурой) домены — они бесполезны в итоговом списке,
// но раздувают сборку и память DNS-сервера. Проверка — DNS-запросы:
//   • resolveNs: есть NS-записи → домен делегирован (alive);
//   • NS нет/NXDOMAIN → resolve4/resolve6/resolveCname: что-то отвечает → alive;
//   • ВСЁ вернуло ENOTFOUND (NXDOMAIN) → домен мёртв (dead) — его можно
//     исключать из сборки (настройка dnsAliveCheckEnabled);
//   • SERVFAIL/таймауты → error — вердикта нет, домен остаётся в сборке
//     (ложные исключения хуже пропуска).
// Вердикты хранятся в DomainAlive (domain PK, status, checkedAt, ns) и
// переиспользуются до старта TTL (dnsAliveTtlDays). Скан идёт фоном с пулом
// параллельных запросов (dnsAliveConcurrency), с прогрессом и отменой.
//
// Первичный прогон по миллионам доменов занимает ЧАСЫ И ДНИ (это честно: ~50
// параллельных DNS-запросов), повторные — только устаревшие записи.
//
// Живучесть скана (v1.40.1):
//   • вердикты сбрасываются в БД не только по границе партии, но и каждые
//     dnsAliveFlushEvery проверок — при рестарте теряется максимум последняя
//     сотня доменов, а не партия 25 000;
//   • чекпоинт скана хранится в Setting dnsAliveScanState (переживает рестарт):
//     активен ли скан, origin, счётчики; при завершении/отмене/ошибке — деактивируется;
//   • при старте контейнера (instrumentation.ts) найденный активный чекпоинт =
//     «скан оборвался рестартом» → скан автоматически возобновляется (origin
//     'resume'), свежие вердикты из БД не перепроверяются (TTL), счётчики
//     продолжаются с места остановки;
//   • каждая партия и все ключевые события пишутся в постоянный журнал
//     (LogEntry) — история скана видна в UI и переживает рестарт.
// ─────────────────────────────────────────────────────────────────────────────
import { Resolver } from 'dns/promises'
import { db, dbHeavy } from '@/lib/db'
import { yieldToLoop } from './loop'

// ── Настройки (в DEFAULT_SETTINGS, seed.ts) ─────────────────────────────────

export const DNS_ALIVE_DEFAULTS: Record<string, string> = {
  dnsAliveCheckEnabled: 'false', // исключать неделегированные домены из сборки
  dnsAliveTtlDays: '14', // срок годности вердикта DomainAlive (дней)
  dnsAliveConcurrency: '50', // параллельных DNS-проверок
  dnsAliveTimeoutMs: '4000', // таймаут одного запроса
}

// ── Чекпоинт скана (Setting dnsAliveScanState — переживает рестарт) ─────────

export interface AliveCheckpoint {
  active: boolean
  origin: string
  startedAt: string
  processed: number
  alive: number
  dead: number
  errors: number
  skippedFresh: number
  finishedAt: string | null
  updatedAt: string
}

const CKPT_KEY = 'dnsAliveScanState'

/** Прочитать чекпоинт скана (null — нет/битый JSON). */
export async function getAliveCheckpoint(): Promise<AliveCheckpoint | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: CKPT_KEY } })
    if (!row?.value) return null
    const j = JSON.parse(row.value) as AliveCheckpoint
    if (!j || typeof j !== 'object' || typeof j.active !== 'boolean') return null
    return j
  } catch {
    return null
  }
}

async function saveAliveCheckpoint(ck: AliveCheckpoint): Promise<void> {
  try {
    await db.setting.upsert({
      where: { key: CKPT_KEY },
      create: { key: CKPT_KEY, value: JSON.stringify(ck) },
      update: { value: JSON.stringify(ck) },
    })
  } catch (e) {
    aliveLog(`Ошибка записи чекпоинта скана: ${(e as Error).message}`)
  }
}

/** Чекпоинт = зеркало живого состояния скана (счётчики кумулятивные). */
function checkpointFromState(finished: boolean): AliveCheckpoint {
  const s = aliveState!
  return {
    active: !finished,
    origin: s.origin,
    startedAt: s.startedAt ?? nowIso(),
    processed: s.processed,
    alive: s.alive,
    dead: s.dead,
    errors: s.errors,
    skippedFresh: s.skippedFresh,
    finishedAt: finished ? (s.finishedAt ?? nowIso()) : null,
    updatedAt: nowIso(),
  }
}

/**
 * Автовозобновление прерванного скана: чекпоинт «активен» после рестарта
 * контейнера означает, что процесс умер посреди скана. Фильтр неделегированных
 * включён → перезапускаем скан (origin 'resume', счётчики продолжаются, свежие
 * вердикты из БД не перепроверяются). Выключен → чекпоинт гасим (пользователь
 * отключил фильтр — рестарт скана не нужен). Вызывается при старте процесса.
 */
export async function maybeResumeInterruptedScan(): Promise<boolean> {
  try {
    const ck = await getAliveCheckpoint()
    if (!ck?.active) return false
    if (aliveState?.active) return false
    const { getSettings, log } = await import('./service')
    const s = await getSettings()
    if (s.dnsAliveCheckEnabled !== 'true') {
      await saveAliveCheckpoint({ ...ck, active: false, finishedAt: nowIso(), updatedAt: nowIso() })
      await log('info', 'dns',
        `Живость доменов: обнаружен скан, прерванный рестартом (было проверено ${ck.processed.toLocaleString('ru-RU')}); фильтр неделегированных выключен — возобновление не требуется`,
        undefined,
        `Domain liveness: scan interrupted by restart found (${ck.processed} checked); dead-domain filter is off — no resume needed`)
        .catch(() => undefined)
      return false
    }
    await log('info', 'dns',
      `Живость доменов: скан был прерван рестартом контейнера — возобновляю с места остановки (в счётчике ${ck.processed.toLocaleString('ru-RU')} доменов; проверенные вердикты сохранены в БД и не перепроверяются)`,
      undefined,
      `Domain liveness: scan was interrupted by container restart — resuming (${ck.processed} processed; stored verdicts are kept and not re-probed)`)
      .catch(() => undefined)
    return await startDomainAliveScan('resume', { resumeFrom: ck })
  } catch {
    return false
  }
}

// ── Прогресс скана (зеркало dns-progress в уменьшенном виде) ────────────────

export interface DomainAliveProgress {
  active: boolean
  origin: string
  stage: string // read | probe | done
  percent: number
  processed: number
  total: number
  alive: number
  dead: number
  /** проверок с ошибкой (SERVFAIL/таймаут — вердикта нет) */
  errors: number
  skippedFresh: number
  startedAt: string | null
  finishedAt: string | null
  /** текст ошибки аварийно завершённого скана, null — ок */
  error: string | null
  log: Array<{ ts: string; msg: string }>
}

const LOG_CAP = 200
let aliveState: DomainAliveProgress | null = null
let cancelRequested = false

function nowIso(): string {
  return new Date().toISOString()
}

function consoleLog(msg: string): void {
  console.log(`[dns-alive ${nowIso().slice(11, 19)}] ${msg}`)
}

function resetProgress(origin: string, resume?: AliveCheckpoint | null): void {
  aliveState = {
    active: true,
    origin,
    stage: 'read',
    percent: 0,
    processed: resume?.processed ?? 0,
    total: 0,
    alive: resume?.alive ?? 0,
    dead: resume?.dead ?? 0,
    errors: resume?.errors ?? 0,
    skippedFresh: resume?.skippedFresh ?? 0,
    startedAt: resume?.startedAt ?? nowIso(),
    finishedAt: null,
    error: null,
    log: [],
  }
}

function aliveLog(msg: string): void {
  if (aliveState) {
    aliveState.log.push({ ts: nowIso(), msg: msg.slice(0, 500) })
    if (aliveState.log.length > LOG_CAP) aliveState.log.splice(0, aliveState.log.length - LOG_CAP)
  }
  consoleLog(msg)
}

export function getDomainAliveProgress(): DomainAliveProgress | null {
  return aliveState
}

export function cancelDomainAliveScan(): boolean {
  if (!aliveState?.active) return false
  cancelRequested = true
  aliveLog('Отмена проверки живости запрошена — завершим после текущей партии…')
  return true
}

// ── Классификация вердикта (чистая функция — покрывается тестами) ────────────

export interface AliveProbeResult {
  nsErr: string | null
  ns: number
  aErr: string | null
  a: number
  aaaaErr: string | null
  aaaa: number
  cnameErr: string | null
  cname: number
}

export type AliveVerdict = 'alive' | 'dead' | 'error'

/**
 * Вердикт по результатам запросов: alive — NS/адрес/CNAME есть; dead — ВСЕ
 * запросы NXDOMAIN (домен неделегирован/не существует); error — остальное
 * (SERVFAIL/таймаут: сетевая проблема ≠ отсутствие домена).
 */
export function classifyAlive(p: AliveProbeResult): AliveVerdict {
  if (p.ns > 0 || p.a > 0 || p.aaaa > 0 || p.cname > 0) return 'alive'
  const allNx = [p.nsErr, p.aErr, p.aaaaErr, p.cnameErr]
  if (allNx.every((e) => e === 'ENOTFOUND')) return 'dead'
  return 'error'
}

/** Минимальный интерфейс резолвера (ди для тестов и для dns.Resolver) */
export interface AliveResolver {
  resolveNs(d: string): Promise<string[]>
  resolve4(d: string): Promise<string[]>
  resolve6(d: string): Promise<string[]>
  resolveCname(d: string): Promise<string[]>
  cancel(): void
}

function withTimeout<T>(p: (signal: { cancelled: boolean }) => Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false; err: string }> {
  const state = { cancelled: false }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.cancelled = true
      resolve({ ok: false, err: 'ETIMEOUT' })
    }, timeoutMs)
    p(state)
      .then((value) => { clearTimeout(timer); resolve({ ok: true, value }) })
      .catch((e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ ok: false, err: e.code ?? e.message ?? 'EFAIL' }) })
  })
}

/** Одна проверка домена: NS → (при NXDOMAIN) A/AAAA/CNAME. Вердикт + число NS */
export async function probeDomain(domain: string, res: AliveResolver, timeoutMs: number): Promise<{ verdict: AliveVerdict; ns: number }> {
  const out: AliveProbeResult = { nsErr: null, ns: 0, aErr: null, a: 0, aaaaErr: null, aaaa: 0, cnameErr: null, cname: 0 }
  const ns = await withTimeout((st) => res.resolveNs(domain).then((v) => { if (st.cancelled) throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }); return v }), timeoutMs)
  if (ns.ok) out.ns = ns.value.length
  else out.nsErr = ns.err
  if (out.ns > 0) return { verdict: classifyAlive(out), ns: out.ns }
  // NS нет (или ошибка): проверяем адресные записи — некоторые зоны NS не отдают
  const [a, aaaa, cname] = await Promise.all([
    withTimeout((st) => res.resolve4(domain).then((v) => { if (st.cancelled) throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }); return v }), timeoutMs),
    withTimeout((st) => res.resolve6(domain).then((v) => { if (st.cancelled) throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }); return v }), timeoutMs),
    withTimeout((st) => res.resolveCname(domain).then((v) => { if (st.cancelled) throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }); return v }), timeoutMs),
  ])
  if (a.ok) out.a = a.value.length; else out.aErr = a.err
  if (aaaa.ok) out.aaaa = aaaa.value.length; else out.aaaaErr = aaaa.err
  if (cname.ok) out.cname = cname.value.length; else out.cnameErr = cname.err
  return { verdict: classifyAlive(out), ns: out.ns }
}

function systemResolver(): AliveResolver {
  const r = new Resolver({ timeout: 4000, tries: 2 })
  return {
    resolveNs: (d) => r.resolveNs(d),
    resolve4: (d) => r.resolve4(d),
    resolve6: (d) => r.resolve6(d),
    resolveCname: (d) => r.resolveCname(d),
    cancel: () => r.cancel(),
  }
}

// ── Счётчики вердиктов (TTL-кэш: GROUP BY по миллионам строк тяжёлый) ────────

let aliveCountsCache: { at: number; value: { alive: number; dead: number; error: number; checked: number } } | null = null

export function invalidateAliveCounts(): void {
  aliveCountsCache = null
}

export async function domainAliveCounts(): Promise<{ alive: number; dead: number; error: number; checked: number }> {
  if (aliveCountsCache && Date.now() - aliveCountsCache.at < 60_000) return aliveCountsCache.value
  try {
    const rows = await db.$queryRawUnsafe<Array<{ status: string; n: bigint }>>(
      'SELECT status, COUNT(*) AS n FROM DomainAlive GROUP BY status')
    const value = { alive: 0, dead: 0, error: 0, checked: 0 }
    for (const r of rows) {
      const n = Number(r.n)
      value.checked += n
      if (r.status === 'alive') value.alive = n
      else if (r.status === 'dead') value.dead = n
      else if (r.status === 'error') value.error = n
    }
    aliveCountsCache = { at: Date.now(), value }
    return value
  } catch {
    return { alive: 0, dead: 0, error: 0, checked: 0 }
  }
}

// ── Скан ─────────────────────────────────────────────────────────────────────

export interface AliveScanOptions {
  /** подменить резолвер (тесты) */
  resolverFactory?: () => AliveResolver
  concurrency?: number
  ttlDays?: number
  timeoutMs?: number
  /** максимум проверок за прогон (предохранитель; 0 — без ограничения) */
  limit?: number
  /** сбрасывать вердикты в БД каждые N проверок (по умолчанию 1000) */
  flushEvery?: number
  /** чекпоинт прерванного скана: продолжить счётчики (автовозобновление) */
  resumeFrom?: AliveCheckpoint
  /** подмена чтения доменов (тесты): батчи уникальных доменов */
  batches?: AsyncIterable<string[]>
}

const BATCH = 25_000

/** Уникальные домены БД батчами по @@index([domain]) (курсор по domain) */
async function * domainBatches(): AsyncIterable<string[]> {
  let cursor = ''
  for (;;) {
    const rows = await dbHeavy.$queryRawUnsafe<Array<{ domain: string }>>(
      'SELECT DISTINCT domain FROM DomainRecord WHERE domain > ? ORDER BY domain LIMIT ?',
      cursor, BATCH)
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].domain
    yield rows.map((r) => r.domain)
    await yieldToLoop()
  }
}

/**
 * Запустить скан живости (фоном; повторный запуск отклоняется). Возвращает
 * false, если скан уже идёт. Результат пишется в DomainAlive.
 */
export async function startDomainAliveScan(origin = 'manual', opts: AliveScanOptions = {}): Promise<boolean> {
  if (aliveState?.active) return false
  cancelRequested = false
  resetProgress(origin, opts.resumeFrom)
  void runScan(origin, opts).catch((e) => {
    if (aliveState) {
      aliveState.active = false
      aliveState.finishedAt = nowIso()
      aliveState.error = (e as Error).message.slice(0, 500)
    }
    void saveAliveCheckpoint(checkpointFromState(true)) // аварийный финиш — чекпоинт гасим, чтобы не зациклить автовозобновление
    aliveLog(`Ошибка проверки живости: ${(e as Error).message}`)
  })
  return true
}

async function runScan(origin: string, opts: AliveScanOptions): Promise<void> {
  const t0 = Date.now()
  let concurrency = opts.concurrency ?? 50
  let ttlDays = opts.ttlDays ?? 14
  let timeoutMs = opts.timeoutMs ?? 4000
  try {
    // настройки из БД (если не заданы явно — тесты передают свои)
    const { getSettings } = await import('./service')
    const s = await getSettings()
    if (opts.concurrency === undefined) concurrency = Math.max(1, parseInt(s.dnsAliveConcurrency || '50', 10) || 50)
    if (opts.ttlDays === undefined) ttlDays = Math.max(1, parseInt(s.dnsAliveTtlDays || '14', 10) || 14)
    if (opts.timeoutMs === undefined) timeoutMs = Math.max(500, parseInt(s.dnsAliveTimeoutMs || '4000', 10) || 4000)
  } catch { /* БД недоступна — берём дефолты */ }

  const freshAfter = new Date(Date.now() - ttlDays * 86_400_000)
  const resolver = opts.resolverFactory?.() ?? systemResolver()
  const state = aliveState!
  const flushEvery = Math.max(1, opts.flushEvery ?? 1000)
  aliveLog(`Проверка живости (${origin}): пул ${concurrency}, таймаут ${timeoutMs} мс, TTL вердиктов ${ttlDays} дн.${state.processed > 0 ? `, продолжение — в счётчике ${state.processed.toLocaleString('ru-RU')} доменов` : ''}`)
  await saveAliveCheckpoint(checkpointFromState(false)) // скан активен — чекпоинт переживёт рестарт

  const writeQueue: Array<{ domain: string; verdict: AliveVerdict; ns: number }> = []
  const flushWrites = async (): Promise<void> => {
    if (writeQueue.length === 0) return
    const chunk = writeQueue.splice(0, writeQueue.length)
    try {
      await dbHeavy.$transaction(chunk.map((w) =>
        dbHeavy.$executeRawUnsafe(
          `INSERT INTO DomainAlive (domain, status, checkedAt, ns) VALUES (?, ?, ?, ?)
           ON CONFLICT(domain) DO UPDATE SET status = excluded.status, checkedAt = excluded.checkedAt, ns = excluded.ns`,
          w.domain, w.verdict, new Date(), w.ns)))
      invalidateAliveCounts()
      await saveAliveCheckpoint(checkpointFromState(false)) // счётчики чекпоинта — вслед за вердиктами
    } catch (e) {
      aliveLog(`Ошибка записи вердиктов (${chunk.length}): ${(e as Error).message}`)
    }
  }

  let checked = 0
  const limit = opts.limit ?? 0
  const probeWorker = async (queue: string[], next: { i: number }): Promise<void> => {
    while (next.i < queue.length) {
      if (cancelRequested) return
      const domain = queue[next.i++]
      try {
        const { verdict, ns } = await probeDomain(domain, resolver, timeoutMs)
        if (verdict === 'alive') state.alive++
        else if (verdict === 'dead') state.dead++
        else state.errors++
        writeQueue.push({ domain, verdict, ns })
      } catch (e) {
        state.errors++
        aliveLog(`«${domain}»: ошибка проверки — ${(e as Error).message}`)
      }
      state.processed++
      checked++
      // промежуточный сброс: рестарт в середине партии теряет максимум flushEvery
      // проверок, а не всю партию 25 000 (часы работы при медленных доменах)
      if (writeQueue.length >= flushEvery) await flushWrites()
    }
  }

  let batchNo = 0
  const batches = opts.batches ?? domainBatches()
  for await (const batch of batches) {
    if (cancelRequested) break
    if (limit > 0 && checked >= limit) break
    batchNo++
    state.stage = 'probe'
    // какие домены в батче не имеют свежего вердикта
    const existing = await dbHeavy.domainAlive.findMany({
      where: { domain: { in: batch }, checkedAt: { gt: freshAfter } },
      select: { domain: true },
    })
    const fresh = new Set(existing.map((e) => e.domain))
    const stale = batch.filter((d) => !fresh.has(d))
    state.skippedFresh += batch.length - stale.length
    state.total += batch.length
    if (stale.length > 0) {
      // пул параллельных проверок
      const queue = stale.slice(0, limit > 0 ? Math.max(0, limit - checked) : stale.length)
      const next = { i: 0 }
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => probeWorker(queue, next)))
      await flushWrites()
    }
    state.percent = Math.min(99, Math.round((state.processed / Math.max(1, state.total)) * 100))
    aliveLog(`Партия ${batchNo}: доменов ${batch.length.toLocaleString('ru-RU')}, к проверке ${stale.length.toLocaleString('ru-RU')}, свежих ${state.skippedFresh.toLocaleString('ru-RU')}; итоги: живых ${state.alive.toLocaleString('ru-RU')}, мёртвых ${state.dead.toLocaleString('ru-RU')}, ошибок ${state.errors.toLocaleString('ru-RU')}`)
    // постоянный журнал: партия + счётчики (переживает рестарт, виден в UI «Журнал»)
    await import('./service').then(({ log }) =>
      log('info', 'dns',
        `Живость доменов (партия ${batchNo}): доменов ${batch.length.toLocaleString('ru-RU')}, к проверке ${stale.length.toLocaleString('ru-RU')}, свежих пропущено ${state.skippedFresh.toLocaleString('ru-RU')}; всего: живых ${state.alive.toLocaleString('ru-RU')}, мёртвых ${state.dead.toLocaleString('ru-RU')}, ошибок ${state.errors.toLocaleString('ru-RU')}`,
        undefined,
        `Domain liveness (batch ${batchNo}): domains ${batch.length}, to probe ${stale.length}, fresh skipped ${state.skippedFresh}; totals: alive ${state.alive}, dead ${state.dead}, errors ${state.errors}`))
      .catch(() => undefined)
    await yieldToLoop()
  }

  await flushWrites()
  resolver.cancel()
  state.active = false
  state.stage = 'done'
  state.percent = 100
  state.finishedAt = nowIso()
  await saveAliveCheckpoint(checkpointFromState(true)) // скан завершён/остановлен — чекпоинт гасим (автовозобновление больше не нужно)
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  if (cancelRequested) {
    aliveLog(`Проверка живости остановлена вручную: проверено ${checked.toLocaleString('ru-RU')} доменов за ${dt} с`)
  } else {
    aliveLog(`Проверка живости завершена за ${dt} с: проверено ${checked.toLocaleString('ru-RU')}, свежих пропущено ${state.skippedFresh.toLocaleString('ru-RU')}; живых ${state.alive.toLocaleString('ru-RU')}, мёртвых ${state.dead.toLocaleString('ru-RU')}, ошибок ${state.errors.toLocaleString('ru-RU')}`)
  }
  await import('./service').then(({ log }) =>
    log(cancelRequested ? 'warn' : 'success', 'dns',
      cancelRequested
        ? `Проверка живости доменов остановлена: проверено ${checked.toLocaleString('ru-RU')} (живых ${state.alive.toLocaleString('ru-RU')}, мёртвых ${state.dead.toLocaleString('ru-RU')})`
        : `Проверка живости доменов: проверено ${checked.toLocaleString('ru-RU')} доменов (живых ${state.alive.toLocaleString('ru-RU')}, мёртвых ${state.dead.toLocaleString('ru-RU')}, ошибок ${state.errors.toLocaleString('ru-RU')}, ${dt} с)`,
      undefined,
      cancelRequested
        ? `Domain liveness scan stopped: ${checked} checked (alive ${state.alive}, dead ${state.dead})`
        : `Domain liveness scan: ${checked} domains checked (alive ${state.alive}, dead ${state.dead}, errors ${state.errors}, ${dt} s)`))
    .catch(() => undefined)
}

/**
 * Автозапуск скана после DNS-цикла (cron): только если включена фильтр
 * «живости» в сборке — иначе вердикты никому не нужны и DNS-запросы впустую.
 */
export async function maybeStartAliveScan(origin: string): Promise<boolean> {
  try {
    const { getSettings } = await import('./service')
    const s = await getSettings()
    if (s.dnsAliveCheckEnabled !== 'true') return false
    if (aliveState?.active) return false
    return await startDomainAliveScan(origin)
  } catch {
    return false
  }
}
