// DNS-фильтрация: загрузка одного доменного источника (администратор)
import { NextRequest, NextResponse } from 'next/server'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { fetchDomainSourceById } from '@/lib/engine/dns-service'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  const { id } = await params
  try {
    const res = await fetchDomainSourceById(id)
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    return apiError(e)
  }
}
