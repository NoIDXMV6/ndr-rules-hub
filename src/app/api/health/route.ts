import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { promises as fs } from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

/**
 * GET /api/health — самодиагностика по HTTP.
 * Отвечает 200 всегда, чтобы диагностику можно было получить даже при
 * нерабочей БД (в отличие от /api/dashboard, который при ошибке БД отдаёт 500).
 * Проверяет: подключение к БД (с реальным текстом ошибки), файл БД на диске,
 * версию схемы (штамп из entrypoint), наличие каталогов данных.
 */
export async function GET() {
  const dataDir = process.env.RULES_DATA_DIR || '/app/data'
  const dbFile = (process.env.DATABASE_URL || '').replace(/^file:/, '')

  const report: Record<string, unknown> = {
    status: 'ok',
    time: new Date().toISOString(),
    node: process.version,
    env: {
      databaseUrl: process.env.DATABASE_URL ?? null,
      rulesDataDir: process.env.RULES_DATA_DIR ?? null,
      wgConfigDir: process.env.WG_CONFIG_DIR ?? null,
    },
  }

  // БД: реальный запрос + текст ошибки, если схема устарела.
  // ВАЖНО: count() не выбирает колонки и не ловит отсутствующие поля,
  // поэтому проверяем findMany — он селектит все колонки модели.
  // v1.36.2: счётчики «подозреваемых в разрастании» таблиц (инцидент: том
  // 1.3 GB — нужен ответ, ЧТО именно раздувает БД: домены/логи/события).
  // Каждый счётчик отдельно: одна упавшая (нет таблицы в схеме тома) не
  // мешает остальным; null — таблицы нет в схеме БД.
  try {
    const probe = await db.source.findMany({ take: 1, select: { id: true, format: true } })
    const tableCounts: Record<string, number | null> = {}
    for (const [name, fn] of Object.entries({
      sources: () => db.source.count(),
      rules: () => db.rule.count(),
      builds: () => db.build.count(),
      domainSources: () => db.domainSource.count(),
      domainRecords: () => db.domainRecord.count(),
      logEntries: () => db.logEntry.count(),
      authEvents: () => db.authEvent.count(),
      sessions: () => db.session.count(),
      users: () => db.user.count(),
    } as Record<string, () => Promise<number>>)) {
      try {
        tableCounts[name] = await fn()
      } catch {
        tableCounts[name] = null
      }
    }
    report.db = { ok: true, probeRows: probe.length, tables: tableCounts }
  } catch (e) {
    report.status = 'db-error'
    report.db = {
      ok: false,
      error: (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, ' ').trim(),
      hint: 'если движок БД исправен — см. docker logs; частые причины: устаревшая схема БД тома (entrypoint при старте докатывает недостающие таблицы/колонки автоматически; скан целостности на большой БД пропускается — DB_HEAL_CHECK_SKIP_MB, докатка выполняется всегда — перезапустите контейнер) или недостающий query engine Prisma (binaryTargets в schema.prisma)',
    }
  }

  // Файлы на диске (+ размеры БД/WAL — гигабайтный WAL — след зависших сборок)
  const sizeMB = async (p: string): Promise<number | null> =>
    fs.stat(p).then((s) => Math.round((s.size / 1048576) * 10) / 10).catch(() => null)
  try {
    report.files = {
      dbFileExists: dbFile ? await fs.stat(dbFile).then(() => true).catch(() => false) : null,
      dbSizeMB: dbFile ? await sizeMB(dbFile) : null,
      walSizeMB: dbFile ? await sizeMB(`${dbFile}-wal`) : null,
      schemaVersion: await fs
        .readFile(path.join(dataDir, '.schema-version'), 'utf8')
        .then((s) => s.trim())
        .catch(() => null),
      dataDir: await fs.readdir(dataDir).catch(() => null),
    }
  } catch {
    report.files = null
  }

  return NextResponse.json(report)
}
