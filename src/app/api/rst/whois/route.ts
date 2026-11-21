// GET /api/rst/whois?domain=X&variant=parsed|full|raw — RST Whois API.
// parsed (по умолчанию) — GET /v1/whois/{домен}; full — расширенные данные
// (/v1/whois/full/{домен}); raw — сырой ответ регистратора (/v1/whois/raw/…).
// Только для администратора; тратит квоту ключа.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/engine/service'
import { rstWhoisVariant } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-whois', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — укажите его во вкладке «RST Cloud» меню «Интеграции»' }, { status: 400 })
    }
    const domain = (req.nextUrl.searchParams.get('domain') ?? '').trim()
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) {
      return NextResponse.json({ ok: false, error: 'нужен домен (например, example.com)' }, { status: 400 })
    }
    const v = req.nextUrl.searchParams.get('variant') ?? 'parsed'
    const variant = v === 'full' || v === 'raw' ? v : 'parsed'
    const res = await rstWhoisVariant(domain, variant, key)
    return NextResponse.json(res)
  } catch (e) {
    return apiError(e)
  }
}
