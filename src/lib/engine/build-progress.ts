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
//
// Watchdog (v1.35.0): признак жизни (touch на каждой стадии/строке журнала);
// если активная сборка молчит дольше BUILD_STALE_MS — принудительное
// завершение с ошибкой (раньше «active» висело вечно и новые сборки
// отклонялись «уже выполняется»). Каждое событие дублируется в stdout —
// контейнерные логи диагностируются даже при заблокированной БД.
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
/** Предохранитель «вечной сборки»: нет признаков жизни N минут — аварийное завершение */
let BUILD_STALE_MS = 10 * 60_000

/** Только для тестов: подменить порог watchdog (мс) */
export function setBuildStaleMs(ms: number): void {
  BUILD_STALE_MS = ms
}

let state: BuildProgressState | null = null
let jobSeq = 0
let startedMs = 0
let updatedMs = 0

function nowIso(): string {
  return new Date().toISOString()
}

function consoleLog(msg: string): void {
  console.log(`[build ${nowIso().slice(11, 19)}] ${msg}`)
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
  startedMs = Date.now()
  updatedMs = startedMs
  consoleLog(`сборка набора правил запущена (origin=${origin}, jobId=${state.jobId})`)
  return state
}

/** Текущее состояние (или null — сборок в этом процессе ещё не было). */
export function getBuildProgress(): BuildProgressState | null {
  return state
}

/** Признак жизни долгой операции (сбрасывает watchdog) — вызывать из циклов сборки */
export function touchBuild(): void {
  if (state?.active) updatedMs = Date.now()
}

/** Есть ли незавершённая сборка прямо сейчас (watchdog: молчание = зависание). */
export function isBuildActive(): boolean {
  if (!state?.active) return false
  const idle = Date.now() - Math.max(startedMs, updatedMs)
  if (idle > BUILD_STALE_MS) {
    const err = `сборка прервана watchdog: признаков жизни нет ${(idle / 60_000).toFixed(0)} мин (стадия «${state.stage}») — операция считалась зависшей`
    failBuildProgress(err)
    return false
  }
  return true
}

/** Смена фазы сборки: код фазы + процент готовности (0..100). */
export function setBuildStage(stage: string, percent: number): void {
  if (!state) return
  state.stage = stage
  state.percent = Math.max(0, Math.min(100, Math.round(percent)))
  updatedMs = Date.now()
  consoleLog(`стадия ${stage} (${state.percent}%)`)
}

/** Добавить строку в журнал сборки (показывается в UI под прогрессбаром). */
export function addBuildLog(msg: string): void {
  if (!state) return
  state.log.push({ ts: nowIso(), msg: msg.slice(0, 500) })
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP)
  updatedMs = Date.now()
  // зеркало в stdout: единственная диагностика, когда БД/UI недоступны
  consoleLog(msg)
}

/** Успешное (или частично — export с ошибкой) завершение сборки. */
export function finishBuildProgress(result: NonNullable<BuildProgressState['result']>): void {
  if (!state) return
  state.active = false
  state.stage = 'done'
  state.percent = 100
  state.finishedAt = nowIso()
  state.result = result
  consoleLog(`сборка завершена за ${((Date.now() - startedMs) / 1000).toFixed(1)} с: ${result.ok ? `OK, ${result.total ?? 0} правил, файл ${result.fileName ?? '—'}` : `ошибка: ${result.error ?? '—'}`}`)
}

/** Аварийное завершение сборки (исключение/гейт). */
export function failBuildProgress(error: string): void {
  if (!state) return
  state.active = false
  state.finishedAt = nowIso()
  state.error = error.slice(0, 500)
  state.result = { ok: false, error: state.error }
  console.error(`[build ${nowIso().slice(11, 19)}] СБОЙ: ${state.error} (стадия ${state.stage}, прошло ${((Date.now() - startedMs) / 1000).toFixed(1)} с)`)
}

/** Только для тестов: обнулить состояние прогресса. */
export function resetBuildProgress(): void {
  state = null
}
