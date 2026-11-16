#!/usr/bin/env node
// ============================================================================
// db-heal.cjs — самовосстановление БД тома до схемы образа, БЕЗ потери данных.
// Запускается docker-entrypoint.sh ДО старта сервера.
//
//   node db-heal.cjs <файл-БД> <манифест-схемы.json>
//
// Манифест создаётся при сборке образа (scripts/gen-schema-manifest.mjs) из
// свежего шаблона hub.db. Скрипт сравнивает живую БД с манифестом и докатывает:
//   - отсутствующую таблицу  → CREATE TABLE (DDL из манифеста);
//   - отсутствующую колонку  → ALTER TABLE ADD COLUMN (тип; DEFAULT — если был;
//     NOT NULL без DEFAULT не переносится — колонка станет nullable, Prisma
//     это допускает, данные не теряются);
//   - отсутствующий индекс   → CREATE INDEX.
// Перед первым изменением — консистентная копия БД через VACUUM INTO
// (в файл <db>.preheal-<время>).
//
// Чинит два инцидента из продакшена:
//  1) P2022 «The column `deletedAt` does not exist in the current database»
//     после обновления образа, когда sidecar-файл .schema-version не отражал
//     реальную структуру БД;
//  2) SQLITE_CORRUPT «database disk image is malformed» (extended_code 11) —
//     битые страницы данных. ALTER TABLE редактирует страницу 1 (sqlite_master)
//     и может «успешно» пройти на повреждённой БД: приложение стартует, но падает
//     на каждом запросе. Поэтому ПЕРЕД любым лечением выполняется полный
//     PRAGMA integrity_check (читает все страницы файла), а при провале БД
//     восстанавливается из последнего здорового снимка:
//       <db>.preheal-*  — VACUUM-копии, которые этот скрипт делает перед ALTER'ами;
//       <db>.bak-*      — бэкапы entrypoint при подмене БД шаблоном.
//     Хвостовые -wal/-shm при подмене файла БД удаляются: кадры старого WAL,
//     наложенные на страницы другого файла — типичная причина «malformed».
// Никогда не стирает данные: если БД не читается и здоровых снимков нет —
// выход 1, и entrypoint бэкапит файл и создаёт БД из шаблона.
// ============================================================================
const fs = require('fs')
const path = require('path')

const P = '[db-heal]'
const dbArg = process.argv[2]
const manifestArg = process.argv[3]
// сколько самых свежих снимков проверять (integrity_check на снимке занимает
// доли секунды, но защитимся от гигантского количества старых бэкапов)
const MAX_CANDIDATES = 15

function fatal(msg) {
  console.error(`${P} FATAL: ${msg}`)
  process.exit(1)
}

if (!dbArg || !manifestArg) fatal('usage: db-heal.cjs <db-file> <manifest.json>')
if (!fs.existsSync(dbArg)) fatal(`БД не найдена: ${dbArg}`)
if (!fs.existsSync(manifestArg)) fatal(`манифест не найден: ${manifestArg}`)

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestArg, 'utf8'))
} catch (e) {
  fatal(`манифест не читается: ${e.message}`)
}
if (!manifest.tables || typeof manifest.tables !== 'object') fatal('в манифесте нет tables')

// БД задаётся аргументом — жёстко переопределяем DATABASE_URL ДО загрузки клиента
process.env.DATABASE_URL = `file:${dbArg}`
let PrismaClient
try {
  ;({ PrismaClient } = require('@prisma/client'))
} catch (e) {
  fatal(`не удалось загрузить @prisma/client: ${e.message}`)
}

const q = (id) => `"${String(id).replace(/"/g, '""')}"`
const MB = (n) => (n / 1024 / 1024).toFixed(1)

// Клиент под конкретный файл БД: Prisma читает DATABASE_URL в конструкторе,
// поэтому URL подменяется на время создания клиента
function clientFor(dbPath) {
  process.env.DATABASE_URL = `file:${dbPath}`
  return new PrismaClient()
}

// PRAGMA integrity_check: 'ok' или перечень проблем. Читает ВСЕ страницы файла
// — в отличие от sqlite_master (страница 1) ловит битые страницы данных.
async function checkIntegrity(dbPath) {
  const c = clientFor(dbPath)
  try {
    const rows = await c.$queryRawUnsafe('PRAGMA integrity_check')
    const problems = rows.map((r) => String(Object.values(r)[0])).filter((v) => v !== 'ok')
    return { ok: problems.length === 0, problems }
  } catch (e) {
    return { ok: false, problems: [String(e?.message ?? e).split('\n')[0]] }
  } finally {
    try { await c.$disconnect() } catch { /* коннекция уже мертва */ }
  }
}

// Снимки БД рядом с текущей: <db>.preheal-* и <db>.bak-*. Хвостовые файлы
// -wal/-shm (в т.ч. уехавшие в бэкап под именем <bak>-wal) кандидатами не
// являются — это не самостоятельные БД.
function candidates(dbPath) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  let out
  try {
    out = fs.readdirSync(dir)
      .filter((n) => (n.startsWith(`${base}.preheal-`) || n.startsWith(`${base}.bak-`))
        && !n.endsWith('-wal') && !n.endsWith('-shm'))
      .map((n) => path.join(dir, n))
      .filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, MAX_CANDIDATES)
      .map((x) => x.p)
  } catch {
    out = []
  }
  return out
}

