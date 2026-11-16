// GET /api/auth/events — журнал событий безопасности (только администратор):
// регистрации, входы/отказы, верификации, срабатывания лимитов и очередей.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'events', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g

  const take = Math.min(parseInt(req.nextUrl.searchParams.get('take') ?? '100', 10) || 100, 500)
  const events = await db.authEvent.findMany({ orderBy: { ts: 'desc' }, take })
  return NextResponse.json({ events })
}
