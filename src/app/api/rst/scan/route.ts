// RST Scan API: внешнее сканирование ресурса.
//   GET /api/rst/scan?kind=cs-beacon|ssl|favicon|html&target=<домен|IP|URL>
//   cs-beacon — Cobalt Strike beacon scan (метаданные beacon-конфига);
//   ssl       — SSL-сертификат хоста; favicon — favicon-хэш; html — тело страницы.
// Только для администратора; тратит квоту ключа.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/engine/service'
import { rstScan, RST_SCAN_KINDS, type RstScanKind } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-scan', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — укажите его во вкладке «RST Cloud» меню «Интеграции»' }, { status: 400 })
    }
    const sp = req.nextUrl.searchParams
    const kind = sp.get('kind') ?? ''
    if (!(RST_SCAN_KINDS as readonly string[]).includes(kind)) {
      return NextResponse.json({ ok: false, error: `kind — один из: ${RST_SCAN_KINDS.join(', ')}` }, { status: 400 })
    }
    const target = (sp.get('target') ?? '').trim()
    if (!target || target.length > 400) {
      return NextResponse.json({ ok: false, error: 'нужен target (домен/IP/URL, до 400 символов)' }, { status: 400 })
    }
    const res = await rstScan(kind as RstScanKind, target, key)
    return NextResponse.json(res)
  } catch (e) {
    return apiError(e)
  }
}
