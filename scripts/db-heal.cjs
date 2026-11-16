#!/usr/bin/env node
// ============================================================================
// db-heal.cjs — самовосстановление схемы БД тома до схемы образа, БЕЗ потери
// данных. Запускается docker-entrypoint.sh ДО старта сервера.
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
// Это чинит «The column `deletedAt` does not exist in the current database»
// (P2022) после обновления образа, когда sidecar-файл .schema-version не
// отражал реальную структуру БД. Никогда не стирает данные: если БД вообще
// не читается — выход 1, и entrypoint падает обратно на замену из шаблона.
// ============================================================================
const fs = require('fs')
const path = require('path')

const P = '[db-heal]'
const dbArg = process.argv[2]
const manifestArg = process.argv[3]

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
const prisma = new PrismaClient()

function columnFragment(c) {
  let frag = `${q(c.name)} ${c.type || 'TEXT'}`
  if (c.notnull && c.dflt !== null) frag += ` NOT NULL DEFAULT ${c.dflt}`
  else if (c.dflt !== null) frag += ` DEFAULT ${c.dflt}`
  else if (c.notnull) console.log(`${P} ВНИМАНИЕ: колонка ${c.name} NOT NULL без DEFAULT — добавляется как nullable`)
  return frag
}

async function main() {
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
}

main()
  .catch((e) => {
    console.error(`${P} FATAL: ${(e?.message ?? String(e)).split('\n').slice(0, 4).join('; ')}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
