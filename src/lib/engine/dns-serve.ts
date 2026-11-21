// ─────────────────────────────────────────────────────────────────────────────
// Отдача списка заблокированных доменов по HTTP — «пойнт» скачивания
// GET /api/dns/export (по аналогии с GET /api/export для правил).
// Защита (v1.34.0): БЕЗ ТОКЕНА ОТДАЧА ЗАПРЕЩЕНА. Порядок проверки:
//   1) персональный токен скачивания со scope «домены»/«оба списка»
//      (?token=… в полном Uri или заголовок Authorization; токены выдаются
//      в «Аккаунт → Токены и доступ», при создании показывается полный Uri);
//   2) сессия веб-интерфейса — из кабинета скачивают без токена (кнопка
//      «Скачать» на «Обзоре» и вкладке сборки);
//   3) иначе — 403: анонимный доступ к списку доменов закрыт.
// Токены со scope «rules» к списку доменов доступа не имеют; глобальный ключ
// dnsServeToken удалён — токены управляются ТОЛЬКО в разделе «Аккаунт».
// Перебор ключей отсекается тем же rate-лимитом dlfail:<ip>, что и у правил.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { verifyDownloadToken, DL_FAIL_RULE } from '@/lib/security/download-token'
import { rateLimit } from '@/lib/security/ratelimit'
import { audit } from '@/lib/security/audit'
import { tokenFromAuthHeader, type ServeAuth, type ServeResult } from './serve'
import { promises as fs } from 'fs'

const TEXT = 'text/plain; charset=utf-8'

type Access = { ok: boolean; reason?: string; blocked?: boolean; tokenRow?: { id: string; userId: string } }

/** Проверка доступа к списку доменов: токен (scope domains|both) → сессия → отказ */
async function checkDomainServeAccess(provided: string, opts: ServeAuth): Promise<Access> {
  const ip = opts.ip ?? 'local'

  if (provided && provided.startsWith('ndrt_')) {
    const v = await verifyDownloadToken(provided, ip)
    if (v.ok) {
      if (v.scope === 'rules') return { ok: false, reason: 'scope' }
      return { ok: true, tokenRow: { id: v.tokenId, userId: v.userId } }
    }
    return { ok: false, reason: v.reason, blocked: v.reason === 'blocked' }
  }

  if (opts.sessionUserId) return { ok: true }

  if (provided) {
    const rl = rateLimit(`dlfail:${ip}`, DL_FAIL_RULE)
    if (!rl.ok) {
      void audit('ratelimit', { ip, detail: 'dlfail: перебор ключей отдачи (домены)' })
      return { ok: false, reason: 'blocked', blocked: true }
    }
  }
  return { ok: false, reason: provided ? 'invalid' : 'missing' }
}

/** Отдать последний собранный список доменов */
export async function serveDomainList(opts: ServeAuth = {}): Promise<ServeResult> {
  const provided = opts.token?.trim() || tokenFromAuthHeader(opts.authHeader) || ''
  const access = await checkDomainServeAccess(provided, opts)
  if (!access.ok) {
    void audit('download_denied', { ip: opts.ip, userId: opts.sessionUserId, detail: `домены: причина ${access.reason ?? 'invalid'}` })
    if (access.blocked) {
      return {
        status: 429,
        contentType: TEXT,
        retryAfterSec: 900,
        body: 'NDR&DNS Rules HUB: слишком много неверных ключей с этого адреса — доступ приостановлен на 15 минут (защита от перебора ключей).',
      }
    }
    return {
      status: 403,
      contentType: TEXT,
      body: access.reason === 'scope'
        ? 'NDR&DNS Rules HUB: доступ запрещён — этот токен выдан только для правил Suricata. Для скачивания списка доменов создайте токен со scope «домены» или «оба списка» в разделе «Аккаунт → Токены и доступ».'
        : 'NDR&DNS Rules HUB: доступ запрещён — без токена отдача списка доменов запрещена. Создайте токен со scope «домены» или «оба списка» в разделе «Аккаунт → Токены и доступ» и добавьте его к URL (?token=ndrt_… — при создании токена показывается полный Uri) либо передайте в заголовке Authorization.',
    }
  }

  const build = await db.domainBuild.findFirst({ orderBy: { createdAt: 'desc' } })
  if (!build) {
    return { status: 404, contentType: TEXT, body: 'NDR&DNS Rules HUB: список доменов ещё не собран — выполните сборку на вкладке «DNS списки».' }
  }
  try {
    const content = await fs.readFile(build.filePath)
    await audit('download', { userId: access.tokenRow?.userId ?? opts.sessionUserId, ip: opts.ip, detail: `домены ${content.length} байт` })
    if (access.tokenRow) {
      await db.downloadToken.update({
        where: { id: access.tokenRow.id },
        data: { bytesServed: { increment: content.length } },
      }).catch(() => undefined)
    }
    return { status: 200, contentType: TEXT, fileName: build.fileName, body: content }
  } catch {
    return { status: 404, contentType: TEXT, body: `NDR&DNS Rules HUB: файл списка доменов не найден на диске: ${build.filePath} — пересоберите список.` }
  }
}
