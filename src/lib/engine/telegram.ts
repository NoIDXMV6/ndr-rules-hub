// ─────────────────────────────────────────────────────────────────────────────
// Telegram-бот хаба: долгий опрос getUpdates (поллер), привязка чатов
// пользователей (/start), доставка кодов 2FA/верификации и рассылка
// уведомлений о новых версиях.
// Требуется: «Настройки → Уведомления» → включён Telegram и заполнен токен
// бота. Прокси берётся тот же (tgProxy). Пользователь обязан один раз отправить
// боту /start — иначе Telegram запрещает ботам инициировать переписку.
// ─────────────────────────────────────────────────────────────────────────────
import { request } from 'undici'
import { db } from '@/lib/db'
import { APP_VERSION, RELEASES_URL } from '@/lib/version'
import { log } from './service'
import { proxyDispatcher, insecureDispatcher } from './notify'

const g = globalThis as unknown as {
  __tgPolling?: boolean
  __tgOffset?: number
  __tgBotUsername?: string | null
}

const API_TIMEOUT = 20_000

interface TgSettings {
  token: string
  apiBase: string
  proxy?: string
}

async function tgSettings(): Promise<TgSettings | null> {
  const rows = await db.setting.findMany().catch(() => [])
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  const token = map.tgBotToken ?? ''
  if (!token) return null
  return { token, apiBase: (map.tgApiBase || 'https://api.telegram.org').replace(/\/+$/, ''), proxy: map.tgProxy || undefined }
}

