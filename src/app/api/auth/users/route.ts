// GET /api/auth/users — список пользователей (только администратор).
// PATCH /api/auth/users — настройки режима: { registrationOpen: boolean }.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guard } from '@/lib/security/guard'
import { setSetting } from '@/lib/engine/service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'users', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g

  const users = await db.user.findMany({
    orderBy: [{ createdAt: 'desc' }],
    select: {
      id: true, email: true, displayName: true, role: true, status: true,
      verifiedAt: true, verifiedBy: true, lastLoginAt: true, createdAt: true, lockedUntil: true,
      twoFactor: true, telegramUsername: true, telegramChatId: true,
      _count: { select: { sessions: true, tokens: true } },
    },
  })
  const registrationOpen = (await db.setting.findUnique({ where: { key: 'registrationOpen' } }))?.value !== 'false'
  return NextResponse.json({
    users: users.map(({ _count, ...u }) => ({ ...u, activeSessions: _count.sessions, tokens: _count.tokens })),
    registrationOpen,
  })
}

export async function PATCH(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'users', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g

  const body = await req.json().catch(() => null) as { registrationOpen?: boolean } | null
  if (body && typeof body.registrationOpen === 'boolean') {
    await setSetting('registrationOpen', body.registrationOpen ? 'true' : 'false')
  }
  return NextResponse.json({ ok: true, registrationOpen: (await db.setting.findUnique({ where: { key: 'registrationOpen' } }))?.value !== 'false' })
}
