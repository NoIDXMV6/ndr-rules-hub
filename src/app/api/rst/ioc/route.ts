// POST /api/rst/ioc — предложить индикатор для включения в базу RST Cloud
// (RST IoC Lookup: POST /v1/ioc). PUT — сообщить о false positive
// (индикатор доброкачественный, RST учитывает фидбек при пересчёте баллов).
// Только для администратора; тратит квоту ключа.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/engine/service'
import { rstIocSubmit, rstIocFalsePositive } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-ioc', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => null) as { value?: string; description?: string; falsePositive?: boolean } | null
    const value = body?.value?.trim() ?? ''
    if (!value || value.length > 400) {
      return NextResponse.json({ ok: false, error: 'нужно поле value (домен/IP/URL/хэш, до 400 символов)' }, { status: 400 })
    }
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — укажите его во вкладке «RST Cloud» меню «Интеграции»' }, { status: 400 })
    }
    const res = body?.falsePositive
      ? await rstIocFalsePositive(value, body?.description ?? '', key)
      : await rstIocSubmit(value, body?.description ?? '', key)
    return NextResponse.json({ ...res, value, falsePositive: !!body?.falsePositive })
  } catch (e) {
    return apiError(e)
  }
}

export async function PUT(req: NextRequest) {
  // PUT = репорт false positive (синоним POST с falsePositive: true)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const url = new URL(req.url)
  return POST(new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify({ ...body, falsePositive: true }),
    headers: { 'content-type': 'application/json' },
  }))
}
