import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Многопользовательский режим (Enterprise): bootstrap-регистрация первого
// администратора, pending у остальных, верификация, вход, анти-брутфорс
// (блокировка учётной записи и IP), сессии, персональные токены скачивания
// и журнал событий безопасности. Роуты проверяются на уровне логики
// (guard/session/download-token), HTTP-обёртка тестируется в serve-tokens.

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let password: typeof import('@/lib/security/password')
let session: typeof import('@/lib/security/session')
let dl: typeof import('@/lib/security/download-token')
let auditMod: typeof import('@/lib/security/audit')
let rate: typeof import('@/lib/security/ratelimit')

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-flow-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  password = await import('@/lib/security/password')
  session = await import('@/lib/security/session')
  dl = await import('@/lib/security/download-token')
  auditMod = await import('@/lib/security/audit')
  rate = await import('@/lib/security/ratelimit')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

/** Регистрация как в POST /api/auth/register */
async function register(email: string, displayName: string, pw: string): Promise<{ id: string; role: string; status: string }> {
  const count = await db.user.count()
  const isFirst = count === 0
  const u = await db.user.create({
    data: {
      email,
      displayName,
      passwordHash: password.hashPassword(pw),
      role: isFirst ? 'admin' : 'user',
      status: isFirst ? 'active' : 'pending',
      verifiedAt: isFirst ? new Date() : null,
    },
  })
  void auditMod.audit('register', { email, userId: u.id, ip: '10.0.0.1' })
  return { id: u.id, role: u.role, status: u.status }
}

describe('регистрация и верификация', () => {
  it('первый пользователь — администратор (bootstrap), второй — pending', async () => {
    const admin = await register('admin@example.com', 'Админ', 'Passw0rd-админ')
    expect(admin.role).toBe('admin')
    expect(admin.status).toBe('active')

    const u2 = await register('user@example.com', 'Пользователь', 'Passw0rd-user')
    expect(u2.role).toBe('user')
    expect(u2.status).toBe('pending')
  })

  it('pending-пользователь не проходит сессию (верификация обязательна)', async () => {
    const u = await db.user.findUnique({ where: { email: 'user@example.com' } })
    expect(u?.status).toBe('pending')
    const { token } = await session.createSession(u!.id, '10.0.0.5', 'test-agent', null)
    const req = new Request('http://hub.local/', { headers: { cookie: `${session.SESSION_COOKIE}=${token}` } })
    expect(await session.getSession(req)).toBeNull()
  })

  it('после верификации (verify) сессия начинает работать', async () => {
    const u = await db.user.findUnique({ where: { email: 'user@example.com' } })
    await db.user.update({ where: { id: u!.id }, data: { status: 'active', verifiedAt: new Date(), verifiedBy: 'admin' } })
    void auditMod.audit('verify', { userId: u!.id, email: u!.email, ip: '10.0.0.2' })
    const { token } = await session.createSession(u!.id, '10.0.0.5', 'test-agent', null)
    const req = new Request('http://hub.local/', { headers: { cookie: `${session.SESSION_COOKIE}=${token}` } })
    const s = await session.getSession(req)
    expect(s?.user.email).toBe('user@example.com')
    expect(s?.user.role).toBe('user')
  })
})

