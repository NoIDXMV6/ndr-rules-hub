// ─────────────────────────────────────────────────────────────────────────────
// Уведомления: Telegram (с поддержкой прокси) и Gotify.
// Настройки хранятся в таблице Setting (вкладка «Интеграции» → «Уведомления и сервисы»).
// Модуль самодостаточен: читает настройки напрямую из БД (без цикла импортов
// со service.ts), события приходят от движка (pipeline, vpn, disk).
// ─────────────────────────────────────────────────────────────────────────────
import { request, ProxyAgent, Agent, type Dispatcher } from 'undici'
import { socksDispatcher } from 'fetch-socks'
import type { SocksProxy } from 'socks'
import { db } from '@/lib/db'
import { DEFAULT_SETTINGS } from './seed'

// ── Настройки ────────────────────────────────────────────────────────────────

export interface NotifySettings {
  // Telegram
  notifyTgEnabled: boolean
  tgBotToken: string
  tgChatId: string
  tgProxy: string // http(s)://user:pass@host:port | socks5://user:pass@host:port | '' — без прокси
  tgApiBase: string // по умолчанию https://api.telegram.org (можно свой Bot API Server)
  // Gotify
  notifyGotifyEnabled: boolean
  gotifyUrl: string
  gotifyToken: string // app token (приложение «NDR Rules Hub»)
  gotifyPriority: number // 0..10
  // какие события слать
  notifyOnPipeline: boolean
  notifyOnVpn: boolean
  notifyOnDisk: boolean
}

export async function getNotifySettings(): Promise<NotifySettings> {
  const rows = await db.setting.findMany().catch(() => [])
  const map: Record<string, string> = { ...DEFAULT_SETTINGS }
  for (const r of rows) map[r.key] = r.value
  const s = (k: string) => map[k] ?? ''
  return {
    notifyTgEnabled: s('notifyTgEnabled') === 'true',
    tgBotToken: s('tgBotToken'),
    tgChatId: s('tgChatId'),
    tgProxy: s('tgProxy'),
    tgApiBase: s('tgApiBase') || 'https://api.telegram.org',
    notifyGotifyEnabled: s('notifyGotifyEnabled') === 'true',
    gotifyUrl: s('gotifyUrl').replace(/\/+$/, ''),
    gotifyToken: s('gotifyToken'),
    gotifyPriority: parseInt(s('gotifyPriority') || '5', 10) || 5,
    notifyOnPipeline: (s('notifyOnPipeline') || 'true') === 'true',
    notifyOnVpn: (s('notifyOnVpn') || 'true') === 'true',
    notifyOnDisk: (s('notifyOnDisk') || 'true') === 'true',
  }
}

// ── Транспорт: dispatcher по строке прокси ───────────────────────────────────

let insecureAgent: Agent | null = null
/** Агент, не проверяющий self-signed сертификаты (для Telegram/Gotify за прокси) */
export function insecureDispatcher(): Agent {
  if (!insecureAgent) insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })
  return insecureAgent
}

/** Построить Dispatcher для fetch-запроса по настройке прокси */
export function proxyDispatcher(proxy?: string): Dispatcher | undefined {
  const p = (proxy ?? '').trim()
  if (!p) return undefined
  const m = p.match(/^(https?|socks[45]?):\/\//i)
  if (!m) return undefined // неизвестная схема — обычный запрос
  const scheme = m[1].toLowerCase()
  if (scheme.startsWith('http')) {
    return new ProxyAgent({ uri: p, requestTls: { rejectUnauthorized: false } })
  }
  // socks4/4a/5/5h — fetch-socks поверх undici Agent
  try {
    const sp = socksProxyFromUrl(p)
    if (!sp) return undefined
    return socksDispatcher(sp, { connect: { rejectUnauthorized: false } })
  } catch {
    return undefined
  }
}

/** socks5://user:pass@host:1080 → SocksProxy для fetch-socks */
function socksProxyFromUrl(p: string): SocksProxy | null {
  try {
    const u = new URL(p)
    const type: 4 | 5 = /^socks4/i.test(p) ? 4 : 5
    const proxy: SocksProxy = { type, host: u.hostname, port: parseInt(u.port, 10) || 1080 }
    if (u.username) proxy.userId = decodeURIComponent(u.username)
    if (u.password) proxy.password = decodeURIComponent(u.password)
    return proxy
  } catch {
    return null
  }
}

// ── Telegram ─────────────────────────────────────────────────────────────────

export interface SendResult {
  ok: boolean
  error?: string
  channel: 'telegram' | 'gotify'
}

/** Telegram sendMessage. Текст — обычный (без HTML-разметки), чтобы не экранировать. */
export async function sendTelegram(text: string, cfg?: { token?: string; chatId?: string; proxy?: string; apiBase?: string }): Promise<SendResult> {
  const s = await getNotifySettings()
  const token = cfg?.token ?? s.tgBotToken
  const chatId = cfg?.chatId ?? s.tgChatId
  const apiBase = (cfg?.apiBase ?? s.tgApiBase).replace(/\/+$/, '')
  if (!token || !chatId) return { ok: false, channel: 'telegram', error: 'не заданы токен бота или chat_id (Интеграции → Уведомления и сервисы)' }
  const url = `${apiBase}/bot${token}/sendMessage`
  try {
    const body = JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true })
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      dispatcher: proxyDispatcher(cfg?.proxy ?? s.tgProxy) ?? insecureDispatcher(),
      bodyTimeout: 20_000,
      headersTimeout: 20_000,
    })
    const respText = await res.body.text()
    let parsed: { ok?: boolean; description?: string } = {}
    try {
      parsed = JSON.parse(respText)
    } catch {
      return { ok: false, channel: 'telegram', error: `HTTP ${res.statusCode}: не-JSON ответ (${respText.slice(0, 120)})` }
    }
    if (res.statusCode === 200 && parsed.ok) return { ok: true, channel: 'telegram' }
    return { ok: false, channel: 'telegram', error: `HTTP ${res.statusCode}: ${parsed.description ?? respText.slice(0, 160)}` }
  } catch (e) {
    return { ok: false, channel: 'telegram', error: (e as Error).message }
  }
}

