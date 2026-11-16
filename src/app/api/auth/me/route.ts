// GET /api/auth/me — текущее состояние аутентификации для UI.
// Возвращает: редакцию, статус входа, пользователя (без секретов) и
// флаги для экрана входа (нужен bootstrap-администратор, открыта ли регистрация).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { edition } from '@/lib/edition'
import { getSetting } from '@/lib/engine/service'
import { getSession } from '@/lib/security/session'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const ed = edition()
  if (ed !== 'enterprise') {
    return NextResponse.json({ edition: 'community', multiUser: false, authenticated: false, user: null, needsBootstrap: false })
  }
  const [session, userCount, open] = await Promise.all([
    getSession(req),
    db.user.count(),
    (async () => (await getSetting('registrationOpen')) !== 'false')(),
  ])
  return NextResponse.json({
    edition: 'enterprise',
    multiUser: true,
    authenticated: !!session,
    user: session ? { id: session.user.id, email: session.user.email, displayName: session.user.displayName, role: session.user.role, status: session.user.status } : null,
    needsBootstrap: userCount === 0,
    registrationOpen: open,
  })
}
