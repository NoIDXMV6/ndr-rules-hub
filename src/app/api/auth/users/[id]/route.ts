// PATCH  /api/auth/users/:id — верификация и управление учётной записью
//        (только администратор): verify | disable | enable | promote | demote.
// DELETE /api/auth/users/:id — удалить пользователя (его источники становятся
//        общими, сессии и токены удаляются каскадом).
// Защиты: нельзя отключить/разжаловать себя; в системе обязан остаться
// минимум один активный администратор.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guard } from '@/lib/security/guard'
import { audit } from '@/lib/security/audit'

export const dynamic = 'force-dynamic'

async function activeAdminCount(excludeId?: string): Promise<number> {
  const admins = await db.user.findMany({ where: { role: 'admin', status: 'active' }, select: { id: true } })
  return admins.filter((a) => a.id !== excludeId).length
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { admin: true, rate: { key: 'users', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  const { id } = await params
  const body = await req.json().catch(() => null) as { action?: string } | null
  const action = body?.action

  const target = await db.user.findUnique({ where: { id } })
  if (!target) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 })

  switch (action) {
    case 'verify': {
      if (target.status !== 'pending') return NextResponse.json({ error: 'Учётная запись не в статусе ожидания' }, { status: 400 })
      await db.user.update({ where: { id }, data: { status: 'active', verifiedAt: new Date(), verifiedBy: g.user!.id } })
      void audit('verify', { userId: id, email: target.email, ip: g.ip, detail: `верифицировал ${g.user!.email}` })
      break
    }
    case 'disable': {
      if (target.id === g.user!.id) return NextResponse.json({ error: 'Нельзя отключить собственную учётную запись' }, { status: 400 })
      if (target.role === 'admin' && (await activeAdminCount(id)) === 0) {
        return NextResponse.json({ error: 'В системе должен остаться хотя бы один активный администратор' }, { status: 400 })
      }
      await db.user.update({ where: { id }, data: { status: 'disabled' } })
      await db.session.deleteMany({ where: { userId: id } }) // немедленный выход
      void audit('disable', { userId: id, email: target.email, ip: g.ip })
      break
    }
    case 'enable': {
      await db.user.update({ where: { id }, data: { status: 'active', failedLogins: 0, lockedUntil: null } })
      void audit('enable', { userId: id, email: target.email, ip: g.ip })
      break
    }
    case 'promote': {
      if (target.role !== 'admin') {
        await db.user.update({ where: { id }, data: { role: 'admin' } })
        void audit('role_change', { userId: id, email: target.email, ip: g.ip, detail: '→ admin' })
      }
      break
    }
    case 'demote': {
      if (target.id === g.user!.id) return NextResponse.json({ error: 'Нельзя снять права с себя' }, { status: 400 })
      if (target.role === 'admin' && (await activeAdminCount(id)) === 0) {
        return NextResponse.json({ error: 'В системе должен остаться хотя бы один активный администратор' }, { status: 400 })
      }
      await db.user.update({ where: { id }, data: { role: 'user' } })
      void audit('role_change', { userId: id, email: target.email, ip: g.ip, detail: '→ user' })
      break
    }
    case 'reset-2fa': {
      // сброс 2FA: пользователь потерял доступ к Telegram/приложению — метод
      // выключается, привязки и секреты очищаются; дальнейшую настройку
      // пользователь делает сам в «Аккаунте»
      await db.user.update({
        where: { id },
        data: { twoFactor: 'none', totpSecret: null, verificationCode: null, verificationExpiresAt: null, verificationAttempts: 0 },
      })
      void audit('2fa_reset', { userId: id, email: target.email, ip: g.ip, detail: `2FA сброшена администратором ${g.user!.email}` })
      break
    }
    default:
      return NextResponse.json({ error: 'Действие: verify | disable | enable | promote | demote | reset-2fa' }, { status: 400 })
  }

  const updated = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, displayName: true, role: true, status: true, verifiedAt: true, lockedUntil: true },
  })
  return NextResponse.json({ ok: true, user: updated })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, { admin: true, rate: { key: 'users', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  const { id } = await params

  if (id === g.user!.id) return NextResponse.json({ error: 'Нельзя удалить собственную учётную запись' }, { status: 400 })
  const target = await db.user.findUnique({ where: { id } })
  if (!target) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 })
  if (target.role === 'admin' && (await activeAdminCount(id)) === 0) {
    return NextResponse.json({ error: 'В системе должен остаться хотя бы один активный администратор' }, { status: 400 })
  }

  await db.source.updateMany({ where: { ownerId: id }, data: { ownerId: null } }) // источники → общие
  await db.user.delete({ where: { id } }) // сессии и токены удалятся каскадом
  void audit('delete_user', { userId: id, email: target.email, ip: g.ip, detail: `источники переведены в общие; выполнил ${g.user!.email}` })
  return NextResponse.json({ ok: true })
}
