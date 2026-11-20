// ─────────────────────────────────────────────────────────────────────────────
// Отдача списка заблокированных доменов по HTTP — новый «пойнт» скачивания
// GET /api/dns/export (по аналогии с GET /api/export для правил).
// Защита (в порядке проверки):
//   1) персональный токен скачивания со scope «domains» или «both»
//      (токены со scope «rules» к списку доменов доступа не имеют);
//   2) глобальный ключ отдачи dnsServeToken (настройка, вкладка «DNS-фильтрация»);
//   3) сессия веб-интерфейса — из кабинета скачивают без ключа;
//   4) ключ не задан и токен не предъявлен — отдача открыта (как и у правил:
//      совместимость с прежним поведением; UI предупреждает, Enterprise — ключ).
// Перебор ключей отсекается тем же rate-лимитом dlfail:<ip>, что и у правил.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { getSetting } from './service'
import { safeEqual } from '@/lib/security/ids'
import { verifyDownloadToken, DL_FAIL_RULE } from '@/lib/security/download-token'
import { rateLimit } from '@/lib/security/ratelimit'
import { audit } from '@/lib/security/audit'
import { tokenFromAuthHeader, type ServeAuth, type ServeResult } from './serve'
import { promises as fs } from 'fs'

const TEXT = 'text/plain; charset=utf-8'

type Access = { ok: boolean; reason?: string; blocked?: boolean; tokenRow?: { id: string; userId: string } }

/** Проверка доступа к списку доменов: токен (scope domains|both) → dnsServeToken → сессия → открыто */
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

  const cfg = (await getSetting('dnsServeToken')).trim()

  if (cfg && safeEqual(provided, cfg)) return { ok: true }
  if (opts.sessionUserId) return { ok: true }
  if (!cfg) return { ok: true }

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
        body: 'NDR Rules Hub: слишком много неверных ключей с этого адреса — доступ приостановлен на 15 минут (защита от перебора ключей).',
      }
    }
    return {
      status: 403,
      contentType: TEXT,
      body: access.reason === 'scope'
        ? 'NDR Rules Hub: доступ запрещён — этот токен выдан только для правил Suricata. Для скачивания списка доменов создайте токен со scope «домены» или «оба списка».'
        : access.reason === 'missing' || access.reason === 'invalid'
          ? 'NDR Rules Hub: доступ запрещён — неверный ключ отдачи списка доменов. Добавьте к URL ?token=<токен> или передайте его в заголовке Authorization. Персональный токен со scope «домены» выдаётся в разделе «Аккаунт» → «Токены и доступ», глобальный ключ — в «DNS списки» → «Сборка и экспорт».'
          : 'NDR Rules Hub: доступ запрещён.',
    }
  }

  const build = await db.domainBuild.findFirst({ orderBy: { createdAt: 'desc' } })
  if (!build) {
    return { status: 404, contentType: TEXT, body: 'NDR Rules Hub: список доменов ещё не собран — выполните сборку на вкладке «DNS-фильтрация».' }
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
    return { status: 404, contentType: TEXT, body: `NDR Rules Hub: файл списка доменов не найден на диске: ${build.filePath} — пересоберите список.` }
  }
}
