import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'

const execFileP = promisify(execFile)

// Жизненный цикл токенов скачивания через HTTP-маршрут /api/tokens/:id
// (Enterprise: guard требует сессию):
//   DELETE  — отозвать (РЕГРЕССИЯ v1.24.0: обработчик DELETE был случайно
//             заменён на PATCH, кнопка «Отозвать» получала HTTP 405);
//   PATCH {"action":"restore"} — вернуть отозванный;
//   PATCH {"action":"delete"}  — удалить навсегда.
// Цикл проверяется целиком: create → revoke → restore → revoke → delete.

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let dl: typeof import('@/lib/security/download-token')
let session: typeof import('@/lib/security/session')
let tokenRoute: typeof import('@/app/api/tokens/[id]/route')

let adminUser: { id: string }
let cookie: string

function req(method: string, id: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://hub.local/api/tokens/${id}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as NextRequest
}

async function call(method: string, id: string, body?: Record<string, unknown>) {
  const handler = method === 'DELETE' ? tokenRoute.DELETE : tokenRoute.PATCH
  return handler(req(method, id, body), { params: Promise.resolve({ id }) })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-token-routes-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  dl = await import('@/lib/security/download-token')
  session = await import('@/lib/security/session')
  tokenRoute = await import('@/app/api/tokens/[id]/route')

  adminUser = await db.user.create({
    data: {
      email: 'admin@test.local',
      displayName: 'Админ',
      passwordHash: 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88),
      role: 'admin',
      status: 'active',
      verifiedAt: new Date(),
    },
    select: { id: true },
  })
  const s = await session.createSession(adminUser.id, '10.7.0.1', 'vitest')
  cookie = `${session.SESSION_COOKIE}=${s.token}`
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('маршрут /api/tokens/:id: revoke → restore → delete', () => {
  it('DELETE отзывает токен (раньше — HTTP 405): revokedAt заполнен', async () => {
    const t = await dl.createDownloadToken(adminUser.id, 'revoke-me', null)
    const res = await call('DELETE', t.id)
    expect(res.status).toBe(200)
    const row = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(t.token) } })
    expect(row?.revokedAt).not.toBeNull()
  })

  it('PATCH restore возвращает отозванный токен, повторный restore — 404', async () => {
    const t = await dl.createDownloadToken(adminUser.id, 'restore-me', null)
    let row = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(t.token) } })
    await db.downloadToken.update({ where: { id: row!.id }, data: { revokedAt: new Date() } })

    const res = await call('PATCH', row!.id, { action: 'restore' })
    expect(res.status).toBe(200)
    row = await db.downloadToken.findUnique({ where: { id: row!.id } })
    expect(row?.revokedAt).toBeNull()

    const again = await call('PATCH', row!.id, { action: 'restore' })
    expect(again.status).toBe(404) // не был отозван — восстанавливать нечего
  })

  it('PATCH delete удаляет токен навсегда; DELETE несуществующего — 404', async () => {
    const t = await dl.createDownloadToken(adminUser.id, 'delete-me', null)
    const row = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(t.token) } })
    const res = await call('PATCH', row!.id, { action: 'delete' })
    expect(res.status).toBe(200)
    expect(await db.downloadToken.findUnique({ where: { id: row!.id } })).toBeNull()

    const gone = await call('DELETE', row!.id)
    expect(gone.status).toBe(404)
  })

  it('без сессии — 401 на оба метода', async () => {
    const t = await dl.createDownloadToken(adminUser.id, 'no-session', null)
    const row = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(t.token) } })
    const savedCookie = cookie
    cookie = ''
    expect((await call('DELETE', row!.id)).status).toBe(401)
    expect((await call('PATCH', row!.id, { action: 'delete' })).status).toBe(401)
    cookie = savedCookie
  })

  it('PATCH с неизвестным действием — 400', async () => {
    const t = await dl.createDownloadToken(adminUser.id, 'bad-action', null)
    const row = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(t.token) } })
    const res = await call('PATCH', row!.id, { action: 'reboot' })
    expect(res.status).toBe(400)
  })
})
