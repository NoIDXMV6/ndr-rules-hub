// DNS-фильтрация: ручные решения по домену (DomainOverride, администратор).
// PUT    /api/dns/override — { domain, enabled, note?, force? }:
//        enabled=false — домен исключён из сборки;
//        enabled=true + force=true — принудительный блок поверх белого списка;
//        enabled=true без force — нейтральное состояние (нет влияния).
// DELETE /api/dns/override?domain=... — сбросить решение.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function PUT(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  const body = await req.json().catch(() => null)
  const domain = String(body?.domain ?? '').trim().toLowerCase()
  if (!domain || !/^[a-z0-9._-]+$/.test(domain)) {
    return NextResponse.json({ error: 'Требуется корректный domain' }, { status: 400 })
  }
  try {
    const enabled = !!body?.enabled
    const note = body?.force ? 'force' : typeof body?.note === 'string' ? body.note.slice(0, 200) : null
    const row = await db.domainOverride.upsert({
      where: { domain },
      create: { domain, enabled, note },
      update: { enabled, note },
    })
    return NextResponse.json({ override: row })
  } catch (e) {
    return apiError(e)
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  const domain = (req.nextUrl.searchParams.get('domain') ?? '').trim().toLowerCase()
  if (!domain) return NextResponse.json({ error: 'Требуется domain' }, { status: 400 })
  try {
    await db.domainOverride.deleteMany({ where: { domain } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return apiError(e)
  }
}