// Восстановление БД из последнего здорового снимка. Возвращает имя снимка
// или null, если ни один кандидат не прошёл integrity_check.
async function restoreFromSnapshot(dbPath) {
  const list = candidates(dbPath)
  if (list.length === 0) {
    console.log(`${P} снимков для восстановления нет (${path.basename(dbPath)}.preheal-*, .bak-*)`)
    return null
  }
  console.log(`${P} найдено снимков: ${list.length} — проверяю с самого свежего`)
  for (const cand of list) {
    const st = await checkIntegrity(cand)
    if (!st.ok) {
      console.log(`${P} снимок ${path.basename(cand)} не прошёл проверку (${st.problems[0]}) — пропускаю`)
      continue
    }
    // Хвостовые -wal/-shm принадлежат КОНКРЕТНОМУ файлу БД: оставленный
    // старый WAL поверх нового файла = «database disk image is malformed».
    for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.rmSync(side, { force: true }) } catch { /* нет файла */ }
    }
    fs.copyFileSync(cand, dbPath)
    console.log(`${P} БД восстановлена из снимка ${path.basename(cand)} (integrity_check: ok)`)
    return path.basename(cand)
  }
  console.log(`${P} ни один снимок не прошёл integrity_check`)
  return null
}

function columnFragment(c) {
  let frag = `${q(c.name)} ${c.type || 'TEXT'}`
  if (c.notnull && c.dflt !== null) frag += ` NOT NULL DEFAULT ${c.dflt}`
  else if (c.dflt !== null) frag += ` DEFAULT ${c.dflt}`
  else if (c.notnull) console.log(`${P} ВНИМАНИЕ: колонка ${c.name} NOT NULL без DEFAULT — добавляется как nullable`)
  return frag
}

async function main() {
  // 0. Целостность живой БД ДО любых изменений: ALTER TABLE по странице 1
  // может «успешно» пройти на БД с битыми страницами данных, и тогда
  // приложение стартует, но падает на каждом запросе (SQLITE_CORRUPT).
  let health = await checkIntegrity(dbArg)
  if (!health.ok) {
    console.log(`${P} integrity_check НЕ ПРОЙДЕН: ${health.problems.slice(0, 3).join('; ')}`)
    const snap = await restoreFromSnapshot(dbArg)
    if (snap) health = await checkIntegrity(dbArg)
  }
  if (!health.ok) {
    fatal(`БД ${dbArg} повреждена, здоровых снимков нет: ${health.problems.slice(0, 3).join('; ')}. ` +
      'Возможные причины: сервер выключался без завершения записи, не хватало места на диске. ' +
      'Дальше entrypoint бэкапит файл (hub.db.bak-…) и создаёт БД из шаблона.')
  }

  const prisma = clientFor(dbArg)
  try {
    const liveTables = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'"
    )
    const liveSet = new Set(liveTables.map((t) => t.name))

    const actions = []
    for (const [table, def] of Object.entries(manifest.tables)) {
      if (!liveSet.has(table)) {
        actions.push({ sql: def.ddl, log: `добавлена таблица ${table}` })
        continue
      }
      const cols = await prisma.$queryRawUnsafe(`PRAGMA table_info(${q(table)})`)
      const have = new Set(cols.map((c) => c.name))
      for (const c of def.columns || []) {
        if (!have.has(c.name)) {
          actions.push({ sql: `ALTER TABLE ${q(table)} ADD COLUMN ${columnFragment(c)}`, log: `добавлена колонка ${table}.${c.name}` })
        }
      }
    }

    const liveIdx = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='index'")
    const idxSet = new Set(liveIdx.map((i) => i.name))
    for (const idx of manifest.indexes || []) {
      if (!idxSet.has(idx.name)) {
        actions.push({ sql: idx.sql, log: `добавлен индекс ${idx.name} (${idx.table})` })
      }
    }

    if (actions.length === 0) {
      console.log(`${P} схема актуальна (${Object.keys(manifest.tables).length} таблиц), изменений не требуется`)
      return
    }

    // консистентная копия перед первым изменением
    const backup = `${dbArg}.preheal-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      await prisma.$executeRawUnsafe(`VACUUM INTO ${q(backup)}`)
      console.log(`${P} бэкап до изменений: ${backup}`)
    } catch (e) {
      console.log(`${P} ВНИМАНИЕ: бэкап VACUUM INTO не удался (${e.message.split('\n')[0]}) — продолжаю без него`)
    }

    for (const a of actions) {
      await prisma.$executeRawUnsafe(a.sql)
      console.log(`${P} ${a.log}`)
    }
    console.log(`${P} схема докатана: ${actions.length} изменен(ий/ия) — данные сохранены`)
  } finally {
    try { await prisma.$disconnect() } catch { /* коннекция уже мертва */ }
  }
}

main()
  .catch((e) => {
    console.error(`${P} FATAL: ${(e?.message ?? String(e)).split('\n').slice(0, 4).join('; ')}`)
    process.exitCode = 1
  })
