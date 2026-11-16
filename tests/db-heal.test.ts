import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Сценарии инцидентов из продакшена:
// 1) БД тома старой схемы (без deletedAt, без Category/RuleOverride), новый
//    Prisma-клиент ждёт их → P2022 «The column `deletedAt` does not exist
//    in the current database» на всех API — db-heal.cjs докатывает схему
//    БЕЗ потери данных.
// 2) SQLITE_CORRUPT «database disk image is malformed» (extended_code 11):
//    битые страницы данных. ALTER TABLE по странице 1 может «успешно» пройти
//    на повреждённой БД — приложение стартует, но падает на каждом запросе.
//    db-heal обязан сначала прогонять PRAGMA integrity_check и уметь
//    восстанавливаться из снимков (.preheal-*/.bak-*), а entrypoint — не
//    оставлять хвостовые -wal/-shm при подмене файла БД.

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

const ROOT = path.resolve(__dirname, '..')

/** node -e с DATABASE_URL на нужный файл: DDL/запросы raw-клиентом */
async function rawDb(dbFile: string, script: string): Promise<string> {
  const r = await execFileP('node', ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
  })
  return r.stdout
}

/** БД старой схемы (как в инциденте P2022): все таблицы, кроме Category/RuleOverride; Source — без deletedAt */
async function makeOldSchemaDb(dbFile: string, rows: string[] = []): Promise<void> {
  const m: Manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
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
  await rawDb(dbFile, `
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    (async () => {
      for (const sql of ${JSON.stringify(stmts)}) await p.$executeRawUnsafe(sql);
      for (const sql of ${JSON.stringify(rows)}) await p.$executeRawUnsafe(sql);
      await p.$disconnect();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `)
}

/** Повреждение страницы 1 (после 100-байтового заголовка SQLite): sqlite_master нечитаем → SQLITE_CORRUPT */
async function corruptPage1(file: string): Promise<void> {
  const buf = await fs.readFile(file)
  buf.fill(0xff, 100, Math.min(buf.length, 4200))
  await fs.writeFile(file, buf)
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
        cwd: ROOT,
      })
    ).rejects.toThrow(/не найдена/)
  })
})

describe('db-heal: повреждённая БД (SQLITE_CORRUPT «database disk image is malformed»)', () => {
  it('восстанавливается из последнего здорового снимка (.preheal-*) и докатывает схему', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-corrupt-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'hub.db')
    const snapDb = path.join(dir, 'snap-source.db')
    // снимок — то, что db-heal оставляет перед ALTER'ами (VACUUM INTO):
    // старая схема, но консистентные данные с ключом abuse.ch
    await makeOldSchemaDb(snapDb, [
      "INSERT INTO Source (id, name, category, kind, authType, format, enabled, priority, status, ruleCount, sizeBytes, builtin, createdAt, updatedAt) VALUES ('src-snap-1', 'Снимок-источник', 'ruleset', 'url', 'none', 'auto', 1, 62, 'ok', 72788, 12345, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      "INSERT INTO Setting (key, value, updatedAt) VALUES ('abusechAuthKey', 'KEY-FROM-SNAPSHOT', CURRENT_TIMESTAMP)",
    ])
    await fs.copyFile(snapDb, path.join(dir, 'hub.db.preheal-2026-01-01T00-00-00'))
    // живая БД: данные чуть новее, но страницы побиты
    await makeOldSchemaDb(db, [
      "INSERT INTO Source (id, name, category, kind, authType, format, enabled, priority, status, ruleCount, sizeBytes, builtin, createdAt, updatedAt) VALUES ('src-live-1', 'Битый-источник', 'ruleset', 'url', 'none', 'auto', 1, 62, 'ok', 1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      "INSERT INTO Setting (key, value, updatedAt) VALUES ('abusechAuthKey', 'KEY-CORRUPT', CURRENT_TIMESTAMP)",
    ])
    await corruptPage1(db)

    const out = await execFileP('node', ['scripts/db-heal.cjs', db, manifestPath], { cwd: ROOT })
    expect(out.stdout).toContain('integrity_check НЕ ПРОЙДЕН')
    expect(out.stdout).toContain('восстановлена из снимка hub.db.preheal-')
    expect(out.stdout).toContain('добавлена колонка Source.deletedAt')
    expect(out.stdout).toContain('схема докатана')

    // данные — из снимка (несброшенные строки битой БД утрачены), схема — текущая
    const res = await rawDb(db, `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      (async () => {
        const s = await p.source.findFirst();
        const st = await p.setting.findUnique({ where: { key: 'abusechAuthKey' } });
        const tbls = (await p.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table'")).map(t => t.name);
        console.log(JSON.stringify({ name: s.name, authKey: st.value, deletedAt: s.deletedAt, hasCategory: tbls.includes('Category') }));
        await p.$disconnect();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `)
    expect(JSON.parse(res.trim())).toEqual({ name: 'Снимок-источник', authKey: 'KEY-FROM-SNAPSHOT', deletedAt: null, hasCategory: true })
  })

  it('повреждённая БД без снимков — FATAL (код 1), файл не изменён', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-fatal-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'hub.db')
    await makeOldSchemaDb(db)
    await corruptPage1(db)
    const before = await fs.readFile(db)

    const err: any = await execFileP('node', ['scripts/db-heal.cjs', db, manifestPath], { cwd: ROOT }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String(err.stderr ?? err.message)).toContain('повреждена')
    expect(String(err.stdout ?? '')).toContain('снимков для восстановления нет')
    expect(err.code).toBe(1)

    const after = await fs.readFile(db)
    expect(Buffer.compare(before, after)).toBe(0)
  })
})

