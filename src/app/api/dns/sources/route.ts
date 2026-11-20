// DNS-фильтрация: источники доменных списков (управление — администратор).
// GET  /api/dns/sources — список источников + сводка
// POST /api/dns/sources — добавить источник { name, url, format?, category?, purpose?, priority?, enabled? }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { ensureDnsSeed } from '@/lib/engine/seed'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  try {
    await ensureDnsSeed()
    const sources = await db.domainSource.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] })
    return NextResponse.json({ sources })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  const body = await req.json().catch(() => null)
  if (!body?.name) return NextResponse.json({ error: 'Требуется поле name' }, { status: 400 })
  if (body.kind && !['url', 'local'].includes(body.kind)) {
    return NextResponse.json({ error: 'kind: url | local' }, { status: 400 })
  }
  const kind = body.kind ?? 'url'
  if (kind === 'url' && !body.url) return NextResponse.json({ error: 'Для сетевого источника нужен URL' }, { status: 400 })
  try {
    const src = await db.domainSource.create({
      data: {
        name: String(body.name),
        url: body.url ?? null,
        kind,
        format: ['auto', 'adguard', 'hosts', 'plain'].includes(body.format) ? body.format : 'auto',
        authType: ['none', 'basic', 'authkey'].includes(body.authType) ? body.authType : 'none',
        extraJson: body.extraJson ?? null,
        category: String(body.category ?? 'mixed'),
        purpose: body.purpose === 'allow' ? 'allow' : 'block',
        enabled: !!body.enabled,
        priority: Number(body.priority ?? 100),
        notes: body.notes ?? null,
        notesEn: body.notesEn ?? null,
        builtin: false,
      },
    })
    return NextResponse.json({ source: src })
  } catch (e) {
    return NextResponse.json({ error: `не удалось создать: ${(e as Error).message}` }, { status: 400 })
  }
}
