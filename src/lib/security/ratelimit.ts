// ─────────────────────────────────────────────────────────────────────────────
// Ограничение частоты запросов (rate limiting) — скользящее окно в памяти.
// Назначение: защита от перебора (брутфорса) ключей/паролей и от всплесков
// нагрузки (L7 flood). Ключ — «scope:ip», лимит настраивается на вызов.
// Счётчики живут в памяти процесса: перезапуск контейнера их сбрасывает;
// для сетевого экранирования при настоящем DDoS см. раздел «Защита» в README
// (Caddy rate_limit / nftables перед контейнером).
//
// Поведение при превышении: окно не закрывается до истечения windowMs с момента
// первого запроса в нём; при blockMs > 0 адрес дополнительно блокируется на
// blockMs после N-го лишнего запроса (прогрессивная кара для брутфорса).
// ─────────────────────────────────────────────────────────────────────────────

export interface RateRule {
  /** Максимальное число запросов за окно */
  limit: number
  /** Размер окна, мс */
  windowMs: number
  /** Блокировка адреса после превышения лимита, мс (0 — только окно) */
  blockMs?: number
}

export interface RateVerdict {
  ok: boolean
  /** Сколько запросов ещё можно в текущем окне (0 при отказе) */
  remaining: number
  /** Через сколько секунд можно повторить (для Retry-After) */
  retryAfterSec: number
}

const hits = new Map<string, number[]>()
const blockedUntil = new Map<string, number>()
let callCount = 0

function prune(now: number): void {
  // лёгкая уборка памяти: раз в 2000 вызовов выкидываем пустые адреса
  if (callCount % 2000 !== 0) return
  for (const [k, arr] of hits) {
    if (arr.length === 0) hits.delete(k)
    else if (blockedUntil.has(k) && (blockedUntil.get(k) ?? 0) < now && arr.length === 0) blockedUntil.delete(k)
  }
  for (const [k, until] of blockedUntil) if (until < now) blockedUntil.delete(k)
}

export function rateLimit(key: string, rule: RateRule): RateVerdict {
  const now = Date.now()
  callCount++
  prune(now)

  const blockTill = blockedUntil.get(key) ?? 0
  if (blockTill > now) {
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil((blockTill - now) / 1000) }
  }

  const windowStart = now - rule.windowMs
  const arr = (hits.get(key) ?? []).filter((t) => t > windowStart)

  if (arr.length >= rule.limit) {
    if (rule.blockMs && rule.blockMs > 0) blockedUntil.set(key, now + rule.blockMs)
    const oldest = arr[0] ?? now
    hits.set(key, arr)
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)) }
  }

  arr.push(now)
  hits.set(key, arr)
  return { ok: true, remaining: rule.limit - arr.length, retryAfterSec: 0 }
}

/** Сброс лимитов ключа (после успешного входа — чтобы честные попытки не копились) */
export function resetRate(key: string): void {
  hits.delete(key)
  blockedUntil.delete(key)
}

/** Адрес заблокирован за прошлые неудачи? Вернуть секунды до разблокировки (0 — нет) */
export function peekBlocked(key: string): number {
  const till = blockedUntil.get(key) ?? 0
  if (till <= Date.now()) return 0
  return Math.max(1, Math.ceil((till - Date.now()) / 1000))
}

/** Зарегистрировать неудачную попытку: счётчик в окне + кара blockMs при превышении */
export function recordFailure(key: string, rule: RateRule): RateVerdict {
  const now = Date.now()
  const windowStart = now - rule.windowMs
  const arr = (hits.get(key) ?? []).filter((t) => t > windowStart)
  arr.push(now)
  hits.set(key, arr)
  if (arr.length >= rule.limit && rule.blockMs && rule.blockMs > 0) {
    blockedUntil.set(key, now + rule.blockMs)
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil(rule.blockMs / 1000) }
  }
  return { ok: true, remaining: Math.max(0, rule.limit - arr.length), retryAfterSec: 0 }
}

/** Только для тестов: очистить всё состояние лимитера */
export function resetAllRates(): void {
  hits.clear()
  blockedUntil.clear()
  callCount = 0
}

/**
 * IP клиента. Адрес берётся из X-Forwarded-For (первый адрес добавляет
 * прокси — в поставке это Caddy; см. Caddyfile). Если заголовка нет —
 * соединение напрямую, используется X-Real-IP, затем локальный адрес.
 * ВНИМАНИЕ: порт приложения не следует выставлять наружу мимо прокси,
 * иначе злоумышленник может подделать X-Forwarded-For.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip')?.trim() || 'local'
}