// ── Gotify ───────────────────────────────────────────────────────────────────

/** Gotify push-message: POST {url}/message с заголовком X-Gotify-Key (app token) */
export async function sendGotify(title: string, message: string, cfg?: { url?: string; token?: string; priority?: number }): Promise<SendResult> {
  const s = await getNotifySettings()
  const base = (cfg?.url ?? s.gotifyUrl).replace(/\/+$/, '')
  const token = cfg?.token ?? s.gotifyToken
  const priority = cfg?.priority ?? s.gotifyPriority
  if (!base || !token) return { ok: false, channel: 'gotify', error: 'не заданы URL сервера Gotify или app-токен (Интеграции → Уведомления и сервисы)' }
  try {
    const res = await request(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Gotify-Key': token },
      body: JSON.stringify({ title: title.slice(0, 200), message: message.slice(0, 4000), priority }),
      dispatcher: insecureDispatcher(),
      bodyTimeout: 20_000,
      headersTimeout: 20_000,
    })
    const text = await res.body.text()
    if (res.statusCode >= 200 && res.statusCode < 300) return { ok: true, channel: 'gotify' }
    let detail = text.slice(0, 160)
    try {
      const j = JSON.parse(text) as { error?: string; errorDescription?: string }
      if (j.error) detail = `${j.error}${j.errorDescription ? `: ${j.errorDescription}` : ''}`
    } catch { /* keep raw */ }
    // Сервер Gotify отклонил токен (401/403 «invalid X-Gotify-Key header») — это
    // почти всегда неверный app-токен: вместо токена приложения вставлен клиентский,
    // приложение удалено/пересоздано или в поле осталось старое несохранённое значение.
    const keyHint = res.statusCode === 401 || res.statusCode === 403
      ? ' — сервер отклонил токен. Нужен токен ПРИЛОЖЕНИЯ (Apps → Create Application; в Gotify 3.x начинается с «gtfya.»), не клиента («gtfyc.»); сверьте его с полем через «глазок» и повторите «Тест» (он сохраняет текущие значения полей перед проверкой).'
      : ''
    return { ok: false, channel: 'gotify', error: `HTTP ${res.statusCode}: ${detail}${keyHint}` }
  } catch (e) {
    return { ok: false, channel: 'gotify', error: (e as Error).message }
  }
}

// ── События ──────────────────────────────────────────────────────────────────

export type NotifyScope = 'pipeline' | 'vpn' | 'disk'

const LEVEL_ICON: Record<string, string> = { success: '✔', error: '✖', warn: '⚠', info: 'ℹ' }

/**
 * Отправить событие во все включённые каналы. Название вкладки и уровень
 * входят в текст; событие шлётся только если соответствующий переключатель
 * (notifyOn*) включён. Ошибки каналов не роняют вызывающий код.
 */
export async function notifyEvent(scope: NotifyScope, level: 'success' | 'error' | 'warn' | 'info', title: string, message: string): Promise<Array<SendResult>> {
  const s = await getNotifySettings()
  const on = scope === 'pipeline' ? s.notifyOnPipeline : scope === 'vpn' ? s.notifyOnVpn : s.notifyOnDisk
  if (!on) return []
  const scopeRu = scope === 'pipeline' ? 'Конвейер правил' : scope === 'vpn' ? 'WireGuard VPN' : 'Диск'
  const text = `${LEVEL_ICON[level] ?? ''} ${scopeRu}: ${title}\n${message}`.trim()
  const out: SendResult[] = []
  if (s.notifyTgEnabled) out.push(await sendTelegram(text))
  if (s.notifyGotifyEnabled) out.push(await sendGotify(`NDR Rules Hub — ${scopeRu}`, text))
  return out.filter((r) => !r.ok) // возвращаем только неудачи — для журнала
}

/** Значения канала прямо из полей формы — кнопка «Тест» сохраняет настройки и
 *  проверяет ровно то, что видно в интерфейсе (раньше тест читал БД, и только что
 *  вставленный токен давал «invalid X-Gotify-Key header» со старым значением). */
export type TestChannelCfg = {
  // Gotify
  url?: string
  token?: string
  priority?: number
  // Telegram
  chatId?: string
  proxy?: string
  apiBase?: string
}

/** Проверка канала кнопкой «Тест» в настройках (cfg перекрывает значения из БД) */
export async function sendTest(channel: 'telegram' | 'gotify', cfg?: TestChannelCfg): Promise<SendResult> {
  const now = new Date().toLocaleString('ru-RU')
  const text = `Тест уведомления NDR Rules Hub (${now})\nЕсли вы видите это сообщение — канал настроен верно.`
  return channel === 'telegram' ? sendTelegram(text, cfg) : sendGotify('NDR Rules Hub — тест', text, cfg)
}
