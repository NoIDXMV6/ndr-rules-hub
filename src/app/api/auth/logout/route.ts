// POST /api/auth/logout — выход: сессия удаляется, cookie сбрасывается.
import { NextRequest, NextResponse } from 'next/server'
import { requireMultiUser, sameOriginOk, jsonError } from '@/lib/security/guard'
import { clientIp } from '@/lib/security/ratelimit'
import { destroySession, getSession, SESSION_COOKIE } from '@/lib/security/session'
import { audit } from '@/lib/security/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')

  const ip = clientIp(req)
  const session = await getSession(req)
  await destroySession(req)
  if (session) void audit('logout', { userId: session.user.id, email: session.user.email, ip })

  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return res
}
