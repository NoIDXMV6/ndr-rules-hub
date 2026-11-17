// POST /api/auth/login/verify — второй шаг входа (2FA): код из Telegram или
// TOTP. Требуется билет первого шага (cookie ndrh_mfa). Лимит: 10 попыток
// за 5 минут с IP; у кода — 5 неверных вводов и срок 5 минут.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { verifyMfaTicket } from '@/lib/engine/mfa'
import { verifyVerificationCode, verifyTotp } from '@/lib/engine/mfa'
import { clientIp, peekBlocked, rateLimit } from '@/lib/security/ratelimit'
import { audit } from '@/lib/security/audit'
import { finalizeLogin } from '../route'

export const dynamic = 'force-dynamic'

const VERIFY_RULE = { limit: 10, windowMs: 5 * 60_000, blockMs: 15 * 60_000 }

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate
  const ip = clientIp(req)
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')

  const rl = rateLimit(`login-verify:${ip}`, VERIFY_RULE)
  if (!rl.ok) {
    return NextResponse.json({ error: `Слишком много попыток — повторите через ${Math.ceil(rl.retryAfterSec / 60)} мин` }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } })
  }
  const blocked = peekBlocked(`login-verify:${ip}`)
  if (blocked > 0) {
    return NextResponse.json({ error: `Слишком много попыток — повторите через ${Math.ceil(blocked / 60)} мин` }, { status: 429, headers: { 'Retry-After': String(blocked) } })
  }

  const userId = await verifyMfaTicket(req, 'login')
  if (!userId) return jsonError(401, 'Второй шаг недоступен: билет истёк — начните вход заново')

  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user || user.status !== 'active') return jsonError(403, 'Учётная запись недоступна')

  const body = await req.json().catch(() => null) as { code?: string } | null
  const code = String(body?.code ?? '').trim()
  if (!code) return jsonError(400, 'Введите код подтверждения')

  let ok = false
  if (user.twoFactor === 'telegram') {
    const v = await verifyVerificationCode(user.id, code)
    ok = v.ok
    if (!v.ok) {
      void audit('login_2fa_fail', { email: user.email, userId: user.id, ip, detail: `telegram: ${v.error}` })
      return NextResponse.json({ error: v.error }, { status: 401 })
    }
  } else if (user.twoFactor === 'totp') {
    ok = verifyTotp(user.totpSecret ?? '', code)
    if (!ok) {
      void audit('login_2fa_fail', { email: user.email, userId: user.id, ip, detail: 'totp: неверный код' })
      return NextResponse.json({ error: 'Неверный код TOTP' }, { status: 401 })
    }
  } else {
    return jsonError(400, 'У этой учётной записи 2FA не включена — выполните вход без второго шага')
  }

  void audit('login_2fa_ok', { email: user.email, userId: user.id, ip, detail: user.twoFactor })
  return finalizeLogin(req, user.id, user.email, user.displayName, user.role, user.status)
}
