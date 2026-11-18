// ─────────────────────────────────────────────────────────────────────────────
// Прогресс сборки набора правил (в памяти процесса).
//
// Сборка — самая долгая операция хаба (слияние десятков тысяч правил, санитайз,
// remap SID, рендер файла, tar-архив). Раньше кнопка «Собрать» просто ждала
// ответа POST /api/build без всякого статуса. Теперь buildFinal на каждой фазе
// сообщает stage/percent сюда, а POST /api/build запускает сборку фоном и
// возвращает jobId; клиент опрашивает GET /api/build/progress и рисует
// прогрессбар + хвост журнала сборки.
//
// Один build за раз гарантирует очередь «build» (maxConcurrent=1), поэтому
// состояние — одиночка (singleton). Задание живёт до следующего запуска:
// завершённое состояние остаётся доступным для последнего опроса клиента.
// Журнал ограничен кольцом (BUILD_LOG_CAP строк) — сборка крупных каталогов
// не раздувает память. Состояние персистентно в пределах процесса Node:
// перезапуск сервера сбрасывает прогресс (это честно — незавершённая сборка
// при перезапуске прерывается физически).
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildLogLine {
  ts: string
  msg: string
}

export interface BuildProgressState {
  jobId: string
  /** origin запуска: manual | cron | … */
  origin: string
  active: boolean
  /** код фазы: db-read | filter | merge | conflict-dedup | sanitize | remap | sid-check | render | diff | save | archive | db-write | export | done */
  stage: string
  /** 0..100 */
  percent: number
  startedAt: string
  finishedAt: string | null
  error: string | null
  log: BuildLogLine[]
  /** финальный результат buildFinal (после завершения) */
  result: {
    ok: boolean
    error?: string
    total?: number
    fileName?: string
    changes?: { added: number; changed: number; removed: number } | null
    unchanged?: boolean
    export?: { ok: boolean; error?: string; detail?: string; pushedTo?: string } | null
  } | null
}

const LOG_CAP = 600

let state: BuildProgressState | null = null
let jobSeq = 0

function nowIso(): string {
  return new Date().toISOString()
}

/** Начать новое задание прогресса (сбрасывает предыдущее состояние). */
export function startBuildProgress(origin: string): BuildProgressState {
  jobSeq += 1
  state = {
    jobId: `b${Date.now().toString(36)}${jobSeq}`,
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

/** Текущее состояние (или null — сборок в этом процессе ещё не было). */
export function getBuildProgress(): BuildProgressState | null {
  return state
}

/** Есть ли незавершённая сборка прямо сейчас. */
export function isBuildActive(): boolean {
  return state?.active ?? false
}

/** Смена фазы сборки: код фазы + процент готовности (0..100). */
export function setBuildStage(stage: string, percent: number): void {
  if (!state) return
  state.stage = stage
  state.percent = Math.max(0, Math.min(100, Math.round(percent)))
}

/** Добавить строку в журнал сборки (показывается в UI под прогрессбаром). */
export function addBuildLog(msg: string): void {
  if (!state) return
  state.log.push({ ts: nowIso(), msg: msg.slice(0, 500) })
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP)
}

/** Успешное (или частично — export с ошибкой) завершение сборки. */
export function finishBuildProgress(result: NonNullable<BuildProgressState['result']>): void {
  if (!state) return
  state.active = false
  state.stage = 'done'
  state.percent = 100
  state.finishedAt = nowIso()
  state.result = result
}

/** Аварийное завершение сборки (исключение/гейт). */
export function failBuildProgress(error: string): void {
  if (!state) return
  state.active = false
  state.finishedAt = nowIso()
  state.error = error.slice(0, 500)
  state.result = { ok: false, error: state.error }
}

/** Только для тестов: обнулить состояние прогресса. */
export function resetBuildProgress(): void {
  state = null
}
