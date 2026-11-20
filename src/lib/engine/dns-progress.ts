// ─────────────────────────────────────────────────────────────────────────────
// Прогресс DNS-сборки (в памяти процесса) — зеркало build-progress.ts,
// отдельный singleton: DNS-сборка может идти параллельно со сборкой правил.
// ─────────────────────────────────────────────────────────────────────────────

export interface DnsBuildLogLine {
  ts: string
  msg: string
}

export interface DnsBuildProgressState {
  jobId: string
  origin: string
  active: boolean
  /** фазы: db-read | allow | merge | render | save | done */
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

let state: DnsBuildProgressState | null = null
let jobSeq = 0

function nowIso(): string {
  return new Date().toISOString()
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
  return state
}

export function getDnsBuildProgress(): DnsBuildProgressState | null {
  return state
}

export function isDnsBuildActive(): boolean {
  return state?.active ?? false
}

export function setDnsBuildStage(stage: string, percent: number): void {
  if (!state) return
  state.stage = stage
  state.percent = Math.max(0, Math.min(100, Math.round(percent)))
}

export function addDnsBuildLog(msg: string): void {
  if (!state) return
  state.log.push({ ts: nowIso(), msg: msg.slice(0, 500) })
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP)
}

export function finishDnsBuildProgress(result: NonNullable<DnsBuildProgressState['result']>): void {
  if (!state) return
  state.active = false
  state.stage = 'done'
  state.percent = 100
  state.finishedAt = nowIso()
  state.result = result
}

export function failDnsBuildProgress(error: string): void {
  if (!state) return
  state.active = false
  state.finishedAt = nowIso()
  state.error = error.slice(0, 500)
  state.result = { ok: false, error: state.error }
}

export function resetDnsBuildProgress(): void {
  state = null
}
