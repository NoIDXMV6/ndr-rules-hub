import { NextResponse } from 'next/server'
import { buildFinal, exportLatestBuild, getSettings } from '@/lib/engine/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const build = await buildFinal('manual')
  if (!build.ok) return NextResponse.json(build, { status: 400 })
  let exportRes = null
  if (body?.export) {
    const s = await getSettings()
    if (s.clearndrExportMode !== 'file') exportRes = await exportLatestBuild()
    else exportRes = { ok: true, detail: 'файл готов к скачиванию/импорту' }
  }
  return NextResponse.json({ ...build, export: exportRes })
}
