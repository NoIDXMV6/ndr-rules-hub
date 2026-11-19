import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeed } from '@/lib/engine/service'
import { isSourceVisible, effectiveEnabled } from '@/lib/engine/workspace'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'sources', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    await ensureSeed()
    // Рабочее пространство (v1.27.0): администратор видит всё (его состояние —
    // Source.enabled), пользователь — видимые ему источники: системные (кроме
    // adminOnly: ET Pro/MISP — секреты уровня системы), свои, опубликованные
    // другими; состояние пользователя — SourceState (без строки — Source.enabled).
    // Стабильный порядок по времени добавления.
    const role = g.role === 'admin' ? 'admin' : 'user'
    const uid = g.user?.id ?? null
    const all = await db.source.findMany({ orderBy: [{ createdAt: 'asc' }] })
    const states = role === 'user' && uid
      ? await db.sourceState.findMany({ where: { userId: uid } })
      : []
    const stMap = new Map(states.map((st) => [st.sourceId, st]))
    const sources = all
      .filter((s) => isSourceVisible(s, role, uid))
      .map((s) => ({
        ...s,
        enabled: role === 'admin' ? s.enabled : effectiveEnabled(s, stMap.get(s.id)),
      }))
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
  if (!['ruleset', 'ip-list', 'domain-list', 'url-list', 'zeek-intel', 'misp'].includes(body.category)) {
    return NextResponse.json({ error: 'category: ruleset | ip-list | domain-list | url-list | zeek-intel | misp' }, { status: 400 })
  }
  if (!['url', 'tarball', 'local'].includes(body.kind)) {
    return NextResponse.json({ error: 'kind: url | tarball | local' }, { status: 400 })
  }
  if (body.kind !== 'local' && !body.url) {
    return NextResponse.json({ error: 'Для сетевого источника нужен URL' }, { status: 400 })
  }
  try {
    // adminOnly — признак каталога: задаётся только администратором
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
        badgeLabel: body.badgeLabel ?? null,
        badgeColor: body.badgeColor ?? null,
        notes: body.notes ?? null,
        notesEn: body.notesEn ?? null,
        builtin: false,
        // видимость своего источника: private (по умолчанию) | published (опубликован для других)
        visibility: body.visibility === 'published' ? 'published' : 'private',
        adminOnly: g.role === 'admin' ? !!body.adminOnly : false,
        // Enterprise: источник принадлежит создавшему пользователю («свои источники»)
        ownerId: g.user?.id ?? null,
      },
    })
    return NextResponse.json({ source: src })
  } catch (e) {
    return NextResponse.json({ error: `не удалось создать: ${(e as Error).message}` }, { status: 400 })
  }
}
