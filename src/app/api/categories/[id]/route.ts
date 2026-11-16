import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { log } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

/** PATCH /api/categories/:id — { enabled?, label?, hidden? } */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'categories', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const data: { enabled?: boolean; label?: string | null; hidden?: boolean } = {}
    if ('enabled' in body) data.enabled = !!body.enabled
    if ('hidden' in body) data.hidden = !!body.hidden
    if ('label' in body) data.label = body.label ? String(body.label).slice(0, 200) : null
    const cat = await db.category.update({ where: { id }, data })
    if ('enabled' in body) {
      await log(data.enabled ? 'info' : 'warn', 'system', `Категория «${cat.label ?? cat.name}» ${data.enabled ? 'включена' : 'выключена'} — правила не попадут в сборку`)
    }
    return NextResponse.json({ category: cat })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

/** DELETE /api/categories/:id — скрыть категорию из раздела (скан не воссоздаёт) */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'categories', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const { id } = await params
    const cat = await db.category.update({ where: { id }, data: { hidden: true } })
    await log('info', 'system', `Категория «${cat.label ?? cat.name}» скрыта (включение не меняется; вернуть — через PATCH hidden=false)`)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return apiError(e)
  }
}
