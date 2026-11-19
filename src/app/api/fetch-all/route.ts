import { NextResponse } from 'next/server'
import { fetchAllSources } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { withQueue, QueueFullError } from '@/lib/security/queue'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

export async function POST(req: Request) {
  const g = await guard(req, { rate: { key: 'fetchall', rule: { limit: 10, windowMs: 60_000, blockMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    // рабочее пространство: обычный пользователь обновляет только СВОИ
    // источники, администратор/Community — системный каталог (ownerId = null)
    const wsUserId = g.role === 'user' && g.user ? g.user.id : null
    const res = await withQueue('fetch', () => fetchAllSources('manual', wsUserId))
    return NextResponse.json(res)
  } catch (e) {
    if (e instanceof QueueFullError) return NextResponse.json({ error: e.message }, { status: 429, headers: { 'Retry-After': String(e.retryAfterSec) } })
    return apiError(e)
  }
}
