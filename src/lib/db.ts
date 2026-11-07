import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// SQLite + массовая вставка (источник Snort 3 — ~53k правил: deleteMany +
// createMany чанками) подолгу держит файл на запись. Параллельные читатели
// (dashboard: source.count(), опрос UI) упирались в таймаут — «Invalid
// prisma.source.count() invocation: Socket timeout». Лечение:
//  1) WAL — читатели не блокируются активной записью (главное);
//  2) busy_timeout — вместо мгновенного отказа ждать освобождения файла;
//  3) connection_limit=1 — ровно одна коннекция: PRAGMA выше гарантированно
//     применяется к ней же, и исключены взаимоблокировки двух пишущих коннекций;
//  4) увеличенные socket_timeout/pool_timeout — дефолтные слишком малы для
//     длинных массовых операций.
function dbUrl(): string {
  const raw = process.env.DATABASE_URL ?? 'file:./db/hub.db'
  const params = 'connection_limit=1&socket_timeout=30&pool_timeout=15'
  return raw.includes('?') ? `${raw}&${params}` : `${raw}?${params}`
}

function initPragmas(p: PrismaClient): void {
  // journal_mode=WAL персистентен (достаточно один раз), busy_timeout —
  // на коннекцию, но с connection_limit=1 коннекция всегда одна и та же
  void p.$queryRawUnsafe('PRAGMA journal_mode=WAL').catch(() => undefined)
  void p.$queryRawUnsafe('PRAGMA busy_timeout=15000').catch(() => undefined)
  void p.$queryRawUnsafe('PRAGMA synchronous=NORMAL').catch(() => undefined)
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: dbUrl() } },
    log: ['error'],
  })

initPragmas(db)

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
