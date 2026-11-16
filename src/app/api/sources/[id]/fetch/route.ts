import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fetchSourceById } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'fetch', rule: { limit: 30, windowMs: 60_000, blockMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const { id } = await params
    const src = await db.source.findUnique({ where: { id } })
    if (!src) return NextResponse.json({ error: 'источник не найден' }, { status: 404 })
    const res = await fetchSourceById(id)
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    return apiError(e)
  }
}
