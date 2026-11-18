// POST /api/auth/login/reset-2fa — аварийный сброс 2FA при входе (только
// Enterprise). Случай: у администратора недоступен второй фактор (потерян
// телефон с приложением-аутентификатором, Telegram-бот не доставляет код,
// чат не привязан) — раньше единственным выходом был другой администратор,
// теперь администратор может восстановить доступ сам, войдя ИЗ ЛОКАЛЬНОЙ СЕТИ.
//
// Все условия обязательны (сервер проверяет каждое независимо):
//   1) действующий билет первого шага (cookie ndrh_mfa) — пароль уже введён;
//   2) учётная запись активна и имеет роль admin;
//   3) запрос с приватного (локального) адреса — isLanIp (RFC 1918, loopback,
//      link-local, CGNAT, ULA IPv6); с публичного адреса отказ всегда;
//   4) повторное подтверждение пароля в теле запроса;
//   5) жёсткий rate limit: 5 попыток за 5 минут → блок IP на 30 минут.
// После сброса 2FA (метод/секрет/код аннулируются) сразу выдаётся сессия.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { verifyPassword } from '@/lib/security/password'
import { verifyMfaTicket } from '@/lib/engine/mfa'
import { clientIp, peekBlocked, rateLimit, recordFailure } from '@/lib/security/ratelimit'
import { isLanIp } from '@/lib/security/lan'
import { audit } from '@/lib/security/audit'
import { finalizeLogin } from '../route'

export const dynamic = 'force-dynamic'

// жёстче, чем у обычного входа: процедура позволяет отключить второй фактор
const RESET_RULE = { limit: 5, windowMs: 5 * 60_000, blockMs: 30 * 60_000 }

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate
  const ip = clientIp(req)
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')

  const rl = rateLimit(`lan-2fa-reset:${ip}`, RESET_RULE)
  if (!rl.ok) {
    return NextResponse.json({ error: `Слишком много попыток — повторите через ${Math.ceil(rl.retryAfterSec / 60)} мин` }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } })
  }
  const blocked = peekBlocked(`lan-2fa-reset:${ip}`)
  if (blocked > 0) {
    return NextResponse.json({ error: `Слишком много попыток — повторите через ${Math.ceil(blocked / 60)} мин` }, { status: 429, headers: { 'Retry-After': String(blocked) } })
  }

  // 1) билет первого шага: пароль уже был введён и проверен (шаг 1 входа)
  const userId = await verifyMfaTicket(req, 'login')
  if (!userId) return jsonError(401, 'Билет входа истёк — начните вход заново')

  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user || user.status !== 'active') return jsonError(403, 'Учётная запись недоступна')

  // 2) только администратор
  if (user.role !== 'admin') {
    void audit('login_2fa_fail', { email: user.email, userId: user.id, ip, detail: 'аварийный сброс 2FA: пользователь не администратор' })
    return jsonError(403, 'Аварийный сброс 2FA доступен только администратору')
  }

  // 3) только из локальной сети (приватные адреса)
  if (!isLanIp(ip)) {
    void audit('login_2fa_fail', { email: user.email, userId: user.id, ip, detail: 'аварийный сброс 2FA отклонён: адрес не из локальной сети' })
    return jsonError(403, 'Сброс 2FA при входе доступен только из локальной сети (приватные адреса). Войдите с адреса 192.168.x.x / 10.x.x.x / 172.16–31.x.x или обратитесь к другому администратору.')
  }

  if (user.twoFactor === 'none') return jsonError(400, 'У этой учётной записи 2FA не включена — выполните вход без второго шага')

  // 4) повторное подтверждение пароля
  const body = await req.json().catch(() => null) as { password?: string } | null
  const password = String(body?.password ?? '')
  if (!password) return jsonError(400, 'Укажите пароль для подтверждения сброса')
  if (!verifyPassword(password, user.passwordHash)) {
    recordFailure(`lan-2fa-reset:${ip}`, RESET_RULE)
    void audit('login_fail', { email: user.email, userId: user.id, ip, detail: 'аварийный сброс 2FA из LAN: неверный пароль' })
    return NextResponse.json({ error: 'Неверный пароль' }, { status: 401 })
  }

  // сброс: метод, секрет TOTP и выпущенные коды аннулируются
  await db.user.update({
    where: { id: user.id },
    data: { twoFactor: 'none', totpSecret: null, verificationCode: null, verificationExpiresAt: null, verificationAttempts: 0 },
  })
  void audit('2fa_reset', { email: user.email, userId: user.id, ip, detail: 'аварийный сброс 2FA при входе из локальной сети (пароль подтверждён)' })

  // 5) сразу выдаём сессию — администратор уже подтвердил пароль дважды + билет + LAN
  return finalizeLogin(req, user.id, user.email, user.displayName, user.role, user.status)
}
