import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fetchSourceById, log, getSetting, setSetting } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * PATCH /api/sources/:id — правка источника.
 * Права: администратор — любой; пользователь — полный доступ к СВОИМ
 * (ownerId = user.id), у общих (ownerId = null, каталог) — только включение/
 * выключение (операция нужна для общего конвейера сборки).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { rate: { key: 'sources', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const src = await db.source.findUnique({ where: { id } })
  if (!src) return NextResponse.json({ error: 'источник не найден' }, { status: 404 })

  const own = !g.user || src.ownerId === g.user.id // admin (user=null) или владелец
  if (!own && 'enabled' in body) {
    // у общих источников пользователь может только включить/выключить
    const onlyEnabled = Object.keys(body).every((k) => k === 'enabled')
    if (!onlyEnabled) {
      return NextResponse.json({ error: 'Общий источник: доступно только включение/выключение' }, { status: 403 })
    }
  }

  const data: Record<string, unknown> = {}
  for (const k of ['name', 'category', 'kind', 'url', 'authType', 'extraJson', 'priority', 'badge', 'notes', 'notesEn']) {
    if (k in body) data[k] = body[k]
  }
  if ('enabled' in body) data.enabled = !!body.enabled
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
    if (g.user && src.ownerId !== g.user.id) {
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
  // POST /api/sources/:id — синоним fetch для удобства
  const g = await guard(req, { rate: { key: 'fetch', rule: { limit: 30, windowMs: 60_000, blockMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const { id } = await params
    const res = await fetchSourceById(id)
    // 429 — гейт частоты snort.org (15 минут): браузер/скрипты видят Retry-After
    const status = res.ok ? 200 : res.rateLimited ? 429 : 400
    return NextResponse.json(res, { status, headers: res.retryAfterSec ? { 'Retry-After': String(res.retryAfterSec) } : undefined })
  } catch (e) {
    return apiError(e)
  }
}
