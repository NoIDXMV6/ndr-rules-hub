import { NextRequest, NextResponse } from 'next/server'
import { exportLatestBuild } from '@/lib/engine/service'
import { serveBuild } from '@/lib/engine/serve'
import { EXPORTS_DIR } from '@/lib/engine/fetcher'
import { promises as fs } from 'fs'
import path from 'path'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'

/** GET /api/export — итоговый набор для URL-источника Clear NDR (PULL-схема).
 *  По умолчанию — одиночный .rules файл (datatype «sig»), ?archive=1 —
 *  tgz-архив по источникам (datatype «sigs»). Защита: настройка serveToken —
 *  ключ в ?token= или заголовке Authorization (scirius отправляет authkey
 *  источника). */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const res = await serveBuild({
      archive: !!sp.get('archive'),
      token: sp.get('token') ?? undefined,
      authHeader: req.headers.get('authorization'),
    })
    const headers: Record<string, string> = {
      'Content-Type': res.contentType,
      'Cache-Control': 'no-store', // после каждой сборки файл по этому же URL другой
    }
    if (res.fileName) headers['Content-Disposition'] = `attachment; filename="${res.fileName}"`
    const body = Buffer.isBuffer(res.body) ? new Uint8Array(res.body) : Buffer.from(res.body, 'utf8')
    return new NextResponse(body, { status: res.status, headers })
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
