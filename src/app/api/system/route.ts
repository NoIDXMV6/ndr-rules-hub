import { NextRequest, NextResponse } from 'next/server'
import { guard } from '@/lib/security/guard'
import { apiError } from '@/lib/api-error'
import { readSystemStats } from '@/lib/engine/monitor'
import { getCleanupStatus, runCleanup, cleanupTick, reinitCleanupScheduler } from '@/lib/engine/cleanup'
import { getNotifySettings } from '@/lib/engine/notify'
import { log } from '@/lib/engine/service'

export const dynamic = 'force-dynamic'

/** GET /api/system — сводка сервера (только администратор):
 *  CPU/память/диски/сеть/контейнеры/WireGuard + статус очистки диска. */
export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'system', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const [stats, cleanup, notify] = await Promise.all([
      readSystemStats(),
      getCleanupStatus(),
      getNotifySettings().catch(() => null),
    ])
    return NextResponse.json({
      ...stats,
      cleanup,
      notify: notify
        ? {
            telegram: { enabled: notify.notifyTgEnabled, configured: !!(notify.tgBotToken && notify.tgChatId) },
            gotify: { enabled: notify.notifyGotifyEnabled, configured: !!(notify.gotifyUrl && notify.gotifyToken) },
          }
        : null,
    })
  } catch (e) {
    return apiError(e)
  }
}

/** POST /api/system — действия очистки диска (только администратор):
 *  {action: 'cleanup-preview'} — dry-run: что будет удалено, без удаления;
 *  {action: 'cleanup-run'}     — реальная очистка по включённым шагам;
 *  {action: 'disk-check'}      — проверка порогов сейчас (уведомления/автоочистка);
 *  {action: 'reschedule'}      — перечитать cron очистки после смены настроек. */
export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'system', rule: { limit: 20, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => ({}))
    const action = body?.action
    if (action === 'cleanup-preview') {
      const report = await runCleanup({ dryRun: true })
      return NextResponse.json({ ok: true, report })
    }
    if (action === 'cleanup-run') {
      const report = await runCleanup({ dryRun: false, triggeredBy: 'manual' })
      return NextResponse.json({ ok: true, report })
    }
    if (action === 'disk-check') {
      const r = await cleanupTick('manual')
      return NextResponse.json({ ok: true, ...r })
    }
    if (action === 'reschedule') {
      await reinitCleanupScheduler()
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'action: cleanup-preview | cleanup-run | disk-check | reschedule' }, { status: 400 })
  } catch (e) {
    await log('error', 'cleanup', `Ошибка ручной очистки: ${(e as Error).message}`)
    return apiError(e)
  }
}
