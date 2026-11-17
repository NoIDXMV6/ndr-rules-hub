import { NextRequest, NextResponse } from 'next/server'
import { guard } from '@/lib/security/guard'
import { apiError } from '@/lib/api-error'
import { sendTest } from '@/lib/engine/notify'
import { deployGotify, removeGotify, gotifyState } from '@/lib/engine/gotify-deploy'
import { checkReleaseBroadcast } from '@/lib/engine/telegram'
import { log } from '@/lib/engine/service'

export const dynamic = 'force-dynamic'

/** GET /api/notify — состояние собственного сервера Gotify (карточка настроек) */
export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'notify', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const state = await gotifyState()
    return NextResponse.json({ gotify: state })
  } catch (e) {
    return apiError(e)
  }
}

/** POST /api/notify — действия (только администратор):
 *  {action: 'test', channel: 'telegram'|'gotify'} — пробное сообщение в канал;
 *  {action: 'gotify-deploy', port?, domain?}      — развернуть свой сервер Gotify (docker);
 *  {action: 'gotify-remove'}                      — удалить развёрнутый контейнер. */
export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'notify', rule: { limit: 20, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => ({}))
    const action = body?.action
    if (action === 'test') {
      const channel = body.channel === 'gotify' ? 'gotify' : 'telegram'
      // Значения прямо из полей формы (UI «Теста» сначала сохраняет настройки, потом
      // передаёт их сюда): проверяется ровно то, что видно в интерфейсе, а не
      // устаревшие значения БД — иначе только что вставленный токен «не применяется».
      const raw = (typeof body.cfg === 'object' && body.cfg !== null ? body.cfg : {}) as Record<string, unknown>
      const str = (k: string): string | undefined => {
        const v = raw[k]
        return typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined
      }
      const pRaw = parseInt(String(raw.priority ?? ''), 10)
      const cfg = {
        url: str('url'),
        token: str('token'),
        chatId: str('chatId'),
        proxy: str('proxy'),
        apiBase: str('apiBase'),
        priority: Number.isFinite(pRaw) ? Math.min(Math.max(pRaw, 0), 10) : undefined,
      }
      const r = await sendTest(channel, cfg)
      await log(r.ok ? 'info' : 'error', 'notify', `Тест ${channel}: ${r.ok ? 'отправлено' : r.error}`)
      return NextResponse.json({ ...r })
    }
    if (action === 'gotify-deploy') {
      const port = parseInt(body.port, 10) || undefined
      const r = await deployGotify({ port, domain: typeof body.domain === 'string' ? body.domain : undefined })
      return NextResponse.json(r)
    }
    if (action === 'gotify-remove') {
      const r = await removeGotify()
      return NextResponse.json(r)
    }
    if (action === 'release-broadcast') {
      // принудительная рассылка уведомления о текущей версии всем аккаунтам
      // с привязанным Telegram (автоматическая — при смене версии на старте)
      const r = await checkReleaseBroadcast(true)
      return NextResponse.json({ ok: r.delivered > 0 || r.sent, ...r })
    }
    return NextResponse.json({ error: 'action: test | gotify-deploy | gotify-remove | release-broadcast' }, { status: 400 })
  } catch (e) {
    return apiError(e)
  }
}
