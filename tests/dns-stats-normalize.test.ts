// v1.40.0 — регрессионный тест краша вкладки «DNS списки → Сборка и экспорт».
// Сборки, сохранённые до появления новых полей статистики (droppedDead —
// v1.37.0 и т.п.), не содержат их в statsJson; lastDomainBuild обязан
// нормализовать недостающие числовые поля нулями (раньше рендер падал
// «Cannot read properties of undefined (reading 'toLocaleString')», а битый
// statsJson ронял весь GET /api/dns/build).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)
const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let dnsService: typeof import('@/lib/engine/dns-service')

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-dnsstats-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  dnsService = await import('@/lib/engine/dns-service')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('lastDomainBuild: нормализация statsJson старых сборок (v1.40.0)', () => {
  it('старая сборка без droppedDead/forcedBlock и без части числовых полей — все поля числа', async () => {
    // формат statsJson, сохранённый сборкой до v1.37.0: droppedDead нет
    const oldStats = {
      totalInput: 125000,
      uniqueSids: 123000,
      duplicateByDomain: 1500,
      allowedRemoved: 500,
      categoryRemoved: 0,
      overrideRemoved: 12,
      tldCount: 7,
      perSource: {
        'yoyo adservers': { total: 3567, kept: 3560, droppedDuplicate: 7, droppedAllowed: 0, droppedCategory: 0, droppedOverride: 0 },
        'StevenBlack hosts': { total: 76100, kept: 76000, droppedDuplicate: 100, droppedAllowed: 0, droppedCategory: 0, droppedOverride: 0 },
      },
    }
    await db.domainBuild.create({
      data: {
        totalDomains: 122000,
        statsJson: JSON.stringify(oldStats),
        fileName: 'blocked-domains.txt',
        filePath: path.join(work, 'blocked-domains.txt'),
        sha256: 'a'.repeat(64),
        sizeBytes: 1234567,
        source: 'manual',
      },
    })
    const b = await dnsService.lastDomainBuild()
    expect(b).not.toBeNull()
    const per = (b!.stats as Record<string, Record<string, Record<string, number>>>).perSource
    expect(Object.keys(per).sort()).toEqual(['StevenBlack hosts', 'yoyo adservers'])
    for (const [, st] of Object.entries(per)) {
      for (const field of ['total', 'kept', 'droppedDuplicate', 'droppedAllowed', 'droppedCategory', 'droppedOverride', 'droppedDead']) {
        expect(typeof st[field]).toBe('number')
      }
      expect(st.droppedDead).toBe(0) // поле появилось в v1.37.0 — восполняется нулём
    }
    // недостающие верхнеуровневые поля тоже числа (0)
    const stats = b!.stats as Record<string, number>
    for (const field of ['totalInput', 'duplicateByDomain', 'allowedRemoved', 'categoryRemoved', 'overrideRemoved', 'deadRemoved', 'forcedBlock', 'tldCount']) {
      expect(typeof stats[field]).toBe('number')
    }
    expect(stats.deadRemoved).toBe(0)
    expect(stats.forcedBlock).toBe(0)
    // сохранённые числа не искажаются
    expect(stats.totalInput).toBe(125000)
    expect(stats.duplicateByDomain).toBe(1500)
    expect(per['yoyo adservers'].kept).toBe(3560)
  })

  it('битый statsJson не роняет чтение — пустая нормализованная статистика', async () => {
    await db.domainBuild.create({
      data: {
        totalDomains: 0,
        statsJson: '{"totalInput": 100, "perSource": {"x": {"total": 1', // обрезанный JSON
        fileName: 'broken.txt',
        filePath: path.join(work, 'broken.txt'),
        sha256: 'b'.repeat(64),
        sizeBytes: 1,
        source: 'cron',
      },
    })
    const b = await dnsService.lastDomainBuild()
    expect(b).not.toBeNull()
    const stats = b!.stats as Record<string, unknown>
    expect(stats.totalInput).toBe(0)
    expect(stats.perSource).toEqual({})
    expect(typeof stats.deadRemoved).toBe('number')
  })
})
