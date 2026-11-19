// Сборка набора правил — асинхронная: POST запускает сборку фоном и сразу
// возвращает jobId; клиент опрашивает GET /api/build/progress и рисует
// прогрессбар с журналом сборки. Сборка — самая тяжёлая операция хаба
// (SQLite + слияние десятков тысяч правил + валидация): по одной за раз —
// очередь «build» (maxConcurrent=1); если сборка уже идёт (например, по cron),
// повторный POST возвращает её jobId, а не ставит дубликат в очередь.
import { NextResponse } from 'next/server'
import { buildFinal, exportLatestBuild, getSettings } from '@/lib/engine/service'
import { startBuildProgress, getBuildProgress, setBuildStage, addBuildLog, finishBuildProgress, failBuildProgress } from '@/lib/engine/build-progress'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { withQueue, QueueFullError } from '@/lib/security/queue'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

export async function POST(req: Request) {
  const g = await guard(req, { rate: { key: 'build', rule: { limit: 12, windowMs: 60_000, blockMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => ({}))
    const cur = getBuildProgress()
    if (cur?.active) {
      return NextResponse.json({ ok: true, jobId: cur.jobId, alreadyRunning: true, origin: cur.origin })
    }
    const job = startBuildProgress('manual')
    // запуск в фоне: ответ уходит сразу, статус — через GET /api/build/progress.
    // Рабочее пространство: обычный пользователь собирает СВОЙ персональный
    // набор (Build.userId), администратор/Community — системный (userId = null);
    // экспорт в Clear NDR — только для системной сборки
    const wsUserId = g.role === 'user' && g.user ? g.user.id : null
    void withQueue('build', async () => {
      try {
        const build = await buildFinal('manual', wsUserId)
        if (!build.ok) {
          // failBuildProgress уже вызван в buildFinal на гейтах — на всякий случай дубль
          failBuildProgress(build.error ?? 'ошибка сборки')
          return
        }
        let exportRes: { ok: boolean; error?: string; detail?: string; pushedTo?: string } | null = null
        if (body?.export && !wsUserId) {
          setBuildStage('export', 97)
          const s = await getSettings()
          if (s.clearndrExportMode !== 'file' && s.clearndrExportMode !== 'disabled') {
            addBuildLog(`Экспорт в Clear NDR (режим ${s.clearndrExportMode})…`)
            exportRes = await exportLatestBuild()
            addBuildLog(exportRes?.ok ? 'Экспорт выполнен' : `Ошибка экспорта: ${exportRes?.error ?? '—'}`)
          } else {
            exportRes = { ok: true, detail: 'файл готов к скачиванию/импорту' }
          }
        } else if (body?.export && wsUserId) {
          exportRes = { ok: true, detail: 'файл готов к скачиванию/импорту (персональная сборка)' }
        }
        finishBuildProgress({
          ok: true,
          total: build.total,
          fileName: build.fileName,
          changes: build.changes ?? null,
          unchanged: build.unchanged,
          export: exportRes,
        })
      } catch (e) {
        failBuildProgress(e instanceof Error ? e.message : String(e))
      }
    }).catch((e) => {
      // очередь (не сама сборка) отклонила запуск
      failBuildProgress(e instanceof Error ? e.message : String(e))
    })
    return NextResponse.json({ ok: true, jobId: job.jobId })
  } catch (e) {
    if (e instanceof QueueFullError) return NextResponse.json({ error: e.message }, { status: 429, headers: { 'Retry-After': String(e.retryAfterSec) } })
    return apiError(e)
  }
}
