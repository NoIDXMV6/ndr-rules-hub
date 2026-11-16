import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { log, getSetting, setSetting } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'

/** POST /api/sources/:id/restore — восстановить источник из корзины */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const src = await db.source.findUnique({ where: { id } })
    if (!src) return NextResponse.json({ error: 'не найден' }, { status: 404 })
    if (!src.deletedAt) return NextResponse.json({ error: 'источник не в корзине' }, { status: 400 })

    // если имя занято другим источником — вернуть нельзя (уникальность)
    const nameTaken = await db.source.findFirst({ where: { name: src.name, id: { not: id }, deletedAt: null } })
    if (nameTaken) {
      return NextResponse.json({ error: `имя «${src.name}» занято другим источником — сначала удалите или переименуйте его` }, { status: 400 })
    }

    await db.source.update({
      where: { id },
      data: { deletedAt: null },
      // enabled остаётся false — пользователь сам включает после проверки
    })
    // на случай, если имя было в списке purged (удалённый builtin, восстановленный вручную)
    const purged = new Set<string>(JSON.parse((await getSetting('purgedBuiltinSources')) || '[]') as string[])
    if (purged.has(src.name)) {
      purged.delete(src.name)
      await setSetting('purgedBuiltinSources', JSON.stringify([...purged]))
    }
    await log('success', 'system', `Источник «${src.name}» восстановлен из корзины (выключен — включите вручную)`)
    return NextResponse.json({ ok: true, source: await db.source.findUnique({ where: { id } }) })
  } catch (e) {
    return apiError(e)
  }
}
