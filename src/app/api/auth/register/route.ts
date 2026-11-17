// POST /api/auth/register — первый шаг регистрации (только Enterprise):
// капча + данные + выбор метода 2FA. Аккаунт создаётся в статусе pending и
// АКТИВИРУЕТСЯ только после подтверждения кода:
//   - telegram: код уходит ботом в чат пользователя (чат должен быть привязан
//     через /start — если нет, UI показывает deep-link, поллер пришлёт код
//     сразу после привязки);
//   - totp: сервер генерирует секрет и QR (otpauth://) — регистрация
//     завершается вводом текущего кода из приложения-аутентификатора.
// Исключение — bootstrap (первый пользователь): администратор, 2FA можно
// выбрать или пропустить (настроить позже в «Аккаунте»); TOTP подтверждается
// сразу, telegram — как у всех (код по /start).
// Второй шаг — POST /api/auth/register/verify с билетом ndrh_mfa.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { hashPassword, passwordIssues } from '@/lib/security/password'
import { verifyCaptcha } from '@/lib/security/captcha'
import { clientIp, rateLimit, resetRate } from '@/lib/security/ratelimit'
import { generateTotpSecret, otpauthUri, totpQrDataUrl, issueMfaTicket, MFA_COOKIE, mfaCookieAttrs, issueVerificationCode } from '@/lib/engine/mfa'
import { getBotUsername, botDeepLink } from '@/lib/engine/telegram'
import { requestIsHttps } from '@/lib/security/session'
import { audit } from '@/lib/security/audit'

export const dynamic = 'force-dynamic'

const REG_RULE = { limit: 5, windowMs: 3_600_000, blockMs: 3_600_000 }
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/
const TG_USER_RE = /^[a-zA-Z0-9_]{4,32}$/

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate

  const ip = clientIp(req)
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')
  const rl = rateLimit(`register:${ip}`, REG_RULE)
  if (!rl.ok) {
    void audit('ratelimit', { ip, detail: 'register: всплеск регистраций' })
    return NextResponse.json(
      { error: 'Слишком много регистраций с этого адреса — повторите через час' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const body = await req.json().catch(() => null) as {
    email?: string; displayName?: string; password?: string
    twoFactor?: string; telegramUsername?: string
    captchaId?: string; captchaAnswer?: string
  } | null
  const email = String(body?.email ?? '').trim().toLowerCase()
  const displayName = String(body?.displayName ?? '').trim()
  const password = String(body?.password ?? '')
  const method = String(body?.twoFactor ?? 'none') as 'telegram' | 'totp' | 'none'

  // 0) капча — обязательна, одноразовая
  const cap = verifyCaptcha(String(body?.captchaId ?? ''), String(body?.captchaAnswer ?? ''))
  if (!cap.ok) return NextResponse.json({ error: cap.error, captchaFailed: true }, { status: 400 })

  if (!['telegram', 'totp', 'none'].includes(method)) return jsonError(400, 'Метод 2FA: telegram | totp | none')
  if (method === 'none' && (await db.user.count()) > 0) {
    return jsonError(400, 'Двухфакторная аутентификация обязательна: выберите Telegram или TOTP')
  }

  let telegramUsername: string | null = null
  if (method === 'telegram') {
    telegramUsername = String(body?.telegramUsername ?? '').trim().replace(/^@/, '').toLowerCase()
    if (!TG_USER_RE.test(telegramUsername)) {
      return jsonError(400, 'Укажите имя в Telegram (username, 4–32 символа: буквы, цифры, подчёркивания) — на него придёт код')
    }
  }

  if (!EMAIL_RE.test(email) || email.length > 200) return jsonError(400, 'Некорректный email')
  if (!displayName || displayName.length > 100) return jsonError(400, 'Укажите имя (до 100 символов)')
  const issues = passwordIssues(password)
  if (issues.length) return jsonError(400, `Пароль слабый: ${issues.join(', ')}`)

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (existing) return jsonError(400, 'Пользователь с таким email уже зарегистрирован')
  if (telegramUsername) {
    const taken = await db.user.findFirst({ where: { telegramUsername }, select: { id: true, email: true } })
    if (taken) return jsonError(400, 'Этот Telegram-username уже привязан к другой учётной записи')
  }

  // регистрация закрывается администратором; bootstrap (первый админ) разрешён всегда
  const userCount = await db.user.count()
  const open = (await db.setting.findUnique({ where: { key: 'registrationOpen' } }))?.value !== 'false'
  if (!open && userCount > 0) return jsonError(403, 'Регистрация закрыта администратором')

  const isFirst = userCount === 0
  const bot = await getBotUsername().catch(() => null)

  // TOTP-секрет генерируем ДО записи в БД (нужен и в ответе, и в базе)
  const totpSecret = method === 'totp' ? generateTotpSecret() : null

  const user = await db.user.create({
    data: {
      email,
      displayName,
      passwordHash: hashPassword(password),
      role: isFirst ? 'admin' : 'user',
      status: isFirst ? 'active' : 'pending',
      verifiedAt: isFirst && method === 'none' ? new Date() : null,
      verifiedBy: isFirst && method === 'none' ? 'bootstrap' : null,
      twoFactor: method,
      telegramUsername,
      totpSecret,
    },
  })
  void audit('register', { email, userId: user.id, ip, detail: isFirst ? 'bootstrap: первый пользователь → администратор' : `ожидает кода подтверждения (${method})` })

  // ── единый ответ с билетом второго шага (cookie ndrh_mfa, 5 минут) ──
  const ticket = await issueMfaTicket('register', user.id)
  const payload: Record<string, unknown> = {
    ok: true,
    mfa: method,
    isFirst,
    botLink: botDeepLink(bot),
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, status: user.status },
  }
  const res = NextResponse.json(payload)
  res.cookies.set(MFA_COOKIE, ticket.ticket, mfaCookieAttrs(ticket.expiresSec, requestIsHttps(req)))

  if (method === 'totp') {
    const uri = otpauthUri(totpSecret as string, email)
    const qr = await totpQrDataUrl(uri).catch(() => null)
    return NextResponse.json(
      {
        ...payload,
        otpauth: uri,
        qrDataUrl: qr,
        manualKey: totpSecret,
        message: isFirst
          ? 'Первый пользователь создан как администратор. Введите код из приложения-аутентификатора для подтверждения TOTP'
          : 'Отсканируйте QR-код в приложении-аутентификаторе и введите текущий код для завершения регистрации',
      },
      { headers: res.headers },
    )
  }

  if (method === 'telegram') {
    // выпускаем код сразу: поллер доставит его сразу после /start (чат ещё не привязан)
    await issueVerificationCode(user.id)
    return NextResponse.json(
      {
        ...payload,
        telegramUsername,
        chatBound: false,
        message: isFirst
          ? 'Первый пользователь создан как администратор. Откройте бота и отправьте /start — придёт код подтверждения'
          : 'Код отправлен в Telegram. Если бот не может написать вам — откройте бота и отправьте /start, код придёт автоматически',
      },
      { headers: res.headers },
    )
  }

  // bootstrap без 2FA: билет не нужен — гасим его
  res.cookies.set(MFA_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  if (isFirst) resetRate(`login:ip:${ip}`)
  return res
}
