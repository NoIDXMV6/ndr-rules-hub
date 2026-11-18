// PATCH /api/tokens/:id — управление токеном скачивания (владелец или администратор).
// Действия: restore — вернуть ранее отозванный токен; delete — удалить навсегда
// (вместе со статистикой). Отзыв — DELETE /api/tokens/:id.
// РЕГРЕССИЯ v1.24.0: при добавлении PATCH обработчик DELETE (revoke) был
// случайно заменён — кнопка «Отозвать» получала HTTP 405 (в маршруте не было
// метода DELETE). Восстановлен: оба метода живут в одном файле.
import { NextRequest, NextResponse } from 'next/server'
import { guard, requireMultiUser } from '@/lib/security/guard'
import { revokeDownloadToken, restoreDownloadToken, deleteDownloadToken } from '@/lib/security/download-token'

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
  // ВАЖНО: apply возвращает Promise — его обязательно await. В v1.24.0 здесь
  // был `const ok = action === 'restore' ? apply(...) : apply(...)` без await:
  // Promise всегда truthy, if (!ok) никогда не срабатывал (404 не возвращался),
  // а NextResponse.json({ok:true}) уходил ДО завершения restore/delete —
  // эффект был гонкой, статус ответа врал.
  const ok = await (action === 'restore' ? apply(restoreDownloadToken) : apply(deleteDownloadToken))
  if (!ok) {
    const what = action === 'restore' ? 'Токен не найден или не был отозван' : 'Токен не найден'
    return NextResponse.json({ error: what }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // отозвать токен (владелец или администратор): revokedAt = now, токен больше
  // не принимает отдачу (возврат — PATCH {"action":"restore"})
  const gate = requireMultiUser()
  if (gate) return gate
  const g = await guard(req, { rate: { key: 'tokens', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (!g.user) return NextResponse.json({ error: 'Требуется вход в систему' }, { status: 401 })

  const { id } = await params
  const ok = g.role === 'admin' ? await revokeDownloadToken(id) : await revokeDownloadToken(id, g.user.id)
  if (!ok) return NextResponse.json({ error: 'Токен не найден' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
