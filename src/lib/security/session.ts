// ─────────────────────────────────────────────────────────────────────────────
// Сессии веб-интерфейса.
// Cookie ndrh_sid содержит случайный 256-битный токен; в БД — только его
// SHA-256. Cookie: HttpOnly (недоступна JS — защита от XSS-угона),
// SameSite=Lax (CSRF: куки не уходят с cross-site POST), Secure при HTTPS.
// Слайдинг: expiry продлевается при активности, неактивные сессии истекают.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { randomToken, sha256hex } from './ids'

export const SESSION_COOKIE = 'ndrh_sid'
const DEFAULT_TTL_HOURS = 24

export type SafeUser = {
  id: string
  email: string
  displayName: string
  role: 'admin' | 'user'
  status: 'pending' | 'active' | 'disabled'
  createdAt: Date
  lastLoginAt: Date | null
}

export interface AuthSession {
  sessionId: string
  user: SafeUser
  expiresAt: Date
}

export function sessionTtlMs(ttlHours?: number | null): number {
  const h = ttlHours && ttlHours >= 1 && ttlHours <= 24 * 30 ? ttlHours : DEFAULT_TTL_HOURS
  return h * 3600 * 1000
}

export async function createSession(userId: string, ip: string, userAgent: string, ttlHours?: number | null): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32)
  const expiresAt = new Date(Date.now() + sessionTtlMs(ttlHours))
  await db.session.create({
    data: { userId, tokenHash: sha256hex(token), ip: ip.slice(0, 100), userAgent: userAgent.slice(0, 300), expiresAt },
  })
  return { token, expiresAt }
}

export function cookieAttrs(expiresAt: Date, https: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: https,
    path: '/',
    expires: expiresAt,
  }
}

function toSafe(u: {
  id: string; email: string; displayName: string; role: string; status: string; createdAt: Date; lastLoginAt: Date | null
}): SafeUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role === 'admin' ? 'admin' : 'user',
    status: u.status === 'active' ? 'active' : u.status === 'disabled' ? 'disabled' : 'pending',
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  }
}

/** Найти сессию по cookie запроса. Проверяет срок, статус пользователя и продлевает TTL. */
export async function getSession(req: Request, ttlHours?: number | null): Promise<AuthSession | null> {
  const cookie = req.headers.get('cookie') ?? ''
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  if (!m) return null
  const token = m[1]
  if (!token || token.length < 20) return null

  const row = await db.session.findUnique({
    where: { tokenHash: sha256hex(token) },
    include: { user: true },
  })
  if (!row) return null
  if (row.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: row.id } }).catch(() => undefined)
    return null
  }
  if (row.user.status !== 'active') return null // disabled/pending — сессия недействительна

  // слайдинг-продление: раз в минуту активности двигаем expiry вперёд
  const newExpires = new Date(Date.now() + sessionTtlMs(ttlHours))
  if (newExpires.getTime() - row.expiresAt.getTime() > 60000) {
    await db.session.update({ where: { id: row.id }, data: { expiresAt: newExpires, lastSeenAt: new Date() } }).catch(() => undefined)
  }
  return { sessionId: row.id, user: toSafe(row.user), expiresAt: newExpires }
}

export async function destroySession(req: Request): Promise<void> {
  const cookie = req.headers.get('cookie') ?? ''
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  if (!m) return
  await db.session.delete({ where: { tokenHash: sha256hex(m[1]) } }).catch(() => undefined)
}

/** https-детект для флага Secure у cookie (за прокси смотрим на x-forwarded-proto) */
export function requestIsHttps(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto')
  if (proto) return proto.split(',')[0]?.trim() === 'https'
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}
