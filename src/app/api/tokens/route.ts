// Персональные токены скачивания (Enterprise): раздел «Аккаунт» → «Токены и доступ».
// GET  /api/tokens — свои токены (администратор видит все, с владельцами);
// POST /api/tokens — создать токен { name, ttlDays? } (полный токен в ответе
//                    показывается один раз); лимит 10 созданий в час с IP.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guard, requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { clientIp, rateLimit } from '@/lib/security/ratelimit'
import { createDownloadToken, normalizeTokenScope } from '@/lib/security/download-token'

export const dynamic = 'force-dynamic'

const CREATE_RULE = { limit: 10, windowMs: 3_600_000, blockMs: 3_600_000 }

export async function GET(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate
  const g = await guard(req, { rate: { key: 'tokens', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g

  const where = g.role === 'admin' ? {} : { userId: g.user!.id }
  const rows = await db.downloadToken.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { email: true, displayName: true } } },
  })
  return NextResponse.json({
    tokens: rows.map((t) => ({
      id: t.id, name: t.name, prefix: t.prefix, scope: t.scope, createdAt: t.createdAt, expiresAt: t.expiresAt,
      revokedAt: t.revokedAt, lastUsedAt: t.lastUsedAt, lastIp: t.lastIp,
      downloadCount: t.downloadCount, bytesServed: t.bytesServed,
      owner: t.user.email, ownerName: t.user.displayName, own: t.userId === g.user?.id,
    })),
  })
}

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')
  const ip = clientIp(req)
  const rl = rateLimit(`tokencreate:${ip}`, CREATE_RULE)
  if (!rl.ok) return NextResponse.json({ error: 'Слишком много создаваемых токенов — повторите через час' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } })

  const g = await guard(req, { rate: { key: 'tokens', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (!g.user) return jsonError(401, 'Требуется вход в систему')

  const body = await req.json().catch(() => null) as { name?: string; ttlDays?: number; scope?: string } | null
  const name = String(body?.name ?? '').trim() || 'Токен'
  const ttlDays = Number(body?.ttlDays ?? 0)
  // scope: rules (правила, дефолт) | domains (список доменов) | both (оба списка)
  const scope = normalizeTokenScope(body?.scope)
  const created = await createDownloadToken(g.user.id, name, ttlDays > 0 && ttlDays <= 365 ? Math.floor(ttlDays) : null, scope)
  return NextResponse.json({ ok: true, token: created })
}
