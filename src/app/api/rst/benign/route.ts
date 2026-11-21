// POST /api/rst/benign — RST Noise Control batch:
//   { action: 'batch', ioctype, values: [...] } → POST /v1/benign/batch/{ioctype}
//   { action: 'result', ioctype, token }        → POST /v1/benign/result/{ioctype}
// Пакетная проверка списка значений «доброкачественность» — контроль false
// positives при наполнении списков (например, перед включением доменов в белый
// список DNS-фильтрации). Только для администратора; тратит квоту ключа.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/engine/service'
import { rstBenignBatch, rstBenignBatchResult } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

const IOC_TYPES = ['ip', 'domain', 'url', 'hash'] as const

export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-benign', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => null) as { action?: string; ioctype?: string; values?: string[]; token?: string } | null
    const ioctype = (IOC_TYPES as readonly string[]).includes(body?.ioctype ?? '') ? body!.ioctype! : 'domain'
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — укажите его во вкладке «RST Cloud» меню «Интеграции»' }, { status: 400 })
    }
    if (body?.action === 'result') {
      const token = body?.token?.trim() ?? ''
      if (!token || token.length > 200) {
        return NextResponse.json({ ok: false, error: 'нужен token из ответа batch-запроса' }, { status: 400 })
      }
      const res = await rstBenignBatchResult(ioctype, token, key)
      return NextResponse.json({ ...res, ioctype })
    }
    // batch: 1..500 значений одного типа
    const values = (body?.values ?? []).map((v) => String(v).trim()).filter(Boolean)
    if (values.length === 0) {
      return NextResponse.json({ ok: false, error: 'нужен непустой список values' }, { status: 400 })
    }
    if (values.length > 500) {
      return NextResponse.json({ ok: false, error: `максимум 500 значений за запрос (передано ${values.length})` }, { status: 400 })
    }
    const res = await rstBenignBatch(ioctype, values, key)
    return NextResponse.json({ ...res, ioctype, count: values.length })
  } catch (e) {
    return apiError(e)
  }
}
