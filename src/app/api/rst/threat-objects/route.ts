// RST Threat Library: курируемые объекты угроз (акторы, malware, кампании, TTP).
//   GET /api/rst/threat-objects?type=actors&limit=50&offset=0&filter=…&name=…&id=…
// Прокси на GET /v1/threat-objects/{type}. Только для администратора; тратит
// квоту ключа.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/engine/service'
import { rstThreatObjects, type RstObjectQuery } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-objects', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — укажите его во вкладке «RST Cloud» меню «Интеграции»' }, { status: 400 })
    }
    const sp = req.nextUrl.searchParams
    const type = (sp.get('type') ?? 'actors').trim()
    if (!/^[a-z_-]{1,40}$/i.test(type)) {
      return NextResponse.json({ ok: false, error: 'type — тип объектов Threat Library (actors/malware/campaigns/ttps)' }, { status: 400 })
    }
    const num = (k: string, max: number) => {
      const n = parseInt(sp.get(k) ?? '', 10)
      return Number.isFinite(n) && n > 0 ? Math.min(n, max) : undefined
    }
    const q: RstObjectQuery = {
      limit: num('limit', 200) ?? 50,
      offset: num('offset', 100_000),
      id: sp.get('id') ?? undefined,
      name: sp.get('name') ?? undefined,
      filter: sp.get('filter') ?? undefined,
      orderBy: sp.get('orderBy') ?? undefined,
      orderMode: sp.get('orderMode') === 'asc' ? 'asc' : sp.get('orderMode') === 'desc' ? 'desc' : undefined,
    }
    const res = await rstThreatObjects(type, q, key)
    return NextResponse.json(res)
  } catch (e) {
    return apiError(e)
  }
}
