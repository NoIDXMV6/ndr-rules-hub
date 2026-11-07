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
  try {
    const probe = await db.source.findMany({ take: 1, select: { id: true, format: true } })
    const [sources, rules, builds] = await Promise.all([
      db.source.count(),
      db.rule.count(),
      db.build.count(),
    ])
    report.db = { ok: true, probeRows: probe.length, sources, rules, builds }
  } catch (e) {
    report.status = 'db-error'
    report.db = {
      ok: false,
      error: (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, ' ').trim(),
      hint: 'обычно это несовпадение схемы БД: см. docker logs и /app/data/.schema-version',
    }
  }

  // Файлы на диске
  try {
    report.files = {
      dbFileExists: dbFile ? await fs.stat(dbFile).then(() => true).catch(() => false) : null,
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
