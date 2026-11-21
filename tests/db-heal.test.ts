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
    // v1.36.0: битая страница 1 ловится дешёвой структурной проверкой (без скана)
    expect(out.stdout).toContain('структурная проверка НЕ ПРОЙДЕНА')
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

describe('db-heal v1.36.0: bounded-сканы, таймауты, коды выхода (инцидент: пустые логи, контейнер unhealthy)', () => {
  it('здоровая БД — скан целостности ok (quick_check(25)), код 0', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-ok-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'hub.db')
    await fs.copyFile(templateDb, db)
    const out = await execFileP('node', ['scripts/db-heal.cjs', db, manifestPath], { cwd: ROOT })
    expect(out.stdout).toContain('скан целостности: ok')
    expect(out.stdout).toContain('схема актуальна')
  })

  it('размеры БД/WAL печатаются ПЕРВОЙ строкой — логи больше не пустые', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-size-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'hub.db')
    await fs.copyFile(templateDb, db)
    const out = await execFileP('node', ['scripts/db-heal.cjs', db, manifestPath], { cwd: ROOT })
    const firstLine = out.stdout.trim().split('\n')[0]
    expect(firstLine).toContain('БД:')
    expect(firstLine).toContain('WAL:')
    expect(firstLine).toContain('свободно')
  })

  it('ТАЙМАУТ скана (DB_HEAL_TIMEOUT_MS=1) → код 2, БД не изменена (стирание только по доказанному повреждению)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-tmo-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'hub.db')
    await fs.copyFile(templateDb, db)
    const before = await fs.readFile(db)

    const err: any = await execFileP('node', ['scripts/db-heal.cjs', db, manifestPath], {
      cwd: ROOT,
      env: { ...process.env, DB_HEAL_TIMEOUT_MS: '1' },
    }).catch((e) => e)
    expect(err.code).toBe(2)
    // причина таймаута — в stderr, вердикт и код — в stdout
    expect(String(err.stderr ?? '')).toContain('ТАЙМАУТ')
    expect(String(err.stdout ?? '')).toContain('чтение sqlite_master не завершилось')
    expect(String(err.stdout ?? '')).toContain('БД не проверена')
    expect(String(err.stdout ?? '')).toContain('завершение (код 2)')
    // файл не изменён (никаких бэкапов/подмен по таймауту)
    const after = await fs.readFile(db)
    expect(Buffer.compare(before, after)).toBe(0)
  })
})

describe('db-heal v1.36.2: порог скана на больших БД — докатка выполняется (инцидент: БД 1.3 GB, код 2 до докатки, P2022 на всех API)', () => {
  /** Раздуть БД реальными строками LogEntry до > 1 MB (для порога DB_HEAL_CHECK_SKIP_MB=1) */
  async function padDb(dbFile: string, rows = 300, msgLen = 4096): Promise<void> {
    await rawDb(dbFile, `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      (async () => {
        const msg = 'x'.repeat(${msgLen});
        for (let i = 0; i < ${rows}; i++) {
          await p.logEntry.create({ data: { level: 'info', scope: 'system', message: 'pad-' + i + '-' + msg } });
        }
        await p.$disconnect();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `)
  }

  it('БД больше порога (DB_HEAL_CHECK_SKIP_MB=1) — скан пропущен, докатка выполняется, код 0', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-skip-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'hub.db')
    await fs.copyFile(templateDb, db)
    await padDb(db)
    const out = await execFileP('node', ['scripts/db-heal.cjs', db, manifestPath], {
      cwd: ROOT,
      env: { ...process.env, DB_HEAL_CHECK_SKIP_MB: '1' },
    })
    expect(out.stdout).toContain('скан целостности пропущен')
    expect(out.stdout).toContain('DB_HEAL_CHECK_SKIP_MB')
    expect(out.stdout).toContain('схема актуальна')
    expect(out.stdout).toContain('инициализация БД успешна')
  })

  it('NDR_DB_FULL_CHECK=1 — скан выполняется несмотря на порог (принудительная проверка)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-full-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'hub.db')
    await fs.copyFile(templateDb, db)
    await padDb(db)
    const out = await execFileP('node', ['scripts/db-heal.cjs', db, manifestPath], {
      cwd: ROOT,
      env: { ...process.env, DB_HEAL_CHECK_SKIP_MB: '1', NDR_DB_FULL_CHECK: '1' },
    })
    expect(out.stdout).toContain('integrity_check (полный, NDR_DB_FULL_CHECK=1)')
    expect(out.stdout).toContain('скан целостности: ok')
    expect(out.stdout).not.toContain('скан целостности пропущен')
  })

  it('старая схема на БД выше порога — докатка при пропущенном скане (главный сценарий инцидента)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-heal-skip-old-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'hub.db')
    await makeOldSchemaDb(db, [
      "INSERT INTO Setting (key, value, updatedAt) VALUES ('abusechAuthKey', 'KEEP-ME', CURRENT_TIMESTAMP)",
    ])
    await padDb(db)
    const out = await execFileP('node', ['scripts/db-heal.cjs', db, manifestPath], {
      cwd: ROOT,
      env: { ...process.env, DB_HEAL_CHECK_SKIP_MB: '1' },
    })
    // скан пропущен, НО докатка состоялась — схема приведена к текущей
    expect(out.stdout).toContain('скан целостности пропущен')
    expect(out.stdout).toContain('добавлена колонка Source.deletedAt')
    expect(out.stdout).toContain('схема докатана')
    const res = await rawDb(db, `
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      (async () => {
        const st = await p.setting.findUnique({ where: { key: 'abusechAuthKey' } });
        const logs = await p.logEntry.count();
        console.log(JSON.stringify({ authKey: st ? st.value : null, logs }));
        await p.$disconnect();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `)
    expect(JSON.parse(res.trim())).toEqual({ authKey: 'KEEP-ME', logs: 300 })
  })
})