describe('docker-entrypoint.sh: подмена БД не оставляет хвостовые WAL', () => {
  it('повреждённая БД: бэкап db+wal+shm, свежий шаблон, валидная схема', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-data-'))
    const tmpl = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-tmpl-'))
    tmpDirs.push(dir, tmpl)
    await fs.copyFile(templateDb, path.join(tmpl, 'hub.db'))
    await fs.writeFile(path.join(tmpl, '.schema-version'), 'ep-test-ver')

    const db = path.join(dir, 'hub.db')
    await fs.copyFile(templateDb, db)
    await corruptPage1(db)
    await fs.writeFile(`${db}-wal`, Buffer.from('stale wal of another db'))
    await fs.writeFile(`${db}-shm`, Buffer.from('stale shm'))

    // запускабельная копия entrypoint с подставленными путями
    const ep = await fs.readFile(path.join(ROOT, 'docker-entrypoint.sh'), 'utf8')
    const patched = ep
      .replaceAll('/app/data', dir)
      .replaceAll('/app/db-template', tmpl)
      .replace('node /app/db-heal.cjs', `node ${path.join(ROOT, 'scripts/db-heal.cjs')}`)
      .replace('exec "$@"', 'echo EP_DONE')
    const epPath = path.join(dir, 'entrypoint-test.sh')
    await fs.writeFile(epPath, patched, { mode: 0o755 })

    const r = await execFileP('sh', [epPath], { cwd: ROOT })
    expect(r.stdout).toContain('бэкап ->')
    expect(r.stdout).toContain('создаётся новая из шаблона')
    // хвостовые WAL не остались (иначе старый WAL лёг бы на новый файл)
    expect(existsSync(`${db}-wal`)).toBe(false)
    expect(existsSync(`${db}-shm`)).toBe(false)
    // бэкап: сам файл + его wal уехали вместе
    const files = await fs.readdir(dir)
    const bak = files.filter((n) => n.startsWith('hub.db.bak-') && !n.endsWith('-wal') && !n.endsWith('-shm'))
    expect(bak).toHaveLength(1)
    expect(files).toContain(`${bak[0]}-wal`)
    expect(await fs.readFile(path.join(dir, '.schema-version'), 'utf8')).toContain('ep-test-ver')

    // новая БД из шаблона валидна: integrity ok, схема текущая
    const res = await rawDb(db, `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      (async () => {
        const ic = await p.$queryRawUnsafe('PRAGMA integrity_check');
        const cols = (await p.$queryRawUnsafe('PRAGMA table_info("Source")')).map(c => c.name);
        console.log(JSON.stringify({ integrity: ic.map(v => Object.values(v)[0]).join(','), hasDeletedAt: cols.includes('deletedAt') }));
        await p.$disconnect();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `)
    expect(JSON.parse(res.trim())).toEqual({ integrity: 'ok', hasDeletedAt: true })
  })
})
