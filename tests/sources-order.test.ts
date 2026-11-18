import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'

const execFileP = promisify(execFile)

// Стабильный порядок списка источников: API отдаёт источники по времени
// добавления (createdAt asc) — включение/выключение источника НЕ перемещает
// его в списке (раньше orderBy был по enabled — и строка перескакивала).

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let dashboard: typeof import('@/app/api/dashboard/route')
let sourceIdRoute: typeof import('@/app/api/sources/[id]/route')

async function listNames(): Promise<string[]> {
  const res = await dashboard.GET(new NextRequest('http://hub.local/api/dashboard'))
  expect(res.status).toBe(200)
  const j = await res.json()
  return (j.sources.list as Array<{ name: string; deletedAt: string | null }>).filter((s) => !s.deletedAt).map((s) => s.name)
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-src-order-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  // редакция не задана — community: guard пропускает без сессии
  delete process.env.NDR_EDITION
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  dashboard = await import('@/app/api/dashboard/route')
  sourceIdRoute = await import('@/app/api/sources/[id]/route')

  // три пользовательских источника с фиксированным временем создания и
  // РАЗНЫМ enabled: порядок в списке должен быть строго по createdAt
  await db.source.create({
    data: { name: 'order-a-disabled', category: 'ruleset', kind: 'url', url: 'http://x/a.rules', enabled: false, createdAt: new Date('2025-01-01T10:00:00Z') },
  })
  await db.source.create({
    data: { name: 'order-b-enabled', category: 'ruleset', kind: 'url', url: 'http://x/b.rules', enabled: true, createdAt: new Date('2025-01-02T10:00:00Z') },
  })
  await db.source.create({
    data: { name: 'order-c-disabled', category: 'ruleset', kind: 'url', url: 'http://x/c.rules', enabled: false, createdAt: new Date('2025-01-03T10:00:00Z') },
  })
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('порядок источников', () => {
  it('выключенный, созданный РАНЬШЕ, идёт перед включённым, созданным ПОЗЖЕ (не по enabled)', async () => {
    const names = await listNames()
    const a = names.indexOf('order-a-disabled')
    const b = names.indexOf('order-b-enabled')
    const c = names.indexOf('order-c-disabled')
    expect(a).toBeGreaterThanOrEqual(0)
    expect(b).toBeGreaterThan(a) // раньше создан — раньше в списке, хотя выключен
    expect(c).toBeGreaterThan(b) // позже создан — позже в списке, хотя выключен
  })

  it('включение/выключение источника не меняет порядок списка', async () => {
    const before = await listNames()
    const src = await db.source.findFirst({ where: { name: 'order-b-enabled' } })
    if (!src) throw new Error('seed: order-b-enabled не найден')
    // выключаем включённый
    const off = await sourceIdRoute.PATCH(
      new NextRequest('http://hub.local/api/sources/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }),
      { params: Promise.resolve({ id: src.id }) },
    )
    expect(off.status).toBe(200)
    const afterOff = await listNames()
    expect(afterOff).toEqual(before)

    // включаем обратно (теперь уже выключенный) — порядок тоже не меняется
    const on = await sourceIdRoute.PATCH(
      new NextRequest('http://hub.local/api/sources/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }),
      { params: Promise.resolve({ id: src.id }) },
    )
    expect(on.status).toBe(200)
    const afterOn = await listNames()
    expect(afterOn).toEqual(before)
  })
})
