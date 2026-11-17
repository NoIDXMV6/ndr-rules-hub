// POST /api/auth/register/verify — второй шаг регистрации: подтверждение кода
// (Telegram или TOTP). Требуется билет первого шага (cookie ndrh_mfa,
// purpose=register). После успешного кода аккаунт активируется — администратор
// вручную активирует только в исключительных случаях (сброс 2FA и т.п.).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { verifyMfaTicket, verifyVerificationCode, verifyTotp, MFA_COOKIE } from '@/lib/engine/mfa'
import { clientIp, peekBlocked, rateLimit } from '@/lib/security/ratelimit'
import { audit } from '@/lib/security/audit'

export const dynamic = 'force-dynamic'

const VERIFY_RULE = { limit: 10, windowMs: 5 * 60_000, blockMs: 15 * 60_000 }

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate
  const ip = clientIp(req)
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')

  const rl = rateLimit(`register-verify:${ip}`, VERIFY_RULE)
  if (!rl.ok) {
    return NextResponse.json({ error: `Слишком много попыток — повторите через ${Math.ceil(rl.retryAfterSec / 60)} мин` }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } })
  }

  const userId = await verifyMfaTicket(req, 'register')
  if (!userId) return jsonError(401, 'Второй шаг недоступен: билет истёк — начните регистрацию заново')

  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) return jsonError(404, 'Регистрация не найдена')

  const body = await req.json().catch(() => null) as { code?: string } | null
  const code = String(body?.code ?? '').trim()
  if (!code) return jsonError(400, 'Введите код подтверждения')

  if (user.twoFactor === 'totp') {
    if (!verifyTotp(user.totpSecret ?? '', code)) {
      void audit('register_verify_fail', { email: user.email, userId: user.id, ip, detail: 'totp: неверный код' })
      return NextResponse.json({ error: 'Неверный код TOTP — проверьте приложение и введите текущий код' }, { status: 401 })
    }
  } else if (user.twoFactor === 'telegram') {
    const v = await verifyVerificationCode(user.id, code)
    if (!v.ok) {
      void audit('register_verify_fail', { email: user.email, userId: user.id, ip, detail: `telegram: ${v.error}` })
      return NextResponse.json({ error: v.error }, { status: 401 })
    }
  } else {
    return jsonError(400, 'У этой регистрации 2FA не выбрана')
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data: { status: 'active', verifiedAt: new Date(), verifiedBy: user.twoFactor === 'totp' ? 'totp-code' : 'telegram-code' },
  })
  void audit('verify', { email: user.email, userId: user.id, ip, detail: `аккаунт активирован кодом (${user.twoFactor})` })

  const res = NextResponse.json({
    ok: true,
    message: user.role === 'admin' ? 'Регистрация завершена — войдите в систему' : 'Регистрация завершена — войдите в систему с вашими учётными данными',
    user: { id: updated.id, email: updated.email, displayName: updated.displayName, role: updated.role, status: updated.status },
  })
  res.cookies.set(MFA_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return res
}
