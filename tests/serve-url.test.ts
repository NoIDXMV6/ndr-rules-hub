import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// PULL-схема: GET /api/export отдаёт последнюю сборку URL-источнику Clear NDR
// (scirius). serveBuild — логика отдачи: защита ключом serveToken (?token= или
// заголовок Authorization — scirius отправляет authkey источника), файл
// (datatype «sig») и tgz-архив по источникам (?archive=1, datatype «sigs»).

const ROOT = path.resolve(__dirname, '..')

let work: string
let serve: typeof import('@/lib/engine/serve')
let db: import('@prisma/client').PrismaClient

const FINAL_RULES = `# NDR Rules Hub test build
alert tcp $HOME_NET any -> $EXTERNAL_NET 443 (msg:"test rule t1"; sid:1000001; rev:1;)
alert http $HOME_NET any -> $EXTERNAL_NET any (msg:"test rule t2"; sid:1000002; rev:1;)
`
const TGZ_BYTES = Buffer.from('TARBALL-BYTES-OF-THE-PER-SOURCE-ARCHIVE')

async function setServeToken(value: string): Promise<void> {
  await (db as unknown as { setting: { upsert: (a: unknown) => Promise<unknown> } }).setting.upsert({
    where: { key: 'serveToken' },
    create: { key: 'serveToken', value, updatedAt: new Date() },
    update: { value },
  })
}

type Build = {
  createdAt: Date
  totalRules: number
  statsJson: string
  policyJson: string
  fileName: string
  filePath: string
  sha256: string
  sizeBytes: number
  source: string
}

async function addBuild(data: Partial<Build> & { filePath: string }): Promise<void> {
  await (db as unknown as { build: { create: (a: unknown) => Promise<unknown> } }).build.create({
    data: {
      createdAt: data.createdAt ?? new Date(),
      totalRules: data.totalRules ?? 2,
      statsJson: data.statsJson ?? '{}',
      policyJson: data.policyJson ?? '{}',
      fileName: data.fileName ?? 'clearndr-import.rules',
      filePath: data.filePath,
      sha256: data.sha256 ?? 'test-sha',
      sizeBytes: data.sizeBytes ?? Buffer.byteLength(FINAL_RULES),
      source: data.source ?? 'manual',
    },
  })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-url-'))
  const dbFile = path.join(work, 'hub.db')
  process.env.DATABASE_URL = `file:${dbFile}`
  process.env.RULES_DATA_DIR = work
  // свежая БД текущей схемы (как в db-heal.test.ts)
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
  })
  // артефакты сборки
  await fs.writeFile(path.join(work, 'clearndr-import.rules'), FINAL_RULES)
  await fs.writeFile(path.join(work, 'clearndr-import.tgz'), TGZ_BYTES)
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  serve = await import('@/lib/engine/serve')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('serveBuild: защита ключом и пустая база', () => {
  it('без сборок — 404 с внятным текстом', async () => {
    const res = await serve.serveBuild()
    expect(res.status).toBe(404)
    expect(String(res.body)).toContain('нет сборок')
  })

  it('ключ задан: без ключа и с неверным (query/Authorization) — 403 с подсказкой', async () => {
    await setServeToken('K1')
    for (const opts of [{}, { token: 'wrong' }, { token: '   ' }, { authHeader: 'Token wrong' }, { authHeader: 'Bearer wrong' }]) {
      const res = await serve.serveBuild(opts)
      expect(res.status).toBe(403)
      expect(String(res.body)).toContain('ключ отдачи')
    }
  })

  it('верный ключ — ?token=, сырой Authorization, Token/Bearer — пропускает к проверке сборок', async () => {
    for (const opts of [
      { token: 'K1' },
      { authHeader: 'K1' },
      { authHeader: 'Token K1' },
      { authHeader: 'Bearer K1' },
    ]) {
      const res = await serve.serveBuild(opts)
      expect(res.status).toBe(404) // ключ принят → дошло до «нет сборок»
      expect(String(res.body)).toContain('нет сборок')
    }
  })

  it('?token= при наличии имеет приоритет над заголовком: неверный параметр — 403, даже если заголовок валиден', async () => {
    const res = await serve.serveBuild({ token: 'wrong', authHeader: 'Token K1' })
    expect(res.status).toBe(403)
  })
})

describe('serveBuild: файл и архив последней сборки', () => {
  beforeAll(async () => {
    await addBuild({
      createdAt: new Date(Date.now() - 60_000),
      filePath: path.join(work, 'clearndr-import.rules'),
      statsJson: '{}',
    })
    await addBuild({
      createdAt: new Date(),
      filePath: path.join(work, 'clearndr-import.rules'),
      statsJson: JSON.stringify({ archive: { filePath: path.join(work, 'clearndr-import.tgz'), fileName: 'clearndr-import.tgz' } }),
    })
  })

  it('файл: содержимое последней сборки, имя файла, text/plain (при K1-ключе)', async () => {
    const res = await serve.serveBuild({ token: 'K1' })
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/plain')
    expect(res.fileName).toBe('clearndr-import.rules')
    expect((res.body as Buffer).toString()).toContain('sid:1000002')
  })

  it('архив: stats.archive по последней сборке, application/gzip', async () => {
    const res = await serve.serveBuild({ archive: true, token: 'K1' })
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('application/gzip')
    expect(res.fileName).toBe('clearndr-import.tgz')
    expect((res.body as Buffer).toString()).toBe(TGZ_BYTES.toString())
  })
})

describe('serveBuild: деградации последней сборки', () => {
  it('в сборке нет архива — 404 с подсказкой про «файл + tgz»', async () => {
    const last = await (db as unknown as { build: { findFirst: (a: unknown) => Promise<{ id: string } | null> } }).build.findFirst({ orderBy: { createdAt: 'desc' } })
    expect(last).toBeTruthy()
    await (db as unknown as { build: { update: (a: unknown) => Promise<unknown> } }).build.update({
      where: { id: (last as { id: string }).id },
      data: { statsJson: '{}' },
    })
    const res = await serve.serveBuild({ archive: true, token: 'K1' })
    expect(res.status).toBe(404)
    expect(String(res.body)).toContain('Формат сборки: файл + tgz')
  })

  it('файл сборки пропал с диска — 404 с путём', async () => {
    const last = await (db as unknown as { build: { findFirst: (a: unknown) => Promise<{ id: string } | null> } }).build.findFirst({ orderBy: { createdAt: 'desc' } })
    const missing = path.join(work, 'deleted.rules')
    await (db as unknown as { build: { update: (a: unknown) => Promise<unknown> } }).build.update({
      where: { id: (last as { id: string }).id },
      data: { filePath: missing },
    })
    const res = await serve.serveBuild({ token: 'K1' })
    expect(res.status).toBe(404)
    expect(String(res.body)).toContain(missing)
  })
})
