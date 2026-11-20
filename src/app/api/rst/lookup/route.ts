// Проверка индикатора через RST Cloud: POST /api/rst/lookup { value, mode }
//   mode 'ioc' (по умолчанию) — RST IoC Lookup (GET /v1/ioc?value=…): балл,
//        теги/категории, описание, источники, резолвинг/whois;
//   mode 'benign' — RST Noise Control (GET /v1/benign/lookup?value=…):
//        считается ли значение доброкачественным (контроль false positives);
//   mode 'whois' — RST Whois API (GET /v1/whois/{домен}): регистрационные
//        данные домена.
// Только для администратора (ключ — секрет); каждый вызов тратит квоту
// ключа (по умолчанию 1000/день) — rate-лимит на эндпоинте.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/engine/service'
import { rstIocLookup, rstBenignLookup, rstWhois } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

const MODES = ['ioc', 'benign', 'whois'] as const

export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rstlookup', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => null) as { value?: string; mode?: string } | null
    const value = body?.value?.trim() ?? ''
    const mode = (body?.mode && (MODES as readonly string[]).includes(body.mode) ? body.mode : 'ioc') as typeof MODES[number]
    if (!value || value.length > 400) {
      return NextResponse.json({ ok: false, error: 'нужно поле value (домен/IP/URL/хэш, до 400 символов)' }, { status: 400 })
    }
    if (mode === 'whois' && !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value)) {
      return NextResponse.json({ ok: false, error: 'whois-проверка принимает только доменные имена' }, { status: 400 })
    }
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — введите его в «Настройки → Токены источников → RST Cloud»' }, { status: 400 })
    }
    const res = mode === 'benign'
      ? await rstBenignLookup(value, key)
      : mode === 'whois'
        ? await rstWhois(value, key)
        : await rstIocLookup(value, key)
    return NextResponse.json({ ...res, mode, value })
  } catch (e) {
    return apiError(e)
  }
}
