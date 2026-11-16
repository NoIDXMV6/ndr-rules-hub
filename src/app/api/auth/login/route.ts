// POST /api/auth/login — вход в систему (только Enterprise).
// Анти-брутфорс, три независимых слоя:
//   1) rate limit по IP: 10 неудач за 5 минут → блок IP на 15 минут;
//   2) блокировка учётной записи: 5 неудач подряд → lockedUntil +15 минут;
//   3) единые тексты ошибок (не раскрываем существование email в системе).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { verifyPassword } from '@/lib/security/password'
import { clientIp, peekBlocked, rateLimit, recordFailure, resetRate } from '@/lib/security/ratelimit'
import { createSession, cookieAttrs, requestIsHttps, SESSION_COOKIE } from '@/lib/security/session'
import { audit } from '@/lib/security/audit'

export const dynamic = 'force-dynamic'

const LOGIN_RULE = { limit: 10, windowMs: 5 * 60_000, blockMs: 15 * 60_000 }
const MAX_FAILED = 5
const LOCK_MS = 15 * 60_000

// фиктивный хеш: у незнакомых email время ответа сопоставимо с реальной проверкой
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88)

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate

  const ip = clientIp(req)
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')

  const body = await req.json().catch(() => null) as { email?: string; password?: string } | null
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')
  if (!email || !password) return jsonError(400, 'Укажите email и пароль')

  const keyIp = `login:ip:${ip}`
  const keyEmail = `login:email:${email}`

  // 1) перебор с одного IP
  const blockedIp = peekBlocked(keyIp)
  if (blockedIp > 0) {
    void audit('ratelimit', { ip, detail: `login: блок IP за перебор (ещё ${blockedIp} с)` })
    return NextResponse.json(
      { error: `Слишком много попыток входа с этого адреса — повторите через ${Math.ceil(blockedIp / 60)} мин` },
      { status: 429, headers: { 'Retry-After': String(blockedIp) } },
    )
  }
  // и перебор конкретного email (распределённая атака с разных IP)
  const blockedEmail = peekBlocked(keyEmail)
  if (blockedEmail > 0) {
    void audit('ratelimit', { ip, detail: `login: блок email за перебор (ещё ${blockedEmail} с)` })
    return NextResponse.json(
      { error: `Слишком много неудачных попыток входа — повторите через ${Math.ceil(blockedEmail / 60)} мин` },
      { status: 429, headers: { 'Retry-After': String(blockedEmail) } },
    )
  }

  const user = await db.user.findUnique({ where: { email } })
  const fail = (detail: string) => {
    recordFailure(keyIp, LOGIN_RULE)
    recordFailure(keyEmail, LOGIN_RULE)
    void audit('login_fail', { email, userId: user?.id, ip, detail })
    return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 })
  }

  if (!user) {
    verifyPassword(password, DUMMY_HASH) // выравнивание времени ответа
    return fail('неизвестный email')
  }

  // 2) блокировка учётной записи после серии неудач
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    void audit('login_lock', { email, userId: user.id, ip, detail: `до ${user.lockedUntil.toISOString()}` })
    return NextResponse.json(
      { error: `Вход временно заблокирован после неудачных попыток — повторите через ${Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)} мин` },
      { status: 429 },
    )
  }

  // 3) проверка пароля
  if (!verifyPassword(password, user.passwordHash)) {
    const failed = user.failedLogins + 1
    const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null
    await db.user.update({ where: { id: user.id }, data: { failedLogins: failed, lockedUntil: lock } })
    if (lock) void audit('login_lock', { email, userId: user.id, ip, detail: `${failed} неудач подряд → блок на 15 мин` })
    return fail(`неверный пароль (подряд: ${failed})`)
  }

  // статус учётной записи
  if (user.status === 'pending') {
    void audit('login_pending', { email, userId: user.id, ip })
    return NextResponse.json({ error: 'Учётная запись ожидает верификации администратором', pending: true }, { status: 403 })
  }
  if (user.status === 'disabled') {
    void audit('login_disabled', { email, userId: user.id, ip })
    return NextResponse.json({ error: 'Учётная запись отключена администратором' }, { status: 403 })
  }

  // успех: счётчики неудач обнуляются, сессия создаётся
  resetRate(keyIp)
  resetRate(keyEmail)
  await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } })
  const ua = req.headers.get('user-agent') ?? ''
  const { token, expiresAt } = await createSession(user.id, ip, ua, parseInt((await db.setting.findUnique({ where: { key: 'sessionTtlHours' } }))?.value ?? '', 10) || null)
  void audit('login_ok', { email, userId: user.id, ip })

  const res = NextResponse.json({
    ok: true,
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, status: user.status },
  })
  res.cookies.set(SESSION_COOKIE, token, cookieAttrs(expiresAt, requestIsHttps(req)))
  return res
}
