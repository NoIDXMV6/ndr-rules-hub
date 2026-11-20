// ─────────────────────────────────────────────────────────────────────────────
// Прогресс DNS-сборки (в памяти процесса) — зеркало build-progress.ts,
// отдельный singleton: DNS-сборка может идти параллельно со сборкой правил.
//
// Watchdog зависших сборок (v1.35.0): раньше незавершённая сборка оставалась
// «active» навсегда (isDnsBuildActive() = true) — повторный запуск отклонялся
// «DNS-сборка уже выполняется», UI показывал вечный прогрессбар. Теперь у
// задания есть признак жизни (touch на каждой стадии/строке журнала/батче);
// если активность пропала дольше DNS_STALE_MS — задание принудительно
// завершается с ошибкой, очередь разблокируется, в stdout уходит диагностика.
// ─────────────────────────────────────────────────────────────────────────────

export interface DnsBuildLogLine {
  ts: string
  msg: string
}

export interface DnsBuildProgressState {
  jobId: string
  origin: string
  active: boolean
  /** фазы: db-read | allow | merge | sort | render | save | done */
  stage: string
  percent: number
  startedAt: string
  finishedAt: string | null
  error: string | null
  log: DnsBuildLogLine[]
  result: {
    ok: boolean
    error?: string
    total?: number
    fileName?: string
  } | null
}

const LOG_CAP = 300
/** Предохранитель «вечной сборки»: нет признаков жизни N минут — аварийное завершение */
let DNS_STALE_MS = 10 * 60_000

/** Только для тестов: подменить порог watchdog (мс) */
export function setDnsBuildStaleMs(ms: number): void {
  DNS_STALE_MS = ms
}

let state: DnsBuildProgressState | null = null
let jobSeq = 0
let startedMs = 0
let updatedMs = 0

function nowIso(): string {
  return new Date().toISOString()
}

function consoleLog(msg: string): void {
  console.log(`[dns-build ${nowIso().slice(11, 19)}] ${msg}`)
}

export function startDnsBuildProgress(origin: string): DnsBuildProgressState {
  jobSeq += 1
  state = {
    jobId: `d${Date.now().toString(36)}${jobSeq}`,
    origin,
    active: true,
    stage: 'db-read',
    percent: 0,
    startedAt: nowIso(),
    finishedAt: null,
    error: null,
    log: [],
    result: null,
  }
  startedMs = Date.now()
  updatedMs = startedMs
  consoleLog(`сборка списка доменов запущена (origin=${origin}, jobId=${state.jobId})`)
  return state
}

export function getDnsBuildProgress(): DnsBuildProgressState | null {
  return state
}

/** Признак жизни долгой операции (сбрасывает watchdog) — вызывать из циклов сборки */
export function touchDnsBuild(): void {
  if (state?.active) updatedMs = Date.now()
}

export function isDnsBuildActive(): boolean {
  if (!state?.active) return false
  const idle = Date.now() - Math.max(startedMs, updatedMs)
  if (idle > DNS_STALE_MS) {
    const err = `сборка прервана watchdog: признаков жизни нет ${(idle / 60_000).toFixed(0)} мин (стадия «${state.stage}») — операция считалась зависшей`
    failDnsBuildProgress(err)
    return false
  }
  return true
}

export function setDnsBuildStage(stage: string, percent: number): void {
  if (!state) return
  state.stage = stage
  state.percent = Math.max(0, Math.min(100, Math.round(percent)))
  updatedMs = Date.now()
  consoleLog(`стадия ${stage} (${state.percent}%)`)
}

export function addDnsBuildLog(msg: string): void {
  if (!state) return
  state.log.push({ ts: nowIso(), msg: msg.slice(0, 500) })
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP)
  updatedMs = Date.now()
  // зеркало в stdout: контейнерные логи доступны даже когда БД заблокирована —
  // единственная диагностика «непонятного» статуса сборки
  consoleLog(msg)
}

export function finishDnsBuildProgress(result: NonNullable<DnsBuildProgressState['result']>): void {
  if (!state) return
  state.active = false
  state.stage = 'done'
  state.percent = 100
  state.finishedAt = nowIso()
  state.result = result
  consoleLog(`сборка завершена за ${((Date.now() - startedMs) / 1000).toFixed(1)} с: ${result.ok ? `OK, ${result.total ?? 0} доменов, файл ${result.fileName ?? '—'}` : `ошибка: ${result.error ?? '—'}`}`)
}

export function failDnsBuildProgress(error: string): void {
  if (!state) return
  state.active = false
  state.finishedAt = nowIso()
  state.error = error.slice(0, 500)
  state.result = { ok: false, error: state.error }
  console.error(`[dns-build ${nowIso().slice(11, 19)}] СБОЙ: ${state.error} (стадия ${state.stage}, прошло ${((Date.now() - startedMs) / 1000).toFixed(1)} с)`)
}

export function resetDnsBuildProgress(): void {
  state = null
}
