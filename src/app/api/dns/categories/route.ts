// DNS-фильтрация: категории доменных списков (администратор).
// GET   /api/dns/categories — категории со счётчиками доменов
// PATCH /api/dns/categories — { id, enabled?, hidden?, label? }
// POST  /api/dns/categories — { name, label? } — своя категория
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  try {
    const [rows, sources, countsSetting] = await Promise.all([
      db.domainCategory.findMany({ orderBy: { name: 'asc' } }),
      db.domainSource.groupBy({ by: ['category'], _count: { _all: true } }),
      db.setting.findUnique({ where: { key: 'dnsIfaroCategoryCounts' } }),
    ])
    let ifaroCounts: Record<string, number> = {}
    try {
      ifaroCounts = JSON.parse(countsSetting?.value ?? '{}') as Record<string, number>
    } catch { /* нет кэша — счётчики 0 до первого импорта */ }
    // ключи каталога: сумма domainCount источников категории
    const srcCounts = new Map(sources.map((s) => [s.category, s._count._all]))
    const categories = rows.map((c) => ({
      id: c.id, name: c.name, label: c.label, enabled: c.enabled, hidden: c.hidden,
      domains: c.name.startsWith('ifaro:')
        ? (ifaroCounts[c.name.split(':')[1]] ?? 0)
        : (srcCounts.get(c.name) ?? 0),
    }))
    return NextResponse.json({ categories })
  } catch (e) {
    return apiError(e)
  }
}

export async function PATCH(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  const body = await req.json().catch(() => null)
  if (!body?.id) return NextResponse.json({ error: 'Требуется id' }, { status: 400 })
  try {
    const data: Record<string, unknown> = {}
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled
    if (typeof body.hidden === 'boolean') data.hidden = body.hidden
    if (typeof body.label === 'string') data.label = body.label.trim() || null
    const row = await db.domainCategory.update({ where: { id: body.id }, data })
    return NextResponse.json({ category: row })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  const body = await req.json().catch(() => null)
  if (!body?.name?.trim()) return NextResponse.json({ error: 'Требуется name' }, { status: 400 })
  try {
    const row = await db.domainCategory.upsert({
      where: { name: body.name.trim() },
      create: { name: body.name.trim(), label: body.label ?? null },
      update: {},
    })
    return NextResponse.json({ category: row })
  } catch (e) {
    return apiError(e)
  }
}
