import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Уведомления Telegram (с прокси http/socks5) и Gotify:
// URL/заголовки/тела запросов, маршрутизация событий (notifyOn*), тест каналов.

const ROOT = path.resolve(__dirname, '..')

// ── мок undici.request ───────────────────────────────────────────────────────
type ReqRec = { url: string; opts: { method?: string; headers?: Record<string, string>; body?: string; dispatcher?: unknown } }
const reqs: ReqRec[] = []
let responder: (r: ReqRec) => { status: number; body: string } = () => ({ status: 200, body: '{"ok":true}' })
const proxyAgents: string[] = []

vi.mock('undici', () => {
  class FakeAgent {
    constructor(opts?: { uri?: string }) {
      if (opts?.uri) proxyAgents.push(opts.uri)
    }
  }
  return {
    request: (url: string, opts: ReqRec['opts']) => {
      const rec: ReqRec = { url, opts }
      reqs.push(rec)
      const r = responder(rec)
      return {
        statusCode: r.status,
        body: { text: async () => r.body, dump: async () => undefined },
      }
    },
    ProxyAgent: FakeAgent,
    Agent: FakeAgent,
  }
})

vi.mock('fetch-socks', () => {
  const socksCalls: unknown[] = []
  return {
    socksDispatcher: (proxies: unknown) => {
      socksCalls.push(proxies)
      return { socksCalls }
    },
  }
})

let work: string
let db: import('@prisma/client').PrismaClient
let notify: typeof import('@/lib/engine/notify')

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value, updatedAt: new Date() }, update: { value, updatedAt: new Date() } })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-notify-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  notify = await import('@/lib/engine/notify')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('notify: Telegram', () => {
  it('без токена/chat_id — внятная ошибка, запрос не отправляется', async () => {
    reqs.length = 0
    const r = await notify.sendTelegram('тест')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('не заданы')
    expect(reqs).toEqual([])
  })

  it('sendMessage: URL с токеном бота, тело с chat_id и текстом', async () => {
    reqs.length = 0
    await setSetting('tgBotToken', '12345:ABC')
    await setSetting('tgChatId', '-10042')
    const r = await notify.sendTelegram('Проверка связи')
    expect(r.ok).toBe(true)
    expect(reqs).toHaveLength(1)
    expect(reqs[0].url).toBe('https://api.telegram.org/bot12345:ABC/sendMessage')
    const body = JSON.parse(reqs[0].opts.body!)
    expect(body.chat_id).toBe('-10042')
    expect(body.text).toContain('Проверка связи')
  })

  it('ошибка Telegram API доходит до вызывающего (HTTP 400, description)', async () => {
    reqs.length = 0
    responder = () => ({ status: 400, body: '{"ok":false,"description":"chat not found"}' })
    const r = await notify.sendTelegram('x')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('400')
    expect(r.error).toContain('chat not found')
    responder = () => ({ status: 200, body: '{"ok":true}' })
  })

  it('http-прокси: ProxyAgent строится с URI прокси и уходит в запрос', async () => {
    reqs.length = 0
    proxyAgents.length = 0
    const r = await notify.sendTelegram('через прокси', { token: 't', chatId: 'c', proxy: 'http://user:pass@proxy.local:3128' })
    expect(r.ok).toBe(true)
    expect(proxyAgents).toContain('http://user:pass@proxy.local:3128')
    expect(reqs[0].opts.dispatcher).toBeDefined()
  })

  it('socks5-прокси: парсится в SocksProxy для fetch-socks', async () => {
    const d = notify.proxyDispatcher('socks5://alice:secret@10.9.8.7:1080')
    expect(d).toBeDefined()
    const bad = notify.proxyDispatcher('ftp://nope')
    expect(bad).toBeUndefined()
    const empty = notify.proxyDispatcher('')
    expect(empty).toBeUndefined()
  })
})

describe('notify: Gotify', () => {
  it('без URL/токена — ошибка; с ними — POST {url}/message c X-Gotify-Key', async () => {
    reqs.length = 0
    const miss = await notify.sendGotify('t', 'm')
    expect(miss.ok).toBe(false)
    expect(miss.error).toContain('не заданы')

    await setSetting('gotifyUrl', 'https://gotify.local/')
    await setSetting('gotifyToken', 'Akey123')
    await setSetting('gotifyPriority', '7')
    const r = await notify.sendGotify('Заголовок', 'Текст события')
    expect(r.ok).toBe(true)
    expect(reqs[0].url).toBe('https://gotify.local/message')
    expect(reqs[0].opts.headers!['X-Gotify-Key']).toBe('Akey123')
    const body = JSON.parse(reqs[0].opts.body!)
    expect(body.title).toBe('Заголовок')
    expect(body.message).toBe('Текст события')
    expect(body.priority).toBe(7)
  })
})

describe('notify: события', () => {
  it('notifyOn*=false — события никуда не уходят', async () => {
    reqs.length = 0
    await setSetting('notifyTgEnabled', 'true')
    await setSetting('notifyGotifyEnabled', 'true')
    await setSetting('notifyOnVpn', 'false')
    const r = await notify.notifyEvent('vpn', 'success', 'туннель поднят', '...')
    expect(r).toEqual([])
    expect(reqs).toEqual([])
  })

  it('событие vpn при включённых каналах уходит в оба', async () => {
    reqs.length = 0
    await setSetting('notifyOnVpn', 'true')
    const failures = await notify.notifyEvent('vpn', 'success', 'туннель поднят', 'wg0')
    expect(failures).toEqual([]) // мок отвечает ok — неудач нет
    expect(reqs).toHaveLength(2)
    const tg = reqs.find((r) => r.url.includes('api.telegram.org'))!
    expect(JSON.parse(tg.opts.body!).text).toContain('WireGuard VPN')
    const go = reqs.find((r) => r.url.includes('gotify.local/message'))!
    expect(JSON.parse(go.opts.body!).title).toContain('WireGuard VPN')
  })

  it('sendTest формирует тестовое сообщение', async () => {
    reqs.length = 0
    const r = await notify.sendTest('telegram')
    expect(r.ok).toBe(true)
    expect(JSON.parse(reqs[0].opts.body!).text).toContain('Тест уведомления')
  })
})
