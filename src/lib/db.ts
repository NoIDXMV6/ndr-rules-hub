import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaHeavy: PrismaClient | undefined
}

// SQLite + массовая вставка (источник Snort 3 — ~53k правил: deleteMany +
// createMany чанками) подолгу держит файл на запись. Параллельные читатели
// (dashboard: source.count(), опрос UI) упирались в таймаут — «Invalid
// prisma.source.count() invocation: Socket timeout». Лечение:
//  1) WAL — читатели не блокируются активной записью (главное);
//  2) busy_timeout — вместо мгновенного отказа ждать освобождения файла;
//  3) connection_limit=1 — ровно одна коннекция на клиент: PRAGMA выше
//     гарантированно применяется к ней же, и исключены взаимоблокировки двух
//     пишущих коннекций одного клиента;
//  4) увеличенные socket_timeout/pool_timeout — дефолтные слишком малы для
//     длинных массовых операций.
//
// ДВА КЛИЕНТА (v1.35.0) — снятие блокировки БД при сборках:
//   • db — интерактивный: API веб-интерфейса (dashboard, прогресс, логи,
//     auth). Пока сборка читает/пишет через свой коннект, UI отвечает
//     мгновенно: в режиме WAL читатели не блокируют друг друга;
//   • dbHeavy — тяжёлый: конвейеры сборки правил и DNS-списка, импорт
//     дампа, массовые createMany/deleteMany, потоковое чтение записей.
//     Раньше всё шло через ОДНУ коннекцию (connection_limit=1): сборка DNS
//     непрерывно занимала её батчами по 10k — интерактивные запросы
//     выстраивались в очередь на pool_timeout и падали «Socket timeout»,
//     UI «зависал», чтение замедлялось до неприемлемых показателей.
//     Теперь у сборок отдельная коннекция, у интерфейса — своя.
// WAL+busy_timeout безопасны для двух пишущих клиентов: запись в SQLite
// всегда одна (файловая блокировка), конкурентные записи ждут busy_timeout.
function dbUrl(heavy = false): string {
  const raw = process.env.DATABASE_URL ?? 'file:./db/hub.db'
  // heavy-коннекция спокойнее ждёт свою очередь на запись (массовые чанки)
  const params = heavy
    ? 'connection_limit=1&socket_timeout=60&pool_timeout=30'
    : 'connection_limit=1&socket_timeout=30&pool_timeout=15'
  return raw.includes('?') ? `${raw}&${params}` : `${raw}?${params}`
}

function initPragmas(p: PrismaClient): void {
  // journal_mode=WAL персистентен (достаточно один раз), busy_timeout —
  // на коннекцию, но с connection_limit=1 коннекция клиента всегда одна и та же
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

/** Тяжёлый клиент для сборок/импорта — отдельная коннекция (см. шапку файла) */
export const dbHeavy =
  globalForPrisma.prismaHeavy ??
  new PrismaClient({
    datasources: { db: { url: dbUrl(true) } },
    log: ['error'],
  })

initPragmas(dbHeavy)

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
  globalForPrisma.prismaHeavy = dbHeavy
}
