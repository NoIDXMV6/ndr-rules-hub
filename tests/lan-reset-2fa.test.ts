import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'

const execFileP = promisify(execFile)

// Аварийный сброс 2FA администратором при входе из локальной сети:
//   - флаг lanResetAvailable в ответе шага 1 (только admin + LAN);
//   - POST /api/auth/login/reset-2fa: билет + admin + LAN + пароль → сброс и сессия;
//   - из интернета (публичный адрес) — отказ всегда;
//   - не-администратору — отказ; неверный пароль — 401 и 2FA не тронута;
//   - жёсткий лимит попыток (5 за 5 минут → блок на 30 минут).

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let captcha: typeof import('@/lib/security/captcha')
let login: typeof import('@/app/api/auth/login/route')
let reset2fa: typeof import('@/app/api/auth/login/reset-2fa/route')
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

function solvedCaptcha(ip: string): { id: string; answer: string } {
  const c = captcha.issueCaptcha(new Request('http://hub.local/', { headers: { 'x-forwarded-for': ip } }))
  expect(c.ok).toBe(true)
  if (!c.ok) throw new Error('captcha issue failed')
  return { id: c.id, answer: captcha._peekAnswer(c.id)! }
}

/** Шаг 1 входа: вернуть ответ (и ndrh_mfa cookie, если выдан) */
async function loginStep1(email: string, password: string, ip: string) {
  const c = solvedCaptcha(ip)
  const res = await login.POST(post('/api/auth/login', { email, password, captchaId: c.id, captchaAnswer: c.answer }, undefined, ip))
  const mfaCookie = res.headers.getSetCookie().find((s) => s.startsWith('ndrh_mfa=') && !s.includes('=;'))?.split(';')[0]
  return { res, body: await res.json(), mfaCookie }
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-lan-reset-'))
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
  login = await import('@/app/api/auth/login/route')
  reset2fa = await import('@/app/api/auth/login/reset-2fa/route')
  rate = await import('@/lib/security/ratelimit')
  pw = await import('@/lib/security/password')

  await db.user.create({
    data: {
      email: 'admin@example.com', displayName: 'Админ', passwordHash: pw.hashPassword('Passw0rd-admin'),
      role: 'admin', status: 'active', twoFactor: 'totp', totpSecret: RFC_SECRET,
    },
  })
  await db.user.create({
    data: {
      email: 'user@example.com', displayName: 'Юзер', passwordHash: pw.hashPassword('Passw0rd-user'),
      role: 'user', status: 'active', twoFactor: 'totp', totpSecret: RFC_SECRET,
    },
  })
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('флаг lanResetAvailable в ответе шага 1', () => {
  it('администратор из локальной сети — true', async () => {
    const { res, body } = await loginStep1('admin@example.com', 'Passw0rd-admin', '10.5.5.1')
    expect(res.status).toBe(200)
    expect(body.mfa).toBe('totp')
    expect(body.lanResetAvailable).toBe(true)
  })

  it('администратор из интернета — false', async () => {
    const { res, body } = await loginStep1('admin@example.com', 'Passw0rd-admin', '93.184.216.34')
    expect(res.status).toBe(200)
    expect(body.lanResetAvailable).toBe(false)
  })

  it('обычный пользователь из локальной сети — false', async () => {
    const { res, body } = await loginStep1('user@example.com', 'Passw0rd-user', '10.5.5.2')
    expect(res.status).toBe(200)
    expect(body.lanResetAvailable).toBe(false)
  })
})

describe('POST /api/auth/login/reset-2fa', () => {
  it('без билета первого шага — 401', async () => {
    const res = await reset2fa.POST(post('/api/auth/login/reset-2fa', { password: 'Passw0rd-admin' }, undefined, '10.6.0.1'))
    expect(res.status).toBe(401)
  })

  it('не-администратор — 403 (2FA не тронута)', async () => {
    rate.resetAllRates()
    const { mfaCookie } = await loginStep1('user@example.com', 'Passw0rd-user', '10.6.0.2')
    expect(mfaCookie).toBeTruthy()
    const res = await reset2fa.POST(post('/api/auth/login/reset-2fa', { password: 'Passw0rd-user' }, mfaCookie, '10.6.0.2'))
    expect(res.status).toBe(403)
    const u = await db.user.findUnique({ where: { email: 'user@example.com' } })
    expect(u?.twoFactor).toBe('totp')
  })

  it('с публичного адреса — 403 даже с билетом и верным паролем', async () => {
    rate.resetAllRates()
    const { mfaCookie } = await loginStep1('admin@example.com', 'Passw0rd-admin', '10.6.0.3')
    expect(mfaCookie).toBeTruthy()
    const res = await reset2fa.POST(post('/api/auth/login/reset-2fa', { password: 'Passw0rd-admin' }, mfaCookie, '93.184.216.34'))
    expect(res.status).toBe(403)
    const j = await res.json()
    expect(j.error).toContain('локальной сети')
  })

  it('неверный пароль — 401, 2FA остаётся включённой', async () => {
    rate.resetAllRates()
    const { mfaCookie } = await loginStep1('admin@example.com', 'Passw0rd-admin', '10.6.0.4')
    const res = await reset2fa.POST(post('/api/auth/login/reset-2fa', { password: 'wrong-pass-1' }, mfaCookie, '10.6.0.4'))
    expect(res.status).toBe(401)
    const u = await db.user.findUnique({ where: { email: 'admin@example.com' } })
    expect(u?.twoFactor).toBe('totp')
    expect(u?.totpSecret).toBe(RFC_SECRET)
  })

  it('верный пароль из LAN: 2FA сброшена, сессия выдана', async () => {
    rate.resetAllRates()
    const { mfaCookie } = await loginStep1('admin@example.com', 'Passw0rd-admin', '10.6.0.5')
    const res = await reset2fa.POST(post('/api/auth/login/reset-2fa', { password: 'Passw0rd-admin' }, mfaCookie, '10.6.0.5'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.user.email).toBe('admin@example.com')
    const cookies = res.headers.getSetCookie().join('; ')
    expect(cookies).toContain('ndrh_sid=')
    expect(cookies).toMatch(/ndrh_mfa=;/) // билет погашен
    const u = await db.user.findUnique({ where: { email: 'admin@example.com' } })
    expect(u?.twoFactor).toBe('none')
    expect(u?.totpSecret).toBeNull()
    // после сброса вход возможен сразу, без второго шага
    rate.resetAllRates()
    const relogin = await loginStep1('admin@example.com', 'Passw0rd-admin', '10.6.0.51')
    expect(relogin.res.status).toBe(200)
    expect(relogin.body.user?.email).toBe('admin@example.com')
  })

  it('жёсткий лимит: 3 неверных пароля — 4-я попытка уже 429 (блок IP)', async () => {
    rate.resetAllRates()
    // предыдущий тест сбросил 2FA админа — восстанавливаем для этого сценария
    await db.user.update({ where: { email: 'admin@example.com' }, data: { twoFactor: 'totp', totpSecret: RFC_SECRET } })
    const ip = '10.6.0.7'
    const { mfaCookie } = await loginStep1('admin@example.com', 'Passw0rd-admin', ip)
    const bad = ['wrong-1', 'wrong-2', 'wrong-3']
    for (const p of bad) {
      const res = await reset2fa.POST(post('/api/auth/login/reset-2fa', { password: p }, mfaCookie, ip))
      expect(res.status).toBe(401)
    }
    const fourth = await reset2fa.POST(post('/api/auth/login/reset-2fa', { password: 'Passw0rd-admin' }, mfaCookie, ip))
    expect(fourth.status).toBe(429)
    // даже верный пароль не проходит, пока блок активен
    const u = await db.user.findUnique({ where: { email: 'admin@example.com' } })
    expect(u?.twoFactor).toBe('totp')
  })

  it('пустой пароль — 400', async () => {
    rate.resetAllRates()
    await db.user.update({ where: { email: 'admin@example.com' }, data: { twoFactor: 'totp', totpSecret: RFC_SECRET } })
    const { mfaCookie } = await loginStep1('admin@example.com', 'Passw0rd-admin', '10.6.0.8')
    const res = await reset2fa.POST(post('/api/auth/login/reset-2fa', { password: '' }, mfaCookie, '10.6.0.8'))
    expect(res.status).toBe(400)
  })
})
