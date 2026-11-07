import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fetchSourceById } from '@/lib/engine/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const src = await db.source.findUnique({ where: { id } })
  if (!src) return NextResponse.json({ error: 'источник не найден' }, { status: 404 })
  const res = await fetchSourceById(id)
  return NextResponse.json(res, { status: res.ok ? 200 : 400 })
}