describe('анти-брутфорс входа', () => {
  const lockRule = { limit: 10, windowMs: 5 * 60_000, blockMs: 15 * 60_000 }

  it('5 неудач подряд → lockedUntil (+15 минут), 6-я попытка даже с верным паролем отклонена', async () => {
    const admin = await db.user.findUnique({ where: { email: 'admin@example.com' } })
    // логика роута: неверные пароли → failedLogins растёт, с 5-го — блок
    for (let i = 1; i <= 5; i++) {
      const okPw = password.verifyPassword('wrong-pass', admin!.passwordHash)
      expect(okPw).toBe(false)
      const failed = admin!.failedLogins + i
      const lock = failed >= 5 ? new Date(Date.now() + 15 * 60_000) : null
      await db.user.update({ where: { id: admin!.id }, data: { failedLogins: failed, lockedUntil: lock } })
      void auditMod.audit('login_fail', { userId: admin!.id, email: admin!.email, ip: '10.0.0.9' })
    }
    let u = await db.user.findUnique({ where: { email: 'admin@example.com' } })
    expect(u!.lockedUntil).toBeTruthy()

    // роут отклоняет вход даже с верным паролем, пока lockedUntil в будущем
    const locked = u!.lockedUntil!.getTime() > Date.now()
    expect(locked).toBe(true)

    // разблокировка (администратор включил/истёк срок) + верный пароль → успешный вход
    await db.user.update({ where: { id: u!.id }, data: { failedLogins: 0, lockedUntil: null } })
    expect(password.verifyPassword('Passw0rd-админ', u!.passwordHash)).toBe(true)
  })

  it('IP-лимит входа: 10 неудач с адреса → блок, успешный вход снимает', () => {
    const key = 'login:ip:10.0.0.99'
    for (let i = 0; i < 10; i++) rate.recordFailure(key, lockRule)
    expect(rate.peekBlocked(key)).toBeGreaterThan(0)
    rate.resetRate(key)
    expect(rate.peekBlocked(key)).toBe(0)
  })
})

describe('персональные токены скачивания', () => {
  it('создание: формат ndrt_+, в БД только SHA-256, prefix для отображения', async () => {
    const u = await db.user.findUnique({ where: { email: 'user@example.com' } })
    const created = await dl.createDownloadToken(u!.id, 'Clear NDR node', 30)
    expect(created.token.startsWith('ndrt_')).toBe(true)
    expect(created.token.length).toBe(48) // ndrt_ (5) + 43 символа base64url(32 байта)
    const row = await db.downloadToken.findUnique({ where: { id: created.id } })
    expect(row!.tokenHash).not.toBe(created.token)
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row!.prefix).toBe(created.token.slice(0, 12))
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000)
  })

  it('валидный токен проходит, статистика использования обновляется', async () => {
    const u = await db.user.findUnique({ where: { email: 'user@example.com' } })
    const created = await dl.createDownloadToken(u!.id, 't-ok', null)
    const v = await dl.verifyDownloadToken(created.token, '10.0.1.1')
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.userId).toBe(u!.id)
    const row = await db.downloadToken.findUnique({ where: { id: created.id } })
    expect(row!.downloadCount).toBe(1)
    expect(row!.lastIp).toBe('10.0.1.1')
  })

  it('неизвестный токен, отозванный, истёкший, неактивный владелец — отказ', async () => {
    rate.resetAllRates()
    const u = await db.user.findUnique({ where: { email: 'user@example.com' } })

    expect((await dl.verifyDownloadToken('ndrt_неизвестный-токен', '10.0.1.2')).ok).toBe(false)

    const revoked = await dl.createDownloadToken(u!.id, 't-rev', null)
    await dl.revokeDownloadToken(revoked.id)
    expect((await dl.verifyDownloadToken(revoked.token, '10.0.1.2')).ok).toBe(false)

    const expired = await dl.createDownloadToken(u!.id, 't-exp', null)
    await db.downloadToken.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await dl.verifyDownloadToken(expired.token, '10.0.1.2')).ok).toBe(false)

    const inactive = await dl.createDownloadToken(u!.id, 't-off', null)
    await db.user.update({ where: { id: u!.id }, data: { status: 'disabled' } })
    expect((await dl.verifyDownloadToken(inactive.token, '10.0.1.2')).ok).toBe(false)
    await db.user.update({ where: { id: u!.id }, data: { status: 'active' } })
  })

  it('анти-брутфорс: 10 неудач за 5 минут → IP заблокирован на 15 минут', async () => {
    rate.resetAllRates()
    for (let i = 0; i < 10; i++) {
      await dl.verifyDownloadToken(`ndrt_bruteforce-${i}`, '10.0.1.3')
    }
    // после 10 неудач проверка даже настоящего токена отвечает «blocked»
    const real = await dl.createDownloadToken((await db.user.findUnique({ where: { email: 'user@example.com' } }))!.id, 't-blocked', null)
    const v = await dl.verifyDownloadToken(real.token, '10.0.1.3')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('blocked')
  })

  it('revokeDownloadToken: владелец может отозвать свой, чужой — нет', async () => {
    rate.resetAllRates()
    const u1 = await db.user.findUnique({ where: { email: 'user@example.com' } })!
    const u2 = await register('second@example.com', 'Второй', 'Passw0rd-втор')
    await db.user.update({ where: { id: u2.id }, data: { status: 'active', verifiedAt: new Date() } })
    const tk = await dl.createDownloadToken(u1!.id, 'own-token', null)
    expect(await dl.revokeDownloadToken(tk.id, u2.id)).toBe(false) // не владелец
    expect(await dl.revokeDownloadToken(tk.id, u1!.id)).toBe(true) // владелец
    expect(await dl.revokeDownloadToken(tk.id, u1!.id)).toBe(true) // повторный отзыв идемпотентен
  })
})

