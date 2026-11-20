// DNS-фильтрация: изменение/удаление доменного источника (администратор)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  const { id } = await params
  const body = await req.json().catch(() => null)
  try {
    const data: Record<string, unknown> = {}
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled
    if (typeof body.priority === 'number') data.priority = Math.max(0, Math.min(10000, Math.floor(body.priority)))
    if (typeof body.category === 'string') data.category = body.category
    if (body.purpose === 'block' || body.purpose === 'allow') data.purpose = body.purpose
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
    if (typeof body.url === 'string') data.url = body.url.trim() || null
    if (typeof body.notes === 'string') data.notes = body.notes
    if (typeof body.notesEn === 'string') data.notesEn = body.notesEn
    if (typeof body.extraJson === 'string') data.extraJson = body.extraJson
    if (typeof body.format === 'string' && ['auto', 'adguard', 'hosts', 'plain'].includes(body.format)) data.format = body.format
    const src = await db.domainSource.update({ where: { id }, data })
    return NextResponse.json({ source: src })
  } catch (e) {
    return apiError(e)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  const { id } = await params
  try {
    await db.domainSource.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return apiError(e)
  }
}