describe('docker-entrypoint.sh v1.36.0: таймаут db-heal не стирает данные', () => {
  /** патч entrypoint под временные пути + манифест схемы в шаблонный каталог */
  async function patchedEntrypoint(dir: string, tmpl: string): Promise<string> {
    // db-heal читает манифест из каталога шаблона — без него мгновенный fatal (код 1)
    await fs.copyFile(manifestPath, path.join(tmpl, 'schema-manifest.json'))
    const ep = await fs.readFile(path.join(ROOT, 'docker-entrypoint.sh'), 'utf8')
    const patched = ep
      .replaceAll('/app/data', dir)
      .replaceAll('/app/db-template', tmpl)
      .replace('node /app/db-heal.cjs', `node ${path.join(ROOT, 'scripts/db-heal.cjs')}`)
      .replace('exec "$@"', 'echo EP_DONE')
    const epPath = path.join(dir, 'entrypoint-test.sh')
    await fs.writeFile(epPath, patched, { mode: 0o755 })
    return epPath
  }

  it('код 2 от db-heal → сервер запускается с существующей БД, бэкапов нет', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-tmo-'))
    const tmpl = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-tmo-tmpl-'))
    tmpDirs.push(dir, tmpl)
    await fs.copyFile(templateDb, path.join(tmpl, 'hub.db'))
    await fs.writeFile(path.join(tmpl, '.schema-version'), 'ep-tmo-ver')

    const db = path.join(dir, 'hub.db')
    await fs.copyFile(templateDb, db)
    await fs.writeFile(path.join(dir, '.schema-version'), 'old-marker')
    const before = await fs.readFile(db)

    const epPath = await patchedEntrypoint(dir, tmpl)
    // db-heal внутри entrypoint получает DB_HEAL_TIMEOUT_MS=1 → гарантированный код 2
    const r = await execFileP('sh', [epPath], {
      cwd: ROOT,
      env: { ...process.env, DB_HEAL_TIMEOUT_MS: '1' },
    })
    // размеры в логах первыми — «пустых логов» больше не бывает
    expect(r.stdout).toContain('том данных')
    expect(r.stdout).toContain('hub.db-wal')
    expect(r.stdout).toContain('ВНИМАНИЕ: db-heal не завершился (код 2')
    expect(r.stdout).toContain('НЕ считается повреждённой')
    expect(r.stdout).toContain('EP_DONE')
    // БД НЕ заменялась, бэкапов нет, маркер схемы не перезаписан
    expect(Buffer.compare(before, await fs.readFile(db))).toBe(0)
    const files = await fs.readdir(dir)
    expect(files.filter((n) => n.startsWith('hub.db.bak-'))).toHaveLength(0)
    expect(await fs.readFile(path.join(dir, '.schema-version'), 'utf8')).toContain('old-marker')
  })

  it('здоровая БД: db-heal ok → маркер обновлён, сервер запущен', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-ok-'))
    const tmpl = await fs.mkdtemp(path.join(os.tmpdir(), 'ep-ok-tmpl-'))
    tmpDirs.push(dir, tmpl)
    await fs.copyFile(templateDb, path.join(tmpl, 'hub.db'))
    await fs.writeFile(path.join(tmpl, '.schema-version'), 'ep-ok-ver')

    const db = path.join(dir, 'hub.db')
    await fs.copyFile(templateDb, db)

    const epPath = await patchedEntrypoint(dir, tmpl)
    const r = await execFileP('sh', [epPath], { cwd: ROOT })
    expect(r.stdout).toContain('скан целостности: ok')
    expect(r.stdout).toContain('EP_DONE')
    expect(await fs.readFile(path.join(dir, '.schema-version'), 'utf8')).toContain('ep-ok-ver')
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
