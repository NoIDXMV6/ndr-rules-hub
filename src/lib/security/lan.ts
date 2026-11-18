// ─────────────────────────────────────────────────────────────────────────────
// Проверка «локального» адреса клиента: приватные диапазоны IPv4 (RFC 1918),
// loopback, link-local, CGNAT (100.64/10) и ULA/link-local IPv6.
// Используется для аварийного сброса 2FA администратором при входе из
// локальной сети: из интернета (публичный адрес) процедура недоступна.
//
// ВАЖНО: адрес передаётся из clientIp() (X-Forwarded-For прокси из поставки /
// X-Real-IP / 'local' для прямого соединения). Порт приложения нельзя
// выставлять наружу мимо прокси — иначе заголовок X-Forwarded-For подделывается
// (см. предупреждение в src/lib/security/ratelimit.ts).
// ─────────────────────────────────────────────────────────────────────────────

export function isLanIp(rawIp: string): boolean {
  const ip = String(rawIp ?? '').trim().toLowerCase()
  if (!ip || ip === 'local') return true // прямое соединение к порту приложения — с хоста
  const clean = ip.split('%')[0] // IPv6 с зоной (fe80::1%eth0) — зона не важна
  if (clean.includes(':')) return isLanV6(clean)
  return isLanV4(clean)
}

function isLanV4(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false // не IPv4 (публичный IPv6, хостнейм и пр.) — не локальный
  const oct = m.slice(1).map((x) => parseInt(x, 10))
  if (oct.some((n) => Number.isNaN(n) || n > 255)) return false
  const [a, b] = oct as [number, number, number, number]
  if (a === 10 || a === 127) return true // 10.0.0.0/8, 127.0.0.0/8 (loopback)
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 (Docker-сети по умолчанию)
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT (внутренние VPN/провайдер)
  return false
}

/** Развернуть IPv6 в 8 групп по 4 hex (::1 → 0000:...:0001); null — не IPv6 */
function expandV6(s: string): string | null {
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (groups.length !== 8) return null
  for (const g of groups) if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
  return groups.map((g) => g.padStart(4, '0')).join(':').toLowerCase()
}

function isLanV6(s: string): boolean {
  // IPv4-совместимая запись ::ffff:192.168.1.1 — проверяем вложенный IPv4
  const v4mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4mapped) return isLanV4(v4mapped[1])
  const full = expandV6(s)
  if (!full) return false
  if (full === '0000:0000:0000:0000:0000:0000:0000:0001') return true // ::1 loopback
  if (full.startsWith('0064:ff9b:')) return false // NAT64 — публичный адрес
  const first = parseInt(full.slice(0, 4), 16)
  // fe80::/10 link-local (0xfe80–0xfebf); fc00::/7 ULA (0xfc00–0xfdff)
  return (first >= 0xfe80 && first <= 0xfebf) || (first >= 0xfc00 && first <= 0xfdff)
}
