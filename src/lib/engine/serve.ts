// ─────────────────────────────────────────────────────────────────────────────
// Отдача итогового набора правил по HTTP (PULL-схема): Clear NDR (scirius)
// подключает итоговый файл URL-источником (Source.method='http') и штатным
// планировщиком (celery, Suricata → Update → Recurrence) забирает его сам.
// Два формата отдачи:
//   • одиночный .rules-файл       — GET /api/export               (datatype «sig»);
//   • tgz-архив по источникам     — GET /api/export?archive=1     (datatype «sigs»:
//     scirius handle_rules_in_tar раскладывает каждый файл архива в rules/
//     отдельной категорией; допускаются файлы в корне архива, но НЕ две
//     директории «rules» — наш архив плоский и этому соответствует).
// Защита (в порядке проверки):
//   1) настройка serveToken — глобальный ключ отдачи (вкладка «Сборка»);
//   2) персональный токен скачивания пользователя (Enterprise, модель
//      DownloadToken: выдаётся в кабинете, в БД только SHA-256, перебор
//      отсекается rate-лимитом по IP — 10 неудач за 5 мин → блок 15 мин);
//   3) сессия веб-интерфейса — скачавшему из кабинета не нужен токен вовсе.
// Ключ принимается из ?token= или из заголовка Authorization: при заполненном
// поле authkey источника scirius шлёт ровно его («Authorization: <authkey>»,
// rules/models.py → update_ruleset_http). Пустая настройка и отсутствие
// токенов = отдача открыта (как и раньше; в Enterprise рекомендуется ключ).
// ВАЖНО: scirius НЕ проверяет HTTP-статус ответа URL-источника
// (update_ruleset_http пишет resp.content в файл как есть) — поэтому тексты
// ошибок здесь внятные: при неверном ключе источник упадёт на разборе правил,
// и текст ошибки сразу покажет причину.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { getSetting } from './service'
import { safeEqual } from '@/lib/security/ids'
import { verifyDownloadToken, DOWNLOAD_TOKEN_PREFIX, DL_FAIL_RULE } from '@/lib/security/download-token'
import { rateLimit } from '@/lib/security/ratelimit'
import { audit } from '@/lib/security/audit'
import { promises as fs } from 'fs'

export interface ServeResult {
  status: number
  contentType: string
  fileName?: string
  body: string | Buffer
  /** для 429: через сколько секунд повторить (Retry-After) */
  retryAfterSec?: number
}

const TEXT = 'text/plain; charset=utf-8'

/** Последний «кусок» заголовка Authorization: «K1», «Token K1», «Bearer K1» → «K1» */
export function tokenFromAuthHeader(h?: string | null): string | undefined {
  if (!h) return undefined
  const parts = h.trim().split(/\s+/)
  return parts[parts.length - 1] || undefined
}

export interface ServeAuth {
  token?: string
  authHeader?: string | null
  /** IP клиента (для анти-брутфорса и статистики токена) */
  ip?: string
  /** Пользователь открытой сессии веб-интерфейса — доступ без токена */
  sessionUserId?: string
}

type Access = { ok: boolean; reason?: string; blocked?: boolean; tokenRow?: { id: string; userId: string } }

/** Проверка доступа к отдаче: персональный токен → serveToken → сессия → открытая отдача. */
async function checkServeAccess(provided: string, opts: ServeAuth): Promise<Access> {
  const ip = opts.ip ?? 'local'

  // 1) персональный токен скачивания (Enterprise): лимит неудач внутри
  if (provided && provided.startsWith(DOWNLOAD_TOKEN_PREFIX)) {
    const v = await verifyDownloadToken(provided, ip)
    if (v.ok) return { ok: true, tokenRow: { id: v.tokenId, userId: v.userId } }
    return { ok: false, reason: v.reason, blocked: v.reason === 'blocked' }
  }

  const cfg = (await getSetting('serveToken')).trim()

  // 2) глобальный ключ отдачи (константное сравнение через хеши)
  if (cfg && safeEqual(provided, cfg)) return { ok: true }

  // 3) сессия веб-интерфейса — из кабинета скачивают без ключа
  if (opts.sessionUserId) return { ok: true }

  // 4) ключ отдачи не задан и токен не предъявлен — отдача открыта
  //    (совместимость с прежним поведением; UI предупреждает: «Ключ не задан —
  //    отдача открыта…», в Enterprise рекомендуется задать ключ или токены)
  if (!cfg) return { ok: true }

  // 5) перебор посторонних ключей отсекается лимитом: 10 неудач за 5 минут →
  //    блок IP на 15 минут
  if (provided) {
    const rl = rateLimit(`dlfail:${ip}`, DL_FAIL_RULE)
    if (!rl.ok) {
      void audit('ratelimit', { ip, detail: 'dlfail: перебор ключей отдачи' })
      return { ok: false, reason: 'blocked', blocked: true }
    }
  }
  return { ok: false, reason: provided ? 'invalid' : 'missing' }
}

/** Отдать последнюю сборку: файл или архив, с проверкой ключа/токена отдачи */
export async function serveBuild(opts: ServeAuth & { archive?: boolean } = {}): Promise<ServeResult> {
  const provided = opts.token?.trim() || tokenFromAuthHeader(opts.authHeader) || ''
  const access = await checkServeAccess(provided, opts)
  if (!access.ok) {
    void audit('download_denied', { ip: opts.ip, userId: opts.sessionUserId, detail: `причина: ${access.reason ?? 'invalid'}` })
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
      body: 'NDR Rules Hub: доступ запрещён — неверный ключ отдачи. Добавьте к URL ?token=<ключ> или заполните поле authkey источника в Clear NDR этим ключом (глобальный ключ задаётся на вкладке «Сборка» → «Отдача по URL»; в Enterprise пользователям выдаются персональные токены скачивания там же).',
    }
  }

  const build = await db.build.findFirst({ orderBy: { createdAt: 'desc' } })
  if (!build) {
    return { status: 404, contentType: TEXT, body: 'NDR Rules Hub: нет сборок — сначала выполните сборку (вкладка «Сборка»).' }
  }

  const stat = async (bytes: number) => {
    await audit('download', { userId: access.tokenRow?.userId, ip: opts.ip, detail: `${opts.archive ? 'архив' : 'файл'} ${bytes} байт` })
    if (access.tokenRow) {
      await db.downloadToken.update({
        where: { id: access.tokenRow.id },
        data: { bytesServed: { increment: bytes } },
      }).catch(() => undefined)
    }
  }

  if (opts.archive) {
    const stats = JSON.parse(build.statsJson || '{}') as { archive?: { filePath: string; fileName: string } }
    if (!stats.archive) {
      return { status: 404, contentType: TEXT, body: 'NDR Rules Hub: в этой сборке нет tgz-архива — включите «Формат сборки: файл + tgz» в настройках и пересоберите набор.' }
    }
    try {
      const content = await fs.readFile(stats.archive.filePath)
      await stat(content.length)
      return { status: 200, contentType: 'application/gzip', fileName: stats.archive.fileName, body: content }
    } catch {
      return { status: 404, contentType: TEXT, body: `NDR Rules Hub: файл архива не найден на диске: ${stats.archive.filePath}` }
    }
  }

  try {
    const content = await fs.readFile(build.filePath)
    await stat(content.length)
    return { status: 200, contentType: TEXT, fileName: build.fileName, body: content }
  } catch {
    return { status: 404, contentType: TEXT, body: `NDR Rules Hub: файл сборки не найден на диске: ${build.filePath} — пересоберите набор.` }
  }
}
