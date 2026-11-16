import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Сценарий инцидента из продакшена: БД тома старой схемы (без deletedAt,
// без Category/RuleOverride), новый Prisma-клиент ждёт их → P2022
// «The column `deletedAt` does not exist in the current database» на всех API.
// db-heal.cjs должен докатывать схему БЕЗ потери данных.

let work: string
let templateDb: string
let oldDb: string
let manifestPath: string
const tmpDirs: string[] = []

type Manifest = {
  tables: Record<string, { ddl: string; columns: Array<{ name: string; type: string; notnull: number; dflt: string | null; pk: number }> }>
  indexes: Array<{ name: string; table: string; sql: string }>
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-'))
  tmpDirs.push(work)
  templateDb = path.join(work, 'template.db')
  oldDb = path.join(work, 'hub.db')
  manifestPath = path.join(work, 'schema-manifest.json')
  const root = path.resolve(__dirname, '..')
  // 1) свежая БД текущей схемы + манифест (как в Dockerfile на стадии builder)
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: `file:${templateDb}` },
  })
  await execFileP('node', ['scripts/gen-schema-manifest.mjs', templateDb, manifestPath], { cwd: root })
}, 120_000)

afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true })
})

/** node -e с DATABASE_URL на нужный файл: DDL/запросы raw-клиентом */
async function rawDb(dbFile: string, script: string): Promise<string> {
  const r = await execFileP('node', ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
  })
  return r.stdout
}

describe('db-heal: докатка схемы старой БД без потери данных', () => {
  it('манифест содержит текущую схему (deletedAt, Category, RuleOverride)', async () => {
    const m: Manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    expect(m.tables.Source.columns.map((c) => c.name)).toContain('deletedAt')
    expect(m.tables.Category).toBeDefined()
    expect(m.tables.RuleOverride).toBeDefined()
    expect(m.tables.Source.columns.length).toBeGreaterThan(10)
  })

  it('старая БД (без deletedAt/Category/RuleOverride) лечится, данные и настройки сохраняются', async () => {
    const m: Manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

    // старая схема: все текущие таблицы, КРОМЕ Category/RuleOverride,
    // Source — без колонки deletedAt
    const skip = new Set(['Category', 'RuleOverride'])
    const oldSourceDdl = m.tables.Source.ddl
      .split('\n')
      .filter((l) => !l.includes('deletedAt'))
      .join('\n')
    const stmts: string[] = []
    for (const [name, def] of Object.entries(m.tables)) {
      if (skip.has(name)) continue
      stmts.push(name === 'Source' ? oldSourceDdl : def.ddl)
    }
    await rawDb(oldDb, `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      (async () => {
        for (const sql of ${JSON.stringify(stmts)}) await p.$executeRawUnsafe(sql);
        await p.$executeRawUnsafe("INSERT INTO Source (id, name, category, kind, authType, format, enabled, priority, status, ruleCount, sizeBytes, builtin, createdAt, updatedAt) VALUES ('src-old-1', 'Старый источник', 'ruleset', 'url', 'none', 'auto', 1, 62, 'ok', 72788, 12345, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
        await p.$executeRawUnsafe("INSERT INTO Setting (key, value, updatedAt) VALUES ('abusechAuthKey', 'SECRET-DO-NOT-LOSE', CURRENT_TIMESTAMP)");
        await p.$disconnect();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `)

    // лечение
    const out = await execFileP('node', ['scripts/db-heal.cjs', oldDb, manifestPath], {
      cwd: path.resolve(__dirname, '..'),
    })
    expect(out.stdout).toContain('добавлена колонка Source.deletedAt')
    expect(out.stdout).toContain('добавлена таблица Category')
    expect(out.stdout).toContain('добавлена таблица RuleOverride')
    expect(out.stdout).toContain('схема докатана')

    // данные сохранены, схема соответствует текущей
    const res = await rawDb(oldDb, `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      (async () => {
        const s = await p.source.findFirst();
        console.log(JSON.stringify({ name: s.name, status: s.status, ruleCount: s.ruleCount, deletedAt: s.deletedAt, builtin: s.builtin }));
        const st = await p.setting.findUnique({ where: { key: 'abusechAuthKey' } });
        console.log(JSON.stringify({ authKey: st ? st.value : null }));
        console.log(JSON.stringify({ categoryCols: (await p.$queryRawUnsafe('PRAGMA table_info("Category")')).map(c => c.name) }));
        console.log(JSON.stringify({ overrideCols: (await p.$queryRawUnsafe('PRAGMA table_info("RuleOverride")')).map(c => c.name) }));
        await p.$disconnect();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `)
    const lines = res.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ name: 'Старый источник', status: 'ok', ruleCount: 72788, deletedAt: null, builtin: true })
    expect(lines[1]).toEqual({ authKey: 'SECRET-DO-NOT-LOSE' })
    expect(lines[2].categoryCols).toEqual(expect.arrayContaining(['id', 'name', 'enabled', 'hidden']))
    expect(lines[3].overrideCols).toEqual(expect.arrayContaining(['sid', 'enabled', 'note']))
  })

  it('повторный запуск — изменений не требуется (идемпотентность)', async () => {
    const out = await execFileP('node', ['scripts/db-heal.cjs', oldDb, manifestPath], {
      cwd: path.resolve(__dirname, '..'),
    })
    expect(out.stdout).toContain('изменений не требуется')
  })

  it('несуществующая БД — внятный fatal, не крошится', async () => {
    await expect(
      execFileP('node', ['scripts/db-heal.cjs', path.join(work, 'nope.db'), manifestPath], {
        cwd: path.resolve(__dirname, '..'),
      })
    ).rejects.toThrow(/не найдена/)
  })
})
