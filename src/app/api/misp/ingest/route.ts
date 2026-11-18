import { NextRequest, NextResponse } from 'next/server'
import { guard } from '@/lib/security/guard'
import { apiError } from '@/lib/api-error'
import { getSetting } from '@/lib/engine/service'
import { ingestToMisp } from '@/lib/engine/misp-connectors'
import { safeEqual } from '@/lib/security/ids'

export const dynamic = 'force-dynamic'

/** POST /api/misp/ingest — универсальный webhook-приёмник событий в MISP.
 *  Для источников без готового коннектора (uuWAF и другие WAF, скрипты,
 *  интеграционные обёртки): POST с заголовком «x-ingest-token» (или ?token=).
 *
 *  Тело (JSON):
 *    {
 *      "source": "uuwaf",                      // тег источника (опц., по умолч. webhook)
 *      "info":   "uuWAF: SQL-инъекция",        // заголовок события (опц.)
 *      "type":   "ip-src",                     // тип по умолчанию для values (опц.)
 *      "values": ["203.0.113.7", {"type":"url","value":"https://…","comment":"SQLi"}],
 *      "text":   "детали атаки",               // текстовый атрибут (опц.)
 *      "tags":   ["uuwaf", "sqli"]             // доп. теги (опц.)
 *    }
 *  Ответ: {ok, eventId, count} — событие создаётся в MISP по связи
 *  «Интеграции → MISP» (URL + API-ключ). Аутентификация: только токен
 *  приёмника (mispIngestToken) — работает и в Enterprise без сессии. */
export async function POST(req: NextRequest) {
  const g = await guard(req, { allowAnonymous: true, rate: { key: 'misp-ingest', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const expected = await getSetting('mispIngestToken')
    if (!expected) {
      return NextResponse.json({ error: 'webhook-приёмник не включён: сгенерируйте токен в «Интеграции → MISP»' }, { status: 403 })
    }
    const url = new URL(req.url)
    const provided = req.headers.get('x-ingest-token') ?? url.searchParams.get('token') ?? ''
    if (!provided || !safeEqual(provided.trim(), expected)) {
      return NextResponse.json({ error: 'неверный x-ingest-token' }, { status: 401 })
    }
    const body = await req.json().catch(() => ({}))
    const r = await ingestToMisp(body, g.ip)
    return NextResponse.json(r, { status: r.ok ? 200 : 400 })
  } catch (e) {
    return apiError(e)
  }
}
