import { NextResponse } from 'next/server'
import { buildFinal, exportLatestBuild, getSettings } from '@/lib/engine/service'
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
    // сборка — самая тяжёлая операция (SQLite + валидация Suricata): одна за раз,
    // лишние клики ждут в очереди или получают 429 вместо дублей сборки
    const build = await withQueue('build', () => buildFinal('manual'))
    if (!build.ok) return NextResponse.json(build, { status: 400 })
    let exportRes: { ok: boolean; error?: string; detail?: string; pushedTo?: string } | null = null
    if (body?.export) {
      const s = await getSettings()
      if (s.clearndrExportMode !== 'file' && s.clearndrExportMode !== 'disabled') exportRes = await exportLatestBuild()
      else exportRes = { ok: true, detail: 'файл готов к скачиванию/импорту' }
    }
    return NextResponse.json({ ...build, export: exportRes })
  } catch (e) {
    if (e instanceof QueueFullError) return NextResponse.json({ error: e.message }, { status: 429, headers: { 'Retry-After': String(e.retryAfterSec) } })
    return apiError(e)
  }
}
