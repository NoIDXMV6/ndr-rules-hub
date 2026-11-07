import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { exportLatestBuild } from '@/lib/engine/service'
import { EXPORTS_DIR } from '@/lib/engine/fetcher'
import { promises as fs } from 'fs'
import path from 'path'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'

/** GET /api/export — скачать последний итоговый файл */
export async function GET() {
  try {
    const build = await db.build.findFirst({ orderBy: { createdAt: 'desc' } })
    if (!build) return NextResponse.json({ error: 'нет сборок' }, { status: 404 })
    try {
      const content = await fs.readFile(build.filePath)
      return new NextResponse(new Uint8Array(content), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${build.fileName}"`,
        },
      })
    } catch {
      return NextResponse.json({ error: `файл не найден на диске: ${build.filePath}` }, { status: 404 })
    }
  } catch (e) {
    return apiError(e)
  }
}

/** POST /api/export — выгрузить в Clear NDR настроенным способом */
export async function POST(_req: NextRequest) {
  try {
    const res = await exportLatestBuild()
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    return apiError(e)
  }
}

/** PUT — список файлов в каталоге экспорта */
export async function PUT() {
  try {
    const files = await fs.readdir(EXPORTS_DIR)
    const out = []
    for (const f of files) {
      const st = await fs.stat(path.join(EXPORTS_DIR, f))
      out.push({ name: f, size: st.size, mtime: st.mtime })
    }
    return NextResponse.json({ files: out })
  } catch {
    return NextResponse.json({ files: [] })
  }
}
