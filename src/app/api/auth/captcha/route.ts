// GET/POST /api/auth/captcha — выдать капчу для входа/регистрации (только
// Enterprise). Ответ одноразовый: после одной попытки ввода капча сгорает.
// Лимит выдачи на IP — 30 за 10 минут (анти-фарм сервисами подбора).
import { NextRequest, NextResponse } from 'next/server'
import { requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { issueCaptcha } from '@/lib/security/captcha'

export const dynamic = 'force-dynamic'

function issue(req: NextRequest): NextResponse {
  const gate = requireMultiUser()
  if (gate) return gate
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')
  const c = issueCaptcha(req)
  if (!c.ok) return NextResponse.json({ error: c.error }, { status: 429, headers: c.retryAfterSec ? { 'Retry-After': String(c.retryAfterSec) } : undefined })
  return NextResponse.json({ captchaId: c.id, svg: c.svg, expiresSec: c.expiresSec })
}

export async function GET(req: NextRequest) {
  return issue(req)
}

export async function POST(req: NextRequest) {
  return issue(req)
}
