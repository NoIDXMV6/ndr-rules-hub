import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeed } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'sources', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    await ensureSeed()
    // источник виден всем авторизованным (общий конвейер сборки),
    // но управлять можно только своими (ownerId) или общими операционно
    const sources = await db.source.findMany({ orderBy: [{ enabled: 'desc' }, { priority: 'asc' }] })
    return NextResponse.json({ sources })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'sources', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  const body = await req.json().catch(() => null)
  if (!body?.name || !body?.category || !body?.kind) {
    return NextResponse.json({ error: 'Требуются поля: name, category, kind' }, { status: 400 })
  }
  if (!['ruleset', 'ip-list', 'domain-list', 'url-list'].includes(body.category)) {
    return NextResponse.json({ error: 'category: ruleset | ip-list | domain-list | url-list' }, { status: 400 })
  }
  if (!['url', 'tarball', 'local'].includes(body.kind)) {
    return NextResponse.json({ error: 'kind: url | tarball | local' }, { status: 400 })
  }
  if (body.kind !== 'local' && !body.url) {
    return NextResponse.json({ error: 'Для сетевого источника нужен URL' }, { status: 400 })
  }
  try {
    const src = await db.source.create({
      data: {
        name: String(body.name),
        category: body.category,
        kind: body.kind,
        url: body.url ?? null,
        authType: body.authType ?? 'none',
        extraJson: body.extraJson ?? null,
        enabled: body.enabled ?? false,
        priority: Number(body.priority ?? 100),
        badge: body.badge ?? null,
        notes: body.notes ?? null,
        notesEn: body.notesEn ?? null,
        builtin: false,
        // Enterprise: источник принадлежит создавшему пользователю («свои источники»)
        ownerId: g.user?.id ?? null,
      },
    })
    return NextResponse.json({ source: src })
  } catch (e) {
    return NextResponse.json({ error: `не удалось создать: ${(e as Error).message}` }, { status: 400 })
  }
}
