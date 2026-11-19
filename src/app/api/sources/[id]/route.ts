import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fetchSourceById, log, getSetting, setSetting } from '@/lib/engine/service'
import { isSourceVisible } from '@/lib/engine/workspace'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * PATCH /api/sources/:id — правка источника / включение-выключение в рабочем пространстве.
 * Права (v1.27.0):
 *  • включение/выключение: администратор — Source.enabled (системное состояние);
 *    пользователь — SourceState СВОЕГО пространства (системные и опубликованные —
 *    только вкл/выкл у себя, как разрешено);
 *  • правка полей: администратор — любой источник (в т.ч. бейджи adminOnly);
 *    пользователь — только СВОИ (ownerId), включая бейджи и видимость
 *    (private/published — публикация своего источника).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'sources', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  const { id } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const src = await db.source.findUnique({ where: { id } })
  if (!src) return NextResponse.json({ error: 'источник не найден' }, { status: 404 })

  const isAdmin = g.role === 'admin' || !g.user // Community — полные права
  const uid = g.user?.id ?? null
  const own = isAdmin || (uid !== null && src.ownerId === uid)

  // включение/выключение — в рабочее пространство вызывающего
  if ('enabled' in body) {
    if (!isAdmin && !own && !isSourceVisible(src, 'user', uid)) {
      return NextResponse.json({ error: 'Источник недоступен в вашем рабочем пространстве' }, { status: 403 })
    }
    const enabled = !!body.enabled
    if (isAdmin) {
      await db.source.update({ where: { id }, data: { enabled } })
    } else {
      await db.sourceState.upsert({
        where: { userId_sourceId: { userId: uid!, sourceId: id } },
        create: { userId: uid!, sourceId: id, enabled },
        update: { enabled },
      })
    }
    delete body.enabled
    if (Object.keys(body).length === 0) {
      const updated = await db.source.findUnique({ where: { id } })
      return NextResponse.json({ source: updated ? { ...updated, enabled } : { id, enabled } })
    }
  }

  // правка полей — только свои (у админа — любые)
  if (!own) {
    return NextResponse.json({ error: 'Общий источник: доступно только включение/выключение в вашем рабочем пространстве' }, { status: 403 })
  }

  const data: Record<string, unknown> = {}
  for (const k of ['name', 'category', 'kind', 'url', 'authType', 'extraJson', 'priority', 'badge', 'badgeLabel', 'badgeColor', 'notes', 'notesEn']) {
    if (k in body) data[k] = body[k]
  }
  if ('visibility' in body) data.visibility = body.visibility === 'published' ? 'published' : 'private'
  // adminOnly — признак каталога: меняет только администратор
  if ('adminOnly' in body && isAdmin) data.adminOnly = !!body.adminOnly
  if ('priority' in body) data.priority = Number(body.priority)
  try {
    const updated = await db.source.update({ where: { id }, data })
    return NextResponse.json({ source: updated })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

/**
 * DELETE /api/sources/:id            — в корзину (soft delete: deletedAt, enabled=false)
 * DELETE /api/sources/:id?purge=1    — удалить навсегда (вместе с правилами)
 * Права: администратор — любой; пользователь — только свои источники.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'sources', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const { id } = await params
    const purge = req.nextUrl.searchParams.get('purge') === '1' || req.nextUrl.searchParams.get('purge') === 'true'
    const src = await db.source.findUnique({ where: { id } })
    if (!src) return NextResponse.json({ error: 'не найден' }, { status: 404 })
    // удалять можно только свои (администратор — любой, включая системные)
    if (g.user && g.user.role !== 'admin' && src.ownerId !== g.user.id) {
      return NextResponse.json({ error: 'Удалять можно только свои источники' }, { status: 403 })
    }

    if (purge) {
      // имя builtin запоминается, чтобы «докатка» каталога не создала его заново
      if (src.builtin) {
        const purged = new Set<string>(JSON.parse((await getSetting('purgedBuiltinSources')) || '[]') as string[])
        purged.add(src.name)
        await setSetting('purgedBuiltinSources', JSON.stringify([...purged]))
        await log('warn', 'system', `builtin-источник «${src.name}» удалён навсегда — каталог больше не будет его восстанавливать`)
      }
      await db.rule.deleteMany({ where: { sourceId: id } })
      await db.source.delete({ where: { id } })
      await log('info', 'system', `Источник «${src.name}» удалён навсегда (правила: ${src.ruleCount})`)
      return NextResponse.json({ ok: true, purged: true })
    }

    // в корзину: выключаем и помечаем (правила остаются в БД для восстановления)
    await db.source.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    })
    await log('info', 'system', `Источник «${src.name}» перемещён в корзину (правила сохранены, восстановление — в разделе «Источники» → «Корзина»)`)
    return NextResponse.json({ ok: true, trashed: true })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // POST /api/sources/:id — синоним fetch для удобства.
  // Рабочие пространства: обновлять источник может администратор — любой,
  // пользователь — ТОЛЬКО свой (системные обновляются системой/по расписанию,
  // чужие опубликованные — их владельцем)
  const g = await guard(req, { rate: { key: 'fetch', rule: { limit: 30, windowMs: 60_000, blockMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const { id } = await params
    const src = await db.source.findUnique({ where: { id }, select: { id: true, ownerId: true } })
    if (!src) return NextResponse.json({ error: 'источник не найден' }, { status: 404 })
    const isAdmin = g.role === 'admin' || !g.user
    if (!isAdmin && src.ownerId !== g.user!.id) {
      return NextResponse.json({ error: 'Обновление доступно только владельцу источника — системные и опубликованные источники обновляются системой или владельцем' }, { status: 403 })
    }
    const res = await fetchSourceById(id, g.user?.id ?? null)
    // 429 — гейт частоты snort.org (15 минут): браузер/скрипты видят Retry-After
    const status = res.ok ? 200 : res.rateLimited ? 429 : 400
    return NextResponse.json(res, { status, headers: res.retryAfterSec ? { 'Retry-After': String(res.retryAfterSec) } : undefined })
  } catch (e) {
    return apiError(e)
  }
}
