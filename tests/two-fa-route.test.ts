import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'

const execFileP = promisify(execFile)

// Вход с 2FA на уровне роутов: капча обязательна (без неё — отказ), верные
// учётные данные при включённом TOTP выдают билет второго шага (ndrh_mfa),
// неверный код → 401, верный → сессия (ndrh_sid). Telegram-2FA без привязанного
// чата — честный отказ с подсказкой /start.

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let captcha: typeof import('@/lib/security/captcha')
let mfa: typeof import('@/lib/engine/mfa')
let login: typeof import('@/app/api/auth/login/route')
let loginVerify: typeof import('@/app/api/auth/login/verify/route')
let rate: typeof import('@/lib/security/ratelimit')
let pw: typeof import('@/lib/security/password')

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

function post(url: string, body: Record<string, unknown>, cookie?: string, ip = '10.5.0.9'): NextRequest {
  return new NextRequest(`http://hub.local${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

/** Пройти капчу честно: выдать и взять ответ из внутреннего хранилища */
function solvedCaptcha(ip = '10.5.0.9'): { id: string; answer: string } {
  const c = captcha.issueCaptcha(new Request('http://hub.local/', { headers: { 'x-forwarded-for': ip } }))
  expect(c.ok).toBe(true)
  if (!c.ok) throw new Error('captcha issue failed')
  return { id: c.id, answer: captcha._peekAnswer(c.id)! }
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-2fa-route-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  captcha = await import('@/lib/security/captcha')
  mfa = await import('@/lib/engine/mfa')
  rate = await import('@/lib/security/ratelimit')
  login = await import('@/app/api/auth/login/route')
  loginVerify = await import('@/app/api/auth/login/verify/route')
  pw = await import('@/lib/security/password')

  await db.user.create({
    data: {
      email: 'totp@example.com', displayName: 'TOTP-юзер', passwordHash: pw.hashPassword('Passw0rd-totp'),
      role: 'user', status: 'active', twoFactor: 'totp', totpSecret: RFC_SECRET,
    },
  })
  await db.user.create({
    data: {
      email: 'tgonly@example.com', displayName: 'ТГ-без-чата', passwordHash: pw.hashPassword('Passw0rd-tg'),
      role: 'user', status: 'active', twoFactor: 'telegram', telegramUsername: 'nochat',
    },
  })
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('POST /api/auth/login + /verify: TOTP-вход', () => {
  it('без капчи (неверный id) — отказ ещё до проверки пароля', async () => {
    const res = await login.POST(post('/api/auth/login', { email: 'totp@example.com', password: 'Passw0rd-totp', captchaId: 'bogus', captchaAnswer: 'AAAAA' }))
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.captchaFailed).toBe(true)
  })

  it('неверная капча (сгорает) — отказ, повторная попытка с той же капчей тоже отказ', async () => {
    const c = solvedCaptcha('10.5.0.11')
    const res1 = await login.POST(post('/api/auth/login', { email: 'totp@example.com', password: 'Passw0rd-totp', captchaId: c.id, captchaAnswer: 'XXXXX' }))
    expect(res1.status).toBe(400)
    // повтор с тем же id и ВЕРНЫМ ответом — капча уже израсходована
    const res2 = await login.POST(post('/api/auth/login', { email: 'totp@example.com', password: 'Passw0rd-totp', captchaId: c.id, captchaAnswer: c.answer }))
    expect(res2.status).toBe(400)
  })

  it('верные данные + TOTP: билет второго шага, без ndrh_sid', async () => {
    const c = solvedCaptcha('10.5.0.12')
    const res = await login.POST(post('/api/auth/login', { email: 'totp@example.com', password: 'Passw0rd-totp', captchaId: c.id, captchaAnswer: c.answer }, undefined, '10.5.0.12'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.mfa).toBe('totp')
    const cookies = res.headers.getSetCookie().join('; ')
    expect(cookies).toContain('ndrh_mfa=')
    expect(cookies).not.toContain('ndrh_sid=')
  })

  it('verify: неверный TOTP → 401; верный → сессия ndrh_sid', async () => {
    const c = solvedCaptcha('10.5.0.13')
    const res = await login.POST(post('/api/auth/login', { email: 'totp@example.com', password: 'Passw0rd-totp', captchaId: c.id, captchaAnswer: c.answer }, undefined, '10.5.0.13'))
    const mfaCookie = res.headers.getSetCookie().find((s) => s.startsWith('ndrh_mfa='))!.split(';')[0]

    const bad = await loginVerify.POST(post('/api/auth/login/verify', { code: '000000' }, mfaCookie, '10.5.0.13'))
    expect(bad.status).toBe(401)

    const good = await loginVerify.POST(post('/api/auth/login/verify', { code: mfa.totpNow(RFC_SECRET) }, mfaCookie, '10.5.0.13'))
    expect(good.status).toBe(200)
    const j = await good.json()
    expect(j.user.email).toBe('totp@example.com')
    const cookies = good.headers.getSetCookie().join('; ')
    expect(cookies).toContain('ndrh_sid=')
    // билет погашен (пустое значение)
    expect(cookies).toMatch(/ndrh_mfa=;/)
  })

  it('verify без билета — 401', async () => {
    const res = await loginVerify.POST(post('/api/auth/login/verify', { code: '123456' }))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/auth/login: Telegram-2FA без привязанного чата', () => {
  it('честный отказ telegramStartRequired с подсказкой', async () => {
    const c = solvedCaptcha('10.5.0.14')
    const res = await login.POST(post('/api/auth/login', { email: 'tgonly@example.com', password: 'Passw0rd-tg', captchaId: c.id, captchaAnswer: c.answer }, undefined, '10.5.0.14'))
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.telegramStartRequired).toBe(true)
  })
})
