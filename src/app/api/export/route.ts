import { NextRequest, NextResponse } from 'next/server'
import { exportLatestBuild } from '@/lib/engine/service'
import { serveBuild, type ServeResult } from '@/lib/engine/serve'
import { EXPORTS_DIR } from '@/lib/engine/fetcher'
import { promises as fs } from 'fs'
import path from 'path'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { clientIp, rateLimit } from '@/lib/security/ratelimit'
import { withQueue, QueueFullError } from '@/lib/security/queue'
import { globalDownloadBandwidth, throttledStream } from '@/lib/security/throttle'
import { getSetting } from '@/lib/engine/service'
import { getSession } from '@/lib/security/session'

export const dynamic = 'force-dynamic'

/** Ответ из ServeResult: Buffer → поток (при лимите канала — троттлированный) */
async function toResponse(res: ServeResult, ip: string): Promise<NextResponse> {
  const headers: Record<string, string> = {
    'Content-Type': res.contentType,
    // после каждой сборки файл по этому же URL другой
    'Cache-Control': 'no-store',
  }
  if (res.fileName) headers['Content-Disposition'] = `attachment; filename="${res.fileName}"`
  if (res.status === 429 && res.retryAfterSec) headers['Retry-After'] = String(res.retryAfterSec)

  // ограничение скорости отдачи (балансировка канала): 0 — без ограничения
  const kbps = parseInt(await getSetting('downloadBandwidthKbps'), 10) || 0
  if (res.status === 200 && kbps > 0 && Buffer.isBuffer(res.body)) {
    const stream = throttledStream(res.body, globalDownloadBandwidth(kbps))
    return new NextResponse(stream, { status: res.status, headers })
  }
  const body = Buffer.isBuffer(res.body) ? new Uint8Array(res.body) : Buffer.from(res.body, 'utf8')
  return new NextResponse(body, { status: res.status, headers })
}

/** GET /api/export — итоговый набор для URL-источника Clear NDR (PULL-схема).
 *  По умолчанию — одиночный .rules файл (datatype «sig»), ?archive=1 —
 *  tgz-архив по источникам (datatype «sigs»). Аутентификация (любой из
 *  способов): глобальный ключ serveToken, персональный токен скачивания
 *  (Enterprise), сессия веб-интерфейса. Отдача идёт через очередь загрузок
 *  с ограничением параллельности и (при настройке) через троттлинг канала. */
export async function GET(req: NextRequest) {
  const ip = clientIp(req)
  // всплески скачиваний с одного адреса отсекаются до чтения файлов с диска
  const rl = rateLimit(`export:${ip}`, { limit: 60, windowMs: 60_000, blockMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Слишком много запросов на скачивание — попробуйте позже' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  // сессия веб-интерфейса (если есть) — скачивание из кабинета без ключа
  const session = await getSession(req).catch(() => null)
  // рабочее пространство отдачи: обычный пользователь получает СВОЮ персональную
  // сборку (нет своей — фолбэк на системную), администратор/Community — системную;
  // персональный токен скачивания привязан к владельцу — та же логика в serveBuild
  const wsUserId = session?.user && session.user.role === 'user' ? session.user.id : null

  try {
    const sp = req.nextUrl.searchParams
    const res = await withQueue('download', () =>
      serveBuild({
        archive: !!sp.get('archive'),
        token: sp.get('token') ?? undefined,
        authHeader: req.headers.get('authorization'),
        ip,
        sessionUserId: session?.user.id,
        workspaceUserId: wsUserId,
      }),
    )
    return await toResponse(res, ip)
  } catch (e) {
    if (e instanceof QueueFullError) {
      return NextResponse.json({ error: e.message }, { status: 429, headers: { 'Retry-After': String(e.retryAfterSec) } })
    }
    return apiError(e)
  }
}

/** POST /api/export — выгрузить в Clear NDR настроенным способом */
export async function POST(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'export', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const res = await exportLatestBuild()
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    return apiError(e)
  }
}

/** PUT — список файлов в каталоге экспорта */
export async function PUT(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'export', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const files = await fs.readdir(EXPORTS_DIR)
    const out: Array<{ name: string; size: number; mtime: Date }> = []
    for (const f of files) {
      const st = await fs.stat(path.join(EXPORTS_DIR, f))
      out.push({ name: f, size: st.size, mtime: st.mtime })
    }
    return NextResponse.json({ files: out })
  } catch {
    return NextResponse.json({ files: [] })
  }
}
