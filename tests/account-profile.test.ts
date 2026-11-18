import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'

const execFileP = promisify(execFile)

// Изменение данных аккаунта (вкладка «Аккаунт»):
//   - update-profile: имя и email меняются при подтверждении ТЕКУЩИМ паролем;
//     email уникален; некорректный email отклоняется;
//   - change-password: текущий пароль проверяется, новый — по политике;
//     после смены все прочие сессии завершаются (текущая сохраняется).

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let account: typeof import('@/app/api/auth/account/route')
let session: typeof import('@/lib/security/session')
let pw: typeof import('@/lib/security/password')
let ownerId: string | null = null // id основного пользователя (email меняется в тестах)

function post(body: Record<string, unknown>, cookie: string): NextRequest {
  return new NextRequest('http://hub.local/api/auth/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.1', cookie },
    body: JSON.stringify(body),
  })
}

function get(cookie: string): NextRequest {
  return new NextRequest('http://hub.local/api/auth/account', {
    method: 'GET',
    headers: { 'x-forwarded-for': '10.9.0.1', cookie },
  })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-account-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  account = await import('@/app/api/auth/account/route')
  session = await import('@/lib/security/session')
  pw = await import('@/lib/security/password')

  await db.user.create({
    data: { email: 'me@example.com', displayName: 'Основной', passwordHash: pw.hashPassword('OldPass0rd'), role: 'user', status: 'active' },
  }).then((u) => { ownerId = u.id })
  await db.user.create({
    data: { email: 'taken@example.com', displayName: 'Занятый', passwordHash: pw.hashPassword('OtherPass1'), role: 'user', status: 'active' },
  })
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

/** Сессия основного пользователя (cookie для guard); email может меняться в тестах */
async function meCookie(): Promise<string> {
  if (!ownerId) throw new Error('seed: основной пользователь не создан')
  const u = await db.user.findUnique({ where: { id: ownerId } })
  if (!u) throw new Error('seed: основной пользователь не найден')
  const { token } = await session.createSession(u.id, '10.9.0.1', 'vitest', null)
  return `${session.SESSION_COOKIE}=${token}`
}

describe('GET /api/auth/account', () => {
  it('отдаёт данные своей учётной записи', async () => {
    const res = await account.GET(get(await meCookie()))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.email).toBe('me@example.com')
    expect(j.displayName).toBe('Основной')
    expect(j.role).toBe('user')
  })

  it('без сессии — 401', async () => {
    const res = await account.GET(get('ndrh_sid=bogus-value-0000000000000000000'))
    expect(res.status).toBe(401)
  })
})

describe('update-profile: имя и email', () => {
  it('неверный текущий пароль — 401, данные не меняются', async () => {
    const res = await account.POST(post({ action: 'update-profile', displayName: 'Новое имя', email: 'me@example.com', password: 'wrong-pass' }, await meCookie()))
    expect(res.status).toBe(401)
    const u = await db.user.findUnique({ where: { email: 'me@example.com' } })
    expect(u?.displayName).toBe('Основной')
  })

  it('email уже занят другим пользователем — 400', async () => {
    const res = await account.POST(post({ action: 'update-profile', displayName: 'Основной', email: 'taken@example.com', password: 'OldPass0rd' }, await meCookie()))
    expect(res.status).toBe(400)
  })

  it('некорректный email — 400', async () => {
    const res = await account.POST(post({ action: 'update-profile', displayName: 'Основной', email: 'не-email', password: 'OldPass0rd' }, await meCookie()))
    expect(res.status).toBe(400)
  })

  it('имя меняется при верном пароле (email тот же)', async () => {
    const res = await account.POST(post({ action: 'update-profile', displayName: 'Обновлённое имя', email: 'me@example.com', password: 'OldPass0rd' }, await meCookie()))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.emailChanged).toBe(false)
    const u = await db.user.findUnique({ where: { email: 'me@example.com' } })
    expect(u?.displayName).toBe('Обновлённое имя')
  })

  it('email меняется на свободный — ok, emailChanged=true', async () => {
    const res = await account.POST(post({ action: 'update-profile', displayName: 'Обновлённое имя', email: 'New@Example.com', password: 'OldPass0rd' }, await meCookie()))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.emailChanged).toBe(true)
    expect(j.email).toBe('new@example.com') // нормализуется к нижнему регистру
    const u = await db.user.findUnique({ where: { email: 'new@example.com' } })
    expect(u?.displayName).toBe('Обновлённое имя')
  })
})

describe('change-password: смена пароля', () => {
  it('неверный текущий пароль — 401', async () => {
    const res = await account.POST(post({ action: 'change-password', currentPassword: 'wrong', newPassword: 'NewPass99x' }, await meCookie()))
    expect(res.status).toBe(401)
  })

  it('новый совпадает с текущим — 400', async () => {
    const res = await account.POST(post({ action: 'change-password', currentPassword: 'OldPass0rd', newPassword: 'OldPass0rd' }, await meCookie()))
    expect(res.status).toBe(400)
  })

  it('новый не по политике (нет цифр/короткий) — 400 со списком проблем', async () => {
    const res = await account.POST(post({ action: 'change-password', currentPassword: 'OldPass0rd', newPassword: 'только-буквы' }, await meCookie()))
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.error).toContain('пароль')
  })

  it('успешная смена: новый работает, старый нет; прочие сессии завершены', async () => {
    if (!ownerId) throw new Error('seed: основной пользователь не создан')
    const u = await db.user.findUnique({ where: { id: ownerId } })
    if (!u) throw new Error('seed: основной пользователь не найден')
    // вторая (чужая) сессия того же пользователя — должна умереть после смены пароля
    const other = await session.createSession(u.id, '10.9.9.9', 'other-device', null)
    const otherReq = new Request('http://hub.local/', { headers: { cookie: `${session.SESSION_COOKIE}=${other.token}` } })
    expect(await session.getSession(otherReq)).not.toBeNull()

    const cookie = await meCookie()
    const res = await account.POST(post({ action: 'change-password', currentPassword: 'OldPass0rd', newPassword: 'NewPass99x' }, cookie))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)

    const updated = await db.user.findUnique({ where: { id: u.id } })
    expect(pw.verifyPassword('NewPass99x', updated!.passwordHash)).toBe(true)
    expect(pw.verifyPassword('OldPass0rd', updated!.passwordHash)).toBe(false)

    // чужая сессия завершена, текущая (cookie запроса) жива
    expect(await session.getSession(otherReq)).toBeNull()
    const sessions = await db.session.findMany({ where: { userId: u.id } })
    expect(sessions).toHaveLength(1)
  })
})