/** Вызов метода Bot API */
async function tgMethod<T = Record<string, unknown>>(s: TgSettings, method: string, body?: Record<string, unknown>, longPollSec = 0): Promise<{ ok: boolean; result?: T; error?: string; status: number }> {
  try {
    const res = await request(`${s.apiBase}/bot${s.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(body ?? {}), ...(longPollSec ? { timeout: longPollSec } : {}) }),
      dispatcher: proxyDispatcher(s.proxy) ?? insecureDispatcher(),
      headersTimeout: longPollSec ? longPollSec * 1000 + API_TIMEOUT : API_TIMEOUT,
      bodyTimeout: longPollSec ? longPollSec * 1000 + API_TIMEOUT : API_TIMEOUT,
    })
    const text = await res.body.text()
    let json: { ok?: boolean; result?: T; description?: string } = {}
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, error: `не-JSON ответ: ${text.slice(0, 120)}`, status: res.statusCode }
    }
    if (res.statusCode === 200 && json.ok) return { ok: true, result: json.result, status: res.statusCode }
    return { ok: false, error: json.description ?? text.slice(0, 160), status: res.statusCode }
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: 0 }
  }
}

/** Отправить сообщение в конкретный чат (коды 2FA, привязка, рассылки) */
export async function sendTelegramText(chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const s = await tgSettings()
  if (!s) return { ok: false, error: 'токен бота не настроен (Настройки → Уведомления)' }
  const r = await tgMethod(s, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true })
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

/** @username бота (для deep-link https://t.me/<bot>); кэшируется на процесс */
export async function getBotUsername(): Promise<string | null> {
  if (g.__tgBotUsername) return g.__tgBotUsername
  const s = await tgSettings()
  if (!s) return null
  const r = await tgMethod<{ username?: string }>(s, 'getMe')
  if (r.ok && r.result?.username) {
    g.__tgBotUsername = r.result.username
    return r.result.username
  }
  return null
}

export function botDeepLink(botUsername: string | null | undefined): string | null {
  return botUsername ? `https://t.me/${botUsername}` : null
}

// ── Привязка чата и выдача отложенных кодов ─────────────────────────────────

/** Найти пользователя по @username отправителя (без @, без учёта регистра);
 *  экспортировано для тестов привязки */
export async function bindAndDeliver(from?: { id?: number | string; username?: string; first_name?: string }, chatId?: string): Promise<string> {
  const chatStr = String(chatId ?? '')
  const uname = (from?.username ?? '').toLowerCase()
  if (!uname) return 'В вашем Telegram нет username — задайте его в настройках Telegram и отправьте /start ещё раз.'
  const user = await db.user.findFirst({ where: { telegramUsername: uname } })
  if (!user) {
    return `@${uname} не привязан ни к одной учётной записи NDR Rules Hub. Укажите этот username при регистрации или в личном кабинете («Аккаунт»), затем отправьте /start ещё раз.`
  }
  if (user.telegramChatId !== chatStr) {
    await db.user.update({ where: { id: user.id }, data: { telegramChatId: chatStr } })
    await log('info', 'auth', `Telegram-чат ${chatStr} привязан к учётной записи ${user.email} (@${uname})`)
  }
  // отложенный код верификации/входа: если пользователь получил код до привязки чата
  if (user.verificationCode && user.verificationExpiresAt && user.verificationExpiresAt.getTime() > Date.now()) {
    const s = await tgSettings()
    if (s) await tgMethod(s, 'sendMessage', { chat_id: chatStr, text: `Код подтверждения NDR Rules Hub: ${user.verificationCode}\n(действует 5 минут)` })
    return 'Чат привязан — код подтверждения отправлен выше.'
  }
  return 'Чат привязан к NDR Rules Hub. Коды подтверждения будут приходить сюда.'
}

// ── Поллер ───────────────────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const s = await tgSettings()
  if (!s) {
    stopPolling()
    return
  }
  const r = await tgMethod<Array<{ update_id: number; message?: { chat: { id: number }; from?: { id: number | string; username?: string; first_name?: string }; text?: string } }>>(
    s, 'getUpdates', { offset: g.__tgOffset, allowed_updates: ['message'] }, 25,
  )
  if (!r.ok) {
    // 409 — другой экземпляр поллера (вебхук/второй контейнер): останавливаемся
    if (r.status === 409) {
      await log('warn', 'auth', `Telegram getUpdates: 409 (${r.error}) — вероятно, webhook активен; поллер остановлен`)
      stopPolling()
      return
    }
    return // сетевая ошибка — следующий круг
  }
  for (const upd of r.result ?? []) {
    g.__tgOffset = upd.update_id + 1
    const msg = upd.message
    if (!msg?.text) continue
    const chatId = String(msg.chat.id)
    const text = msg.text.trim()
    if (text.startsWith('/start')) {
      try {
        const reply = await bindAndDeliver(msg.from ?? {}, chatId)
        await tgMethod(s, 'sendMessage', { chat_id: chatId, text: reply })
      } catch (e) {
        await log('error', 'auth', `Ошибка привязки Telegram-чата ${chatId}: ${(e as Error).message}`)
      }
    }
  }
}

async function pollingLoop(): Promise<void> {
  let failures = 0
  while (g.__tgPolling) {
    try {
      await pollOnce()
      failures = 0
    } catch {
      failures++
    }
    if (failures > 0) await new Promise((r) => setTimeout(r, Math.min(failures * 5, 60) * 1000))
  }
}

/** Запустить поллер (один на процесс); останавливает предыдущий при перенастройке */
export async function reinitTelegramPoller(): Promise<void> {
  const s = await tgSettings()
  if (!s) {
    stopPolling()
    return
  }
  if (g.__tgPolling) return // уже крутится
  g.__tgPolling = true
  void getBotUsername().catch(() => undefined)
  void pollingLoop().catch(() => undefined)
  await log('info', 'auth', 'Telegram-поллер запущен: привязка чатов по /start, доставка кодов 2FA')
}

export function stopPolling(): void {
  g.__tgPolling = false
  g.__tgOffset = undefined
}

export function pollerActive(): boolean {
  return !!g.__tgPolling
}

/** Одноразовый автозапуск на процесс (вызывается из bootstrap dashboard) */
export function maybeStartTelegramPoller(): void {
  const flag = (globalThis as unknown as { __tgPollerStarted?: boolean }).__tgPollerStarted
  if (flag) return
  ;(globalThis as unknown as { __tgPollerStarted?: boolean }).__tgPollerStarted = true
  void reinitTelegramPoller().catch(() => undefined)
}

// ── Рассылка о новой версии ──────────────────────────────────────────────────

/**
 * Уведомить всех пользователей с привязанным Telegram о выходе новой версии.
 * Запускается автоматически при расхождении APP_VERSION и настройки
 * releaseNotifyVersion (проверка на старте/dashboard), повторно — кнопкой
 * в настройках. Текст дополнения — настройка releaseNotes.
 */
export async function checkReleaseBroadcast(force = false): Promise<{ sent: boolean; delivered: number; failed: number; skipped?: string }> {
  if (!force) {
    const enabled = (await db.setting.findUnique({ where: { key: 'releaseBroadcastEnabled' } }).catch(() => null))?.value !== 'false'
    if (!enabled) return { sent: false, delivered: 0, failed: 0, skipped: 'disabled' }
    const notified = (await db.setting.findUnique({ where: { key: 'releaseNotifyVersion' } }).catch(() => null))?.value
    if (notified === APP_VERSION) return { sent: false, delivered: 0, failed: 0, skipped: 'already-notified' }
  }
  const s = await tgSettings()
  if (!s) return { sent: false, delivered: 0, failed: 0, skipped: 'no-bot-token' }
  const notes = (await db.setting.findUnique({ where: { key: 'releaseNotes' } }).catch(() => null))?.value ?? ''
  const text = [
    `NDR Rules Hub обновлён до версии ${APP_VERSION}.`,
    notes ? `\nЧто нового:\n${notes}` : '',
    `\nИзменения и релизы: ${RELEASES_URL}`,
  ].filter(Boolean).join('\n')

  const users = await db.user.findMany({
    where: { telegramChatId: { not: null }, status: 'active' },
    select: { id: true, displayName: true, telegramChatId: true },
  })
  let delivered = 0
  let failed = 0
  for (const u of users) {
    const r = await sendTelegramText(u.telegramChatId as string, `Здравствуйте, ${u.displayName}!\n\n${text}`)
    if (r.ok) delivered++
    else failed++
  }
  await db.setting.upsert({
    where: { key: 'releaseNotifyVersion' },
    create: { key: 'releaseNotifyVersion', value: APP_VERSION },
    update: { value: APP_VERSION },
  }).catch(() => undefined)
  await log(delivered ? 'success' : 'warn', 'auth',
    `Рассылка о версии ${APP_VERSION}: доставлено ${delivered}, ошибок ${failed}${force ? ' (принудительно)' : ''}`)
  return { sent: delivered > 0 || force, delivered, failed }
}
