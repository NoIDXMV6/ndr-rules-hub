// RST CTI Assistant: AI-помощник по threat intelligence.
//   GET  /api/rst/assistant          → GET /v1/models (доступные модели)
//   POST /api/rst/assistant {model, messages[]} → POST /v1/chat/completions
// Только для администратора; тратит квоту ключа.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings } from '@/lib/engine/service'
import { rstModels, rstChat } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-assistant', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — укажите его во вкладке «RST Cloud» меню «Интеграции»' }, { status: 400 })
    }
    const res = await rstModels(key)
    return NextResponse.json(res)
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-assistant', rule: { limit: 20, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => null) as { model?: string; messages?: Array<{ role?: string; content?: string }> } | null
    const model = body?.model?.trim() || ''
    const messages = (body?.messages ?? [])
      .map((m) => ({ role: String(m.role ?? 'user').trim(), content: String(m.content ?? '').trim() }))
      .filter((m) => m.content && ['system', 'user', 'assistant'].includes(m.role))
    if (!model) return NextResponse.json({ ok: false, error: 'нужно поле model (см. GET /api/rst/assistant)' }, { status: 400 })
    if (messages.length === 0) return NextResponse.json({ ok: false, error: 'нужен непустой список messages' }, { status: 400 })
    if (messages.length > 20) return NextResponse.json({ ok: false, error: 'максимум 20 сообщений в истории' }, { status: 400 })
    const key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ RST Cloud не задан — укажите его во вкладке «RST Cloud» меню «Интеграции»' }, { status: 400 })
    }
    const res = await rstChat(model, messages, key)
    return NextResponse.json(res)
  } catch (e) {
    return apiError(e)
  }
}
