import { NextRequest, NextResponse } from 'next/server'
import { getSettings, setSetting, reinitScheduler } from '@/lib/engine/service'
import { reinitCleanupScheduler } from '@/lib/engine/cleanup'
import { reinitTelegramPoller } from '@/lib/engine/telegram'
import { apiError } from '@/lib/api-error'
import { guard, sanitizeSettings } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'settings', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    // секреты (serveToken, oinkcode, Auth-Key abuse.ch, токен Scirius) — только админу
    return NextResponse.json({ settings: sanitizeSettings(await getSettings(), g.role) })
  } catch (e) {
    return apiError(e)
  }
}

export async function PUT(req: NextRequest) {
  // в Enterprise настройки меняет только администратор (у пользователя нет вкладки «Настройки»)
  const g = await guard(req, { admin: true, rate: { key: 'settings', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'нужен объект {key: value}' }, { status: 400 })
    for (const [k, v] of Object.entries(body)) {
      await setSetting(k, String(v))
    }
    await reinitScheduler()
    await reinitCleanupScheduler().catch(() => undefined) // cron очистки диска — тоже по настройкам
    await reinitTelegramPoller().catch(() => undefined) // бот для 2FA/рассылок — перечитать токен
    return NextResponse.json({ ok: true, settings: await getSettings() })
  } catch (e) {
    return apiError(e)
  }
}
