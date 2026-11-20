// Новый «пойнт» скачивания: список заблокированных доменов (DNS-фильтрация).
// GET /api/dns/export — последний собранный список (по аналогии с GET /api/export
// для правил Suricata). Аутентификация: персональный токен скачивания со scope
// «domains»/«both» (ndrt_…), глобальный ключ dnsServeToken, сессия веб-интерфейса;
// без ключей — открытая отдача (как и у правил, когда serveToken не задан).
// Перебор ключей отсекается rate-лимитом, отдача — через очередь загрузок.
import { NextRequest, NextResponse } from 'next/server'
import { serveDomainList } from '@/lib/engine/dns-serve'
import { type ServeResult } from '@/lib/engine/serve'
import { apiError } from '@/lib/api-error'
import { clientIp, rateLimit } from '@/lib/security/ratelimit'
import { withQueue, QueueFullError } from '@/lib/security/queue'
import { getSession } from '@/lib/security/session'

export const dynamic = 'force-dynamic'

function toResponse(res: ServeResult): NextResponse {
  const headers: Record<string, string> = {
    'Content-Type': res.contentType,
    'Cache-Control': 'no-store',
  }
  if (res.fileName) headers['Content-Disposition'] = `attachment; filename="${res.fileName}"`
  if (res.status === 429 && res.retryAfterSec) headers['Retry-After'] = String(res.retryAfterSec)
  if (Buffer.isBuffer(res.body)) return new NextResponse(new Uint8Array(res.body), { status: res.status, headers })
  return new NextResponse(res.body, { status: res.status, headers })
}

export async function GET(req: NextRequest) {
  const ip = clientIp(req)
  const rl = rateLimit(`dnsexport:${ip}`, { limit: 60, windowMs: 60_000, blockMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Слишком много запросов на скачивание — попробуйте позже' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }
  const session = await getSession(req).catch(() => null)
  try {
    const sp = req.nextUrl.searchParams
    const res = await withQueue('download', () =>
      serveDomainList({
        token: sp.get('token') ?? undefined,
        authHeader: req.headers.get('authorization'),
        ip,
        sessionUserId: session?.user.id,
      }),
    )
    return toResponse(res)
  } catch (e) {
    if (e instanceof QueueFullError) {
      return NextResponse.json({ error: e.message }, { status: 429, headers: { 'Retry-After': String(e.retryAfterSec) } })
    }
    return apiError(e)
  }
}
