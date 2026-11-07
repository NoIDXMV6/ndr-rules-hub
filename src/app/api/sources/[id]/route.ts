import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fetchSourceById } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const data: Record<string, unknown> = {}
  for (const k of ['name', 'category', 'kind', 'url', 'authType', 'extraJson', 'priority', 'badge', 'notes']) {
    if (k in body) data[k] = body[k]
  }
  if ('enabled' in body) data.enabled = !!body.enabled
  if ('priority' in body) data.priority = Number(body.priority)
  try {
    const src = await db.source.update({ where: { id }, data })
    return NextResponse.json({ source: src })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const src = await db.source.findUnique({ where: { id } })
    if (!src) return NextResponse.json({ error: 'не найден' }, { status: 404 })
    if (src.builtin) return NextResponse.json({ error: 'встроенный источник нельзя удалить — его можно отключить' }, { status: 400 })
    await db.source.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // POST /api/sources/:id — синоним fetch для удобства
  try {
    const { id } = await params
    const res = await fetchSourceById(id)
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    return apiError(e)
  }
}
