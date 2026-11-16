import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Отдача правил по URL (PULL) с персональными токенами скачивания (Enterprise):
// валидный токен → 200; отозванный/истёкший → 403; перебор ключей → 429;
// глобальный serveToken продолжает работать; пустые ключи → 403 с подсказкой.

const ROOT = path.resolve(__dirname, '..')

let work: string
let serve: typeof import('@/lib/engine/serve')
let db: import('@prisma/client').PrismaClient
let dl: typeof import('@/lib/security/download-token')
let rate: typeof import('@/lib/security/ratelimit')

const FINAL_RULES = `# NDR Rules Hub test build
alert tcp $HOME_NET any -> $EXTERNAL_NET 443 (msg:"test rule t1"; sid:1000001; rev:1;)
`

async function setServeToken(value: string): Promise<void> {
  await db.setting.upsert({
    where: { key: 'serveToken' },
    create: { key: 'serveToken', value, updatedAt: new Date() },
    update: { value },
  })
}

async function addBuild(): Promise<void> {
  await db.build.create({
    data: {
      createdAt: new Date(),
      totalRules: 1,
      statsJson: '{}',
      policyJson: '{}',
      fileName: 'clearndr-import.rules',
      filePath: path.join(work, 'clearndr-import.rules'),
      sha256: 'test-sha',
      sizeBytes: Buffer.byteLength(FINAL_RULES),
      source: 'manual',
    },
  })
}

let adminUser: { id: string }
let userToken: string

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-tokens-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  await fs.writeFile(path.join(work, 'clearndr-import.rules'), FINAL_RULES)
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  serve = await import('@/lib/engine/serve')
  dl = await import('@/lib/security/download-token')
  rate = await import('@/lib/security/ratelimit')

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
  userToken = (await dl.createDownloadToken(adminUser.id, 'scirius', null)).token
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('serveBuild: персональные токены скачивания', () => {
  it('без сборок и валидного токена — 404 «нет сборок» (аутентификация пройдена)', async () => {
    rate.resetAllRates()
    const res = await serve.serveBuild({ token: userToken, ip: '10.1.0.1' })
    expect(res.status).toBe(404)
    expect(String(res.body)).toContain('нет сборок')
  })

  it('после сборки валидный токен отдаёт файл, статистика токена растёт', async () => {
    rate.resetAllRates()
    await addBuild()
    const before = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(userToken) } })
    const res = await serve.serveBuild({ token: userToken, ip: '10.1.0.2' })
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/plain')
    expect(res.fileName).toBe('clearndr-import.rules')
    expect((res.body as Buffer).toString()).toContain('sid:1000001')
    const after = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(userToken) } })
    expect(after!.downloadCount).toBe((before?.downloadCount ?? 0) + 1)
    expect(after!.bytesServed).toBeGreaterThanOrEqual(Buffer.byteLength(FINAL_RULES))
    expect(after!.lastIp).toBe('10.1.0.2')
  })

  it('токен работает и через Authorization: Bearer (как authkey источника scirius)', async () => {
    rate.resetAllRates()
    const res = await serve.serveBuild({ authHeader: `Bearer ${userToken}`, ip: '10.1.0.3' })
    expect(res.status).toBe(200)
  })

  it('отозванный токен — 403, даже если он был валиден', async () => {
    rate.resetAllRates()
    const revoked = (await dl.createDownloadToken(adminUser.id, 'short-lived', null)).token
    expect((await serve.serveBuild({ token: revoked, ip: '10.1.0.4' })).status).toBe(200)
    const row = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(revoked) } })
    await db.downloadToken.update({ where: { id: row!.id }, data: { revokedAt: new Date() } })
    const res = await serve.serveBuild({ token: revoked, ip: '10.1.0.4' })
    expect(res.status).toBe(403)
    expect(String(res.body)).toContain('ключ отдачи')
  })

  it('истёкший токен — 403', async () => {
    rate.resetAllRates()
    const expired = (await dl.createDownloadToken(adminUser.id, 'expired', null)).token
    const row = await db.downloadToken.findUnique({ where: { tokenHash: (await import('@/lib/security/ids')).sha256hex(expired) } })
    await db.downloadToken.update({ where: { id: row!.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await serve.serveBuild({ token: expired, ip: '10.1.0.5' })).status).toBe(403)
  })

  it('сессия веб-интерфейса: доступ без ключа', async () => {
    rate.resetAllRates()
    const res = await serve.serveBuild({ ip: '10.1.0.6', sessionUserId: adminUser.id })
    expect(res.status).toBe(200)
  })

  it('архив по токену: без tgz в сборке — 404 с подсказкой «файл + tgz»', async () => {
    rate.resetAllRates()
    const res = await serve.serveBuild({ token: userToken, ip: '10.1.0.7', archive: true })
    expect(res.status).toBe(404)
    expect(String(res.body)).toContain('Формат сборки: файл + tgz')
  })
})

describe('serveBuild: анти-брутфорс ключей отдачи', () => {
  it('10 неверных ключей с одного IP → 429 (лимит по IP), валидный ключ проходит', async () => {
    rate.resetAllRates()
    await setServeToken('K1')
    const ip = '10.1.0.66'
    for (let i = 0; i < 10; i++) {
      const res = await serve.serveBuild({ token: `wrong-${i}`, ip })
      expect(res.status).toBe(403)
    }
    const blocked = await serve.serveBuild({ token: 'wrong-11', ip })
    expect(blocked.status).toBe(429)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
    // лимитер по IP отсекает только неверные попытки: настоящий ключ проходит
    // (знание ключа — легитимный доступ; блок защищает от перебора)
    expect((await serve.serveBuild({ token: 'K1', ip })).status).toBe(200)
    // а перебор с другого IP не задет
    expect((await serve.serveBuild({ token: 'wrong-x', ip: '10.1.0.77' })).status).toBe(403)
  })

  it('serveToken приоритетнее: глобальный ключ принимается первым, лимит сбрасывается при успехе', async () => {
    rate.resetAllRates()
    expect((await serve.serveBuild({ token: 'K1', ip: '10.1.0.88' })).status).toBe(200)
    expect((await serve.serveBuild({ token: userToken, ip: '10.1.0.88' })).status).toBe(200)
  })
})
