// PATCH /api/tokens/:id — управление токеном скачивания (владелец или администратор).
// Действия: restore — вернуть ранее отозванный токен; delete — удалить навсегда
// (вместе со статистикой). Отзыв по-прежнему — DELETE /api/tokens/:id.
import { NextRequest, NextResponse } from 'next/server'
import { guard, requireMultiUser } from '@/lib/security/guard'
import { restoreDownloadToken, deleteDownloadToken } from '@/lib/security/download-token'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireMultiUser()
  if (gate) return gate
  const g = await guard(req, { rate: { key: 'tokens', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (!g.user) return NextResponse.json({ error: 'Требуется вход в систему' }, { status: 401 })

  const body = await req.json().catch(() => null) as { action?: string } | null
  const action = body?.action
  if (action !== 'restore' && action !== 'delete') {
    return NextResponse.json({ error: 'Неизвестное действие (доступны: restore, delete)' }, { status: 400 })
  }

  const { id } = await params
  const apply = <T,>(fn: (id: string, userId?: string) => Promise<T>) =>
    g.role === 'admin' ? fn(id) : fn(id, g.user!.id)
  const ok = action === 'restore' ? apply(restoreDownloadToken) : apply(deleteDownloadToken)
  if (!ok) {
    const what = action === 'restore' ? 'Токен не найден или не был отозван' : 'Токен не найден'
    return NextResponse.json({ error: what }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
