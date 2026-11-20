// DNS-фильтрация: сборка списка заблокированных доменов (администратор).
// POST /api/dns/build — запустить сборку фоном; GET /api/dns/build — последняя сборка
// и файлы каталога экспорта DNS (зеркало GET /api/build + PUT /api/export).
// GET /api/dns/build/progress — прогрессбар и журнал (по аналогии с /api/build/progress).
import { NextRequest, NextResponse } from 'next/server'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { buildDomainList, lastDomainBuild, listDnsExportFiles } from '@/lib/engine/dns-service'

export const dynamic = 'force-dynamic'
export const maxDuration = 3600

export async function POST(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns-build', rule: { limit: 10, windowMs: 600_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  try {
    // сборка фоном: клиент опрашивает /api/dns/build/progress
    void buildDomainList('manual').catch(() => undefined)
    return NextResponse.json({ ok: true, started: true })
  } catch (e) {
    return apiError(e)
  }
}

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  try {
    const [build, files] = await Promise.all([lastDomainBuild(), listDnsExportFiles()])
    return NextResponse.json({ build, files })
  } catch (e) {
    return apiError(e)
  }
}
