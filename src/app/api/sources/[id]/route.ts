import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fetchSourceById, log, getSetting, setSetting } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const data: Record<string, unknown> = {}
  for (const k of ['name', 'category', 'kind', 'url', 'authType', 'extraJson', 'priority', 'badge', 'notes']) {
    if (k in body) data[k] = body[k]
  }
  if ('enabled' in body) data.enabled = !!body.enabled
  if ('priority' in body) data.priority = Number(body.priority)
  try {
    const src = await db.source.update({ where: { id }, data })
    return NextResponse.json({ source: src })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

/**
 * DELETE /api/sources/:id            — в корзину (soft delete: deletedAt, enabled=false)
 * DELETE /api/sources/:id?purge=1    — удалить навсегда (вместе с правилами)
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const purge = req.nextUrl.searchParams.get('purge') === '1' || req.nextUrl.searchParams.get('purge') === 'true'
    const src = await db.source.findUnique({ where: { id } })
    if (!src) return NextResponse.json({ error: 'не найден' }, { status: 404 })

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

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // POST /api/sources/:id — синоним fetch для удобства
  try {
    const { id } = await params
    const res = await fetchSourceById(id)
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    return apiError(e)
  }
}
