// POST /api/auth/login — первый шаг входа (только Enterprise): капча + пароль.
// При включённой 2FA сессия НЕ выдаётся: возвращается билет второго шага
// (HttpOnly cookie ndrh_mfa, HMAC, 5 минут) и подсказка метода. Код
// подтверждается в POST /api/auth/login/verify.
// Анти-брутфорс, три независимых слоя:
//   1) rate limit по IP: 10 неудач за 5 минут → блок IP на 15 минут;
//   2) блокировка учётной записи: 5 неудач подряд → lockedUntil +15 минут;
//   3) единые тексты ошибок (не раскрываем существование email в системе).
// Плюс капча (одноразовая, сгорает после каждой попытки) и её лимит выдачи.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { verifyPassword } from '@/lib/security/password'
import { verifyCaptcha } from '@/lib/security/captcha'
import { clientIp, peekBlocked, rateLimit, recordFailure, resetRate } from '@/lib/security/ratelimit'
import { issueMfaTicket, MFA_COOKIE, mfaCookieAttrs } from '@/lib/engine/mfa'
import { getBotUsername, botDeepLink, sendTelegramText } from '@/lib/engine/telegram'
import { requestIsHttps } from '@/lib/security/session'
import { isLanIp } from '@/lib/security/lan'
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

  const body = await req.json().catch(() => null) as { email?: string; password?: string; captchaId?: string; captchaAnswer?: string } | null
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')
  if (!email || !password) return jsonError(400, 'Укажите email и пароль')

  // 0) капча: обязательна, одноразовая — после любой попытки сгорает
  const cap = verifyCaptcha(String(body?.captchaId ?? ''), String(body?.captchaAnswer ?? ''))
  if (!cap.ok) return NextResponse.json({ error: cap.error, captchaFailed: true }, { status: 400 })

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
    return NextResponse.json({ error: 'Учётная запись ожидает подтверждения — завершите верификацию кодом или обратитесь к администратору', pending: true }, { status: 403 })
  }
  if (user.status === 'disabled') {
    void audit('login_disabled', { email, userId: user.id, ip })
    return NextResponse.json({ error: 'Учётная запись отключена администратором' }, { status: 403 })
  }

  // пароль верен: счётчики неудач обнуляются; сессия — только после второго шага (если 2FA включена)
  resetRate(keyIp)
  resetRate(keyEmail)
  await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } })

  // аварийное восстановление доступа: администратор, вошедший из локальной сети,
  // может сбросить 2FA при входе (второй шаг недоступен/потерян). Клиент показывает
  // кнопку только по этому флагу — сервер на сбросе всё равно перепроверяет условия.
  const lanResetAvailable = user.role === 'admin' && isLanIp(ip)

  if (user.twoFactor === 'telegram') {
    if (!user.telegramChatId) {
      // чат не привязан — код доставить некуда; вход невозможен до /start боту или сброса 2FA администратором
      void audit('login_2fa_fail', { email, userId: user.id, ip, detail: 'telegram: чат не привязан' })
      const bot = await getBotUsername().catch(() => null)
      return NextResponse.json(
        {
          error: 'Telegram-чат не привязан (бот не может отправить вам код). Откройте бота и отправьте /start, затем повторите вход. Если бот недоступен — попросите администратора сбросить 2FA.',
          telegramStartRequired: true,
          botLink: botDeepLink(bot),
          lanResetAvailable,
        },
        { status: 400 },
      )
    }
    // выпуск и отправка кода
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    await db.user.update({
      where: { id: user.id },
      data: { verificationCode: code, verificationExpiresAt: new Date(Date.now() + 5 * 60_000), verificationAttempts: 0 },
    })
    const sent = await sendTelegramText(user.telegramChatId, `Код входа NDR Rules Hub: ${code}\n(действует 5 минут; вы входите с адреса ${ip})`)
    void audit('login_2fa', { email, userId: user.id, ip, detail: sent.ok ? 'код входа отправлен в Telegram' : `ошибка доставки: ${sent.error}` })
    const ticket = await issueMfaTicket('login', user.id)
    const res = NextResponse.json(
      sent.ok
        ? { ok: true, mfa: 'telegram', sent: true, lanResetAvailable }
        : { ok: true, mfa: 'telegram', sent: false, error: `Бот не смог доставить код: ${sent.error}. Проверьте, что бот не заблокирован, или попросите администратора сбросить 2FA.`, lanResetAvailable },
    )
    res.cookies.set(MFA_COOKIE, ticket.ticket, mfaCookieAttrs(ticket.expiresSec, requestIsHttps(req)))
    return res
  }

  if (user.twoFactor === 'totp') {
    const ticket = await issueMfaTicket('login', user.id)
    void audit('login_2fa', { email, userId: user.id, ip, detail: 'ожидается код TOTP' })
    const res = NextResponse.json({ ok: true, mfa: 'totp', lanResetAvailable })
    res.cookies.set(MFA_COOKIE, ticket.ticket, mfaCookieAttrs(ticket.expiresSec, requestIsHttps(req)))
    return res
  }

  // 2FA не включена (bootstrap-администратор или аккаунт до настройки) — сразу сессия
  return finalizeLogin(req, user.id, user.email, user.displayName, user.role, user.status)
}

/** Общая выдача сессии (используется и первым шагом без 2FA, и verify-шагом) */
export async function finalizeLogin(req: NextRequest, userId: string, email: string, displayName: string, role: string, status: string) {
  const { createSession, cookieAttrs, SESSION_COOKIE } = await import('@/lib/security/session')
  const ip = clientIp(req)
  const ua = req.headers.get('user-agent') ?? ''
  const { token, expiresAt } = await createSession(userId, ip, ua, parseInt((await db.setting.findUnique({ where: { key: 'sessionTtlHours' } }))?.value ?? '', 10) || null)
  void audit('login_ok', { email, userId, ip })
  const res = NextResponse.json({
    ok: true,
    user: { id: userId, email, displayName, role, status },
  })
  res.cookies.set(SESSION_COOKIE, token, cookieAttrs(expiresAt, requestIsHttps(req)))
  res.cookies.set(MFA_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 }) // билет погашен
  return res
}
