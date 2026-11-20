// ─────────────────────────────────────────────────────────────────────────────
// Персональные токены скачивания (Enterprise).
// Токен вида ndrt_<43 символа base64url> выдаётся пользователю в кабинете
// (раздел «Аккаунт» → «Токены и доступ»). В БД — только SHA-256,
// полный токен показывается один раз. scope задаёт, ЧТО доступно токену:
//   rules   — сборка правил GET /api/export (дефолт, историческое поведение);
//   domains — список заблокированных доменов GET /api/dns/export;
//   both    — оба списка одновременно.
// Токен принимается вместе с глобальным ключом отдачи (serveToken):
// ?token=<токен> или заголовок Authorization («<токен>», «Token <токен>»,
// «Bearer <токен>»). Перебор токенов отсекается rate-лимитом (dlfail:<ip>):
// 10 неудач за 5 минут → блокировка IP на 15 минут.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { randomToken, sha256hex } from './ids'
import { peekBlocked, recordFailure, resetRate } from './ratelimit'
import { audit } from './audit'

export const DOWNLOAD_TOKEN_PREFIX = 'ndrt_'
/** Лимит неудачных попыток скачивания с одного IP */
export const DL_FAIL_RULE = { limit: 10, windowMs: 5 * 60_000, blockMs: 15 * 60_000 }
const DL_FAIL_KEY = (ip: string) => `dlfail:${ip}`

export type DownloadTokenScope = 'rules' | 'domains' | 'both'

export function normalizeTokenScope(v: unknown): DownloadTokenScope {
  return v === 'domains' || v === 'both' ? v : 'rules'
}

// ── Готовые Uri отдачи для плашки после создания токена ──────────────────────
// Процедуры подключения у двух списков РАЗНЫЕ:
//  • правила Suricata — Clear NDR передаёт токен в заголовке Authorization
//    (поле «Optional authorization key» источника): Uri выдаётся БЕЗ токена,
//    чтобы каждое поле формы получило своё значение;
//  • список заблокированных доменов забирают ЛЮБЫЕ DNS-серверы с поддержкой
//    обновления списков по ссылке (AdGuard Home, Pi-hole, Blocky, dnsmasq…):
//    отдельного поля для токена у них нет — поэтому выдаётся ПОЛНЫЙ Uri,
//    в котором токен уже в адресе (?token=…); заголовок Authorization также
//    принимается, но не требуется.
// Сами хелперы — в src/lib/serve-urls.ts (без серверных импортов: их использует
// и клиентская карточка токенов, и тесты).

export interface CreatedDownloadToken {
  id: string
  token: string // полный токен — показывается один раз
  name: string
  prefix: string
  scope: DownloadTokenScope
  expiresAt: Date | null
}

export async function createDownloadToken(userId: string, name: string, ttlDays?: number | null, scope: DownloadTokenScope = 'rules'): Promise<CreatedDownloadToken> {
  const token = DOWNLOAD_TOKEN_PREFIX + randomToken(32)
  const expiresAt = ttlDays && ttlDays > 0 ? new Date(Date.now() + ttlDays * 24 * 3600 * 1000) : null
  const row = await db.downloadToken.create({
    data: { userId, name: name.slice(0, 100), tokenHash: sha256hex(token), prefix: token.slice(0, 12), scope, expiresAt },
  })
  void audit('token_create', { userId, detail: `name=${name.slice(0, 100)} prefix=${row.prefix} scope=${row.scope}` })
  return { id: row.id, token, name: row.name, prefix: row.prefix, scope: row.scope as DownloadTokenScope, expiresAt: row.expiresAt }
}

export type DownloadTokenVerdict =
  | { ok: true; tokenId: string; userId: string; scope: DownloadTokenScope }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'blocked' }

/**
 * Проверить токен скачивания. Перебор с одного IP отсекается:
 * 10 неудач за 5 минут → блокировка IP на 15 минут (429).
 * При успехе обновляет статистику использования (lastUsedAt/lastIp/downloadCount).
 */
export async function verifyDownloadToken(provided: string, ip: string): Promise<DownloadTokenVerdict> {
  const key = DL_FAIL_KEY(ip)
  const blockedFor = peekBlocked(key)
  if (blockedFor > 0) {
    void audit('ratelimit', { ip, detail: `dlfail: блок за перебор токенов (ещё ${blockedFor} с)` })
    return { ok: false, reason: 'blocked' }
  }

  const row = await db.downloadToken.findUnique({ where: { tokenHash: sha256hex(provided) } })
  if (!row) {
    recordFailure(key, DL_FAIL_RULE)
    void audit('download_denied', { ip, detail: `неизвестный токен (${provided.slice(0, 12)}…)` })
    return { ok: false, reason: 'unknown' }
  }
  if (row.revokedAt) {
    recordFailure(key, DL_FAIL_RULE)
    void audit('download_denied', { userId: row.userId, ip, detail: `токен отозван (${row.prefix}…)` })
    return { ok: false, reason: 'revoked' }
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    recordFailure(key, DL_FAIL_RULE)
    void audit('download_denied', { userId: row.userId, ip, detail: `токен истёк (${row.prefix}…)` })
    return { ok: false, reason: 'expired' }
  }
  // владелец должен оставаться верифицированным (активным)
  const owner = await db.user.findUnique({ where: { id: row.userId }, select: { status: true } })
  if (!owner || owner.status !== 'active') {
    recordFailure(key, DL_FAIL_RULE)
    void audit('download_denied', { userId: row.userId, ip, detail: `пользователь не активен (${row.prefix}…)` })
    return { ok: false, reason: 'revoked' }
  }
  resetRate(key) // успех — счётчик неудач IP обнуляется
  // статистика использования — детерминированно до возврата (журнал аудита fire-and-forget)
  await db.downloadToken.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date(), lastIp: ip.slice(0, 100), downloadCount: { increment: 1 } },
  }).catch(() => undefined)
  void audit('download', { userId: row.userId, ip, detail: `токен ${row.prefix}… scope=${row.scope}` })
  return { ok: true, tokenId: row.id, userId: row.userId, scope: row.scope as DownloadTokenScope }
}

export async function revokeDownloadToken(id: string, userId?: string): Promise<boolean> {
  const row = await db.downloadToken.findUnique({ where: { id } })
  if (!row) return false
  if (userId && row.userId !== userId) return false // не владелец (админ проходит без userId)
  await db.downloadToken.update({ where: { id }, data: { revokedAt: new Date() } })
  void audit('token_revoke', { userId: row.userId, detail: `prefix=${row.prefix}` })
  return true
}

/** Вернуть ранее отозванный токен (владелец или администратор): отзывается заново в любой момент. */
export async function restoreDownloadToken(id: string, userId?: string): Promise<boolean> {
  const row = await db.downloadToken.findUnique({ where: { id } })
  if (!row) return false
  if (userId && row.userId !== userId) return false
  if (!row.revokedAt) return false // активный токен возвращать нечего
  await db.downloadToken.update({ where: { id }, data: { revokedAt: null } })
  void audit('token_restore', { userId: row.userId, detail: `prefix=${row.prefix}` })
  return true
}

/** Удалить токен из списка навсегда (владелец или администратор). Статистика исчезает вместе с ним. */
export async function deleteDownloadToken(id: string, userId?: string): Promise<boolean> {
  const row = await db.downloadToken.findUnique({ where: { id } })
  if (!row) return false
  if (userId && row.userId !== userId) return false
  await db.downloadToken.delete({ where: { id } })
  void audit('token_delete', { userId: row.userId, detail: `prefix=${row.prefix} name=${row.name}` })
  return true
}
