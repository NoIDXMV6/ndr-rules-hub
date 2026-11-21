import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Telegram-привязка чатов (/start → chat_id + доставка отложенного кода),
// рассылка о версии и TOTP-вход на уровне логики (без HTTP-обёртки).

const ROOT = path.resolve(__dirname, '..')

// ── мок undici.request (Bot API) ─────────────────────────────────────────────
type TgCall = { url: string; body: Record<string, unknown> }
const tgCalls: TgCall[] = []

vi.mock('undici', () => {
  class FakeAgent {
    constructor(_opts?: unknown) { /* dispatcher-заглушка */ }
  }
  return {
    request: (url: string, opts: { body?: string }) => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(opts.body ?? '{}')
      } catch { /* ignore */ }
      tgCalls.push({ url, body })
      return {
        statusCode: 200,
        body: { text: async () => JSON.stringify({ ok: true, result: { username: 'ndr_hub_bot', id: 1 } }), dump: async () => undefined },
      }
    },
    ProxyAgent: FakeAgent,
    Agent: FakeAgent,
  }
})

let work: string
let db: import('@prisma/client').PrismaClient
let tg: typeof import('@/lib/engine/telegram')
let mfa: typeof import('@/lib/engine/mfa')
let password: typeof import('@/lib/security/password')

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value, updatedAt: new Date() }, update: { value, updatedAt: new Date() } })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-2fa-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  tg = await import('@/lib/engine/telegram')
  mfa = await import('@/lib/engine/mfa')
  password = await import('@/lib/security/password')
  await setSetting('tgBotToken', '111:TEST')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('telegram: рассылка о версии (до привязки чатов — никого нет)', () => {
  it('без привязанных аккаунтов: 0 доставлено, версия запомнена; повтор — already-notified', async () => {
    const r1 = await tg.checkReleaseBroadcast()
    expect(r1.delivered).toBe(0)
    const v = await db.setting.findUnique({ where: { key: 'releaseNotifyVersion' } })
    expect(v?.value).toBeTruthy()
    const r2 = await tg.checkReleaseBroadcast()
    expect(r2.skipped).toBe('already-notified')
  })

  it('releaseBroadcastEnabled=false — рассылка не выполняется', async () => {
    await setSetting('releaseBroadcastEnabled', 'false')
    const r = await tg.checkReleaseBroadcast()
    expect(r.skipped).toBe('disabled')
    await setSetting('releaseBroadcastEnabled', 'true')
  })
})

describe('telegram: привязка чата по /start', () => {
  let user: { id: string; email: string }

  beforeAll(async () => {
    const u = await db.user.create({
      data: {
        email: 'tg@example.com', displayName: 'ТГ', passwordHash: 'x',
        role: 'user', status: 'active', twoFactor: 'telegram', telegramUsername: 'ivan_p',
      },
    })
    user = { id: u.id, email: u.email }
  })
  it('без username у отправителя — подсказка; unknown username — отказ с пояснением', async () => {
    const r1 = await tg.bindAndDeliver({ id: 1 }, '111')
    expect(r1).toContain('нет username')
    const r2 = await tg.bindAndDeliver({ id: 1, username: 'stranger' }, '222')
    expect(r2).toContain('не привязан')
    const u = await db.user.findUnique({ where: { id: user.id } })
    expect(u!.telegramChatId).toBeNull()
  })

  it('/start от пользователя: chat привязан, отложенный код доставлен sendMessage', async () => {
    tgCalls.length = 0
    const code = await mfa.issueVerificationCode(user.id)
    const reply = await tg.bindAndDeliver({ id: 2, username: 'Ivan_P' }, '555')
    expect(reply).toContain('код подтверждения отправлен')
    const u = await db.user.findUnique({ where: { id: user.id } })
    expect(u!.telegramChatId).toBe('555')
    // sendMessage с кодом ушёл в чат 555
    const sent = tgCalls.find((c) => c.url.includes('/sendMessage'))
    expect(sent).toBeTruthy()
    expect(String(sent!.body.chat_id)).toBe('555')
    expect(String(sent!.body.text)).toContain(code)
    // верификация кода теперь проходит
    expect((await mfa.verifyVerificationCode(user.id, code)).ok).toBe(true)
  })

  it('повторный /start: привязка обновляется (перезапись chat_id), код отложенного нет — без sendMessage кода', async () => {
    tgCalls.length = 0
    const reply = await tg.bindAndDeliver({ id: 2, username: 'ivan_p' }, '777')
    expect(reply).toContain('Чат привязан')
    const u = await db.user.findUnique({ where: { id: user.id } })
    expect(u!.telegramChatId).toBe('777')
    expect(tgCalls.find((c) => String(c.body.text ?? '').includes('Код подтверждения NDR&DNS Rules HUB'))).toBeUndefined()
  })
})

describe('telegram: getBotUsername и deep-link', () => {
  it('getMe кэширует username бота; deep-link строится', async () => {
    const name = await tg.getBotUsername()
    expect(name).toBe('ndr_hub_bot')
    expect(tg.botDeepLink(name)).toBe('https://t.me/ndr_hub_bot')
    expect(tg.botDeepLink(null)).toBeNull()
  })
})

describe('telegram: force-рассылка после привязки', () => {
  it('force=true с привязанным аккаунтом: доставка, текст содержит версию и имя', async () => {
    tgCalls.length = 0
    const r = await tg.checkReleaseBroadcast(true)
    expect(r.delivered).toBe(1)
    const sent = tgCalls.find((c) => c.url.includes('/sendMessage'))
    expect(String(sent!.body.text)).toContain('NDR&DNS Rules HUB обновлён до версии')
    expect(String(sent!.body.text)).toContain('ТГ')
  })
})
