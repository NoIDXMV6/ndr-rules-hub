// ─────────────────────────────────────────────────────────────────────────────
// Журнал событий безопасности (модель AuthEvent): регистрации, входы/отказы,
// верификации, срабатывания лимитов. Пишется fire-and-forget — сбой журнала
// не должен ломать основной сценарий. Доступен администратору в UI
// (вкладка «Пользователи» → «События безопасности»).
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'

const MAX_EVENTS = 20000

export type AuditKind =
  | 'register' | 'login_ok' | 'login_fail' | 'login_lock' | 'login_pending' | 'login_disabled'
  | 'logout' | 'verify' | 'disable' | 'enable' | 'role_change' | 'delete_user'
  | 'token_create' | 'token_revoke' | 'download' | 'download_denied'
  | 'ratelimit' | 'queue_full'

export interface AuditCtx {
  email?: string
  userId?: string
  ip?: string
  detail?: string
}

export async function audit(kind: AuditKind, ctx: AuditCtx = {}): Promise<void> {
  try {
    await db.authEvent.create({
      data: {
        kind,
        email: ctx.email?.slice(0, 200) ?? null,
        userId: ctx.userId ?? null,
        ip: ctx.ip?.slice(0, 100) ?? null,
        detail: ctx.detail?.slice(0, 1000) ?? null,
      },
    })
    // уборка: с вероятностью 2% подрезаем журнал до MAX_EVENTS строк
    if (Math.random() < 0.02) {
      const cnt = await db.authEvent.count()
      if (cnt > MAX_EVENTS) {
        const extra = cnt - MAX_EVENTS
        const old = await db.authEvent.findMany({ orderBy: { ts: 'asc' }, take: extra, select: { id: true } })
        await db.authEvent.deleteMany({ where: { id: { in: old.map((e) => e.id) } } })
      }
    }
  } catch {
    /* журнал не должен ломать основной сценарий */
  }
}
