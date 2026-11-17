// ============================================================================
// gen-schema-manifest.mjs — снимок схемы шаблонной БД в JSON-манифест.
// Запускается на стадии builder при сборке образа СРАЗУ ПОСЛЕ `prisma db push`
// (см. Dockerfile): DATABASE_URL указывает на свежесозданный /app/db-template/hub.db.
// Манифест (таблицы + колонки + индексы) используется на стадии runtime
// скриптом db-heal.cjs: он докатывает недостающие таблицы/колонки в живую БД
// тома БЕЗ потери данных (см. docker-entrypoint.sh).
// Запуск: node scripts/gen-schema-manifest.mjs <путь-к-БД> <путь-к-манифесту>
// Работает под node (builder и тесты); раньше builder работал под bun.
// ============================================================================
import { PrismaClient } from '@prisma/client'
import { writeFileSync } from 'fs'

const dbArg = process.argv[2]
const outArg = process.argv[3]
if (!dbArg || !outArg) {
  console.error('usage: gen-schema-manifest.mjs <db-file> <manifest-out.json>')
  process.exit(1)
}

// клиент должен смотреть именно в указанный файл, а не в DATABASE_URL окружения
process.env.DATABASE_URL = `file:${dbArg}`
const prisma = new PrismaClient()

try {
  const tables = await prisma.$queryRawUnsafe(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name"
  )
  const indexes = await prisma.$queryRawUnsafe(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"
  )

  const manifest = { generatedAt: new Date().toISOString(), tables: {}, indexes: [] }
  for (const t of tables) {
    const cols = await prisma.$queryRawUnsafe(`PRAGMA table_info("${t.name}")`)
    manifest.tables[t.name] = {
      ddl: t.sql,
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type ?? '',
        notnull: c.notnull ? 1 : 0,
        dflt: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
        pk: c.pk ? 1 : 0,
      })),
    }
  }
  for (const i of indexes) manifest.indexes.push({ name: i.name, table: i.tbl_name, sql: i.sql })

  writeFileSync(outArg, JSON.stringify(manifest, null, 2))
  console.log(`[db-manifest] таблиц: ${Object.keys(manifest.tables).length}, индексов: ${manifest.indexes.length} → ${outArg}`)
} finally {
  await prisma.$disconnect()
}
