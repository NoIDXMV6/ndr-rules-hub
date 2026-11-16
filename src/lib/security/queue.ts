// ─────────────────────────────────────────────────────────────────────────────
// Очередь запросов с ограничением параллельности (защита от перегрузки).
// Тяжёлые операции (сборка, загрузка источников, отдача файлов) выполняются
// ограниченным числом одновременно; лишние запросы ждут своей очереди,
// а при переполнении очереди или истечении времени ожидания получают
// честный 429 + Retry-After — вместо деградации всего процесса (L7 flood /
// медленные запросы не вымывают ресурсы у полезной работы).
// ─────────────────────────────────────────────────────────────────────────────

export class QueueFullError extends Error {
  retryAfterSec: number
  constructor(message: string, retryAfterSec: number) {
    super(message)
    this.name = 'QueueFullError'
    this.retryAfterSec = retryAfterSec
  }
}

export interface QueueCfg {
  /** Сколько задач выполняется одновременно */
  maxConcurrent: number
  /** Сколько задач может ждать в очереди (переполнение → мгновенный отказ) */
  maxWaiting: number
  /** Сколько мс задача может ждать начала (истекло → отказ с Retry-After) */
  maxWaitMs: number
}

const DEFAULTS: Record<string, QueueCfg> = {
  // отдача файлов правил: канал и диск — самый дефицитный ресурс
  download: { maxConcurrent: 2, maxWaiting: 16, maxWaitMs: 20000 },
  // сборка набора: SQLite (connection_limit=1) + валидация Suricata — по одной
  build: { maxConcurrent: 1, maxWaiting: 4, maxWaitMs: 5000 },
  // загрузка источников: сетевые таймауты, по одной на поток
  fetch: { maxConcurrent: 1, maxWaiting: 4, maxWaitMs: 5000 },
}

interface Slot {
  run: () => void
  fail: (e: QueueFullError) => void
  timer: ReturnType<typeof setTimeout>
}

const state = new Map<string, { running: number; waiting: Slot[] }>()

function getState(name: string) {
  let s = state.get(name)
  if (!s) {
    s = { running: 0, waiting: [] }
    state.set(name, s)
  }
  return s
}

/** Счётчик активных выполнений (для мониторинга/тестов) */
export function queueStats(name: string): { running: number; waiting: number } {
  const s = state.get(name)
  return { running: s?.running ?? 0, waiting: s?.waiting.length ?? 0 }
}

/** Перекрыть дефолт (например, настройкой из БД) */
export function queueConfig(name: string, override?: Partial<QueueCfg>): QueueCfg {
  return { ...DEFAULTS[name], ...override }
}

/**
 * Выполнить fn в очереди `name`. Если все слоты заняты — ждёт (FIFO) не дольше
 * maxWaitMs; при переполненной очереди или истечении ожидания — QueueFullError.
 */
export async function withQueue<T>(name: string, fn: () => Promise<T>, override?: Partial<QueueCfg>): Promise<T> {
  const cfg = queueConfig(name, override)
  const s = getState(name)

  if (s.running >= cfg.maxConcurrent || s.waiting.length > 0) {
    if (s.waiting.length >= cfg.maxWaiting) {
      throw new QueueFullError(`очередь «${name}» переполнена (${s.waiting.length} ожид.)`, Math.ceil(cfg.maxWaitMs / 1000))
    }
    await new Promise<void>((resolve, fail) => {
      const slot: Slot = {
        run: resolve,
        fail,
        timer: setTimeout(() => {
          const i = s.waiting.indexOf(slot)
          if (i >= 0) s.waiting.splice(i, 1)
          fail(new QueueFullError(`очередь «${name}»: время ожидания истекло (${cfg.maxWaitMs} мс)`, Math.ceil(cfg.maxWaitMs / 1000)))
        }, cfg.maxWaitMs),
      }
      s.waiting.push(slot)
    })
  }

  s.running++
  try {
    return await fn()
  } finally {
    s.running--
    const next = s.waiting.shift()
    if (next) {
      clearTimeout(next.timer)
      next.run()
    }
  }
}

/** Только для тестов: обнулить очереди */
export function resetQueues(): void {
  for (const s of state.values()) {
    for (const slot of s.waiting) clearTimeout(slot.timer)
    s.waiting = []
    s.running = 0
  }
}
