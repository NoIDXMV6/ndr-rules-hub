// DELETE /api/tokens/:id — отозвать токен скачивания (владелец или администратор).
import { NextRequest, NextResponse } from 'next/server'
import { guard, requireMultiUser } from '@/lib/security/guard'
import { revokeDownloadToken } from '@/lib/security/download-token'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
