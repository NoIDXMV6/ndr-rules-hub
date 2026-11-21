// RST Report Hub: отчёты/бюллетени threat intelligence.
//   GET /api/rst/reports?startdate=YYYY-MM-DD                → GET /v1/reports
//   GET /api/rst/reports?report=<id>&format=json|stix|pdf    → GET /v1/reports/{id}/…
//   format=pdf — бинарный ответ проксируется как base64 (data URI собирает UI).
// Только для администратора; тратит квоту ключа.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/engine/service'
import { rstReports, rstReportFile } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

const FORMATS = ['json', 'stix', 'pdf'] as const

export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-reports', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — укажите его во вкладке «RST Cloud» меню «Интеграции»' }, { status: 400 })
    }
    const sp = req.nextUrl.searchParams
    const reportId = sp.get('report')?.trim() ?? ''
    if (reportId) {
      if (!/^[a-z0-9._-]{1,120}$/i.test(reportId)) {
        return NextResponse.json({ ok: false, error: 'некорректный идентификатор отчёта' }, { status: 400 })
      }
      const format = (FORMATS as readonly string[]).includes(sp.get('format') ?? '') ? sp.get('format') as typeof FORMATS[number] : 'json'
      const lang = (sp.get('lang') ?? 'eng').slice(0, 8)
      const res = await rstReportFile(reportId, format, lang, key)
      return NextResponse.json(res)
    }
    const startdate = (sp.get('startdate') ?? '').trim()
    if (startdate && !/^\d{4}-\d{2}-\d{2}$/.test(startdate)) {
      return NextResponse.json({ ok: false, error: 'startdate — в формате YYYY-MM-DD' }, { status: 400 })
    }
    const res = await rstReports(startdate, key)
    return NextResponse.json(res)
  } catch (e) {
    return apiError(e)
  }
}