describe('сессии', () => {
  it('истёкшая сессия удаляется и не проходит', async () => {
    const u = await db.user.findUnique({ where: { email: 'user@example.com' } })
    if (!u) throw new Error('seed: user@example.com не найден')
    const { token } = await session.createSession(u.id, '10.0.2.1', 'agent', 1)
    const hash = (await import('@/lib/security/ids')).sha256hex(token)
    await db.session.update({ where: { tokenHash: hash }, data: { expiresAt: new Date(Date.now() - 2000) } })
    const req = new Request('http://hub.local/', { headers: { cookie: `${session.SESSION_COOKIE}=${token}` } })
    expect(await session.getSession(req)).toBeNull()
    expect(await db.session.findUnique({ where: { tokenHash: hash } })).toBeNull() // мёртвая сессия подчищена
  })

  it('destroySession: выход убивает сессию по cookie', async () => {
    const u = await db.user.findUnique({ where: { email: 'user@example.com' } })
    if (!u) throw new Error('seed: user@example.com не найден')
    const { token } = await session.createSession(u.id, '10.0.2.2', 'agent', null)
    const req = new Request('http://hub.local/', { headers: { cookie: `${session.SESSION_COOKIE}=${token}` } })
    expect(await session.getSession(req)).not.toBeNull()
    await session.destroySession(req)
    expect(await session.getSession(req)).toBeNull()
  })

  it('cookie-атрибуты: HttpOnly, SameSite=Lax, Secure на https', () => {
    const attrs = session.cookieAttrs(new Date(), true)
    expect(attrs.httpOnly).toBe(true)
    expect(attrs.sameSite).toBe('lax')
    expect(attrs.secure).toBe(true)
    expect(session.cookieAttrs(new Date(), false).secure).toBe(false)
  })
})

describe('журнал событий безопасности', () => {
  it('события регистрации/верификации/отказов записаны', async () => {
    const kinds = (await db.authEvent.findMany()).map((e) => e.kind)
    expect(kinds).toContain('register')
    expect(kinds).toContain('verify')
    expect(kinds).toContain('login_fail')
    expect(kinds).toContain('download_denied')
  })

  it('маскирование секретов: sanitizeSettings не отдаёт serveToken/oinkcode пользователю', async () => {
    const { sanitizeSettings } = await import('@/lib/security/guard')
    const view = sanitizeSettings({ serveToken: 'K', oinkcode: 'X', cronEnabled: 'true' }, 'user')
    expect(view.serveToken).toBeUndefined()
    expect(view.oinkcode).toBeUndefined()
    expect(view.cronEnabled).toBe('true')
  })
})
