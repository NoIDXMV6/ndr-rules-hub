// ─────────────────────────────────────────────────────────────────────────────
// TTL-кэш тяжёлых счётчиков (COUNT(*) по сотням тысяч / миллионам строк).
//
// На каждый опрос дашборда выполнялись db.rule.aggregate (478k строк) и
// db.domainRecord.aggregate (6 млн строк): SQLite сканирует индекс на каждый
// COUNT — сотни мс…секунды, а при активной сборке запросы ещё и стояли в
// очереди к единственной коннекции («чтение из БД замедлилось до неприемлемых
// показателей»). Политика:
//   • свежий кэш (< TTL) — мгновенный ответ;
//   • устаревший — значение отдаётся сразу, пересчёт идёт В ФОНЕ (дашборд
//     никогда не ждёт COUNT);
//   • первый вызов без кэша — честный пересчёт.
// Сборки/импорты могут инвалидировать кэш вызовом invalidateCounts() — иначе
// значения подтянутся через TTL.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'

const TTL_MS = 60_000

interface CacheEntry {
  n: number
  at: number
  refreshing: boolean
}

let rules: CacheEntry | null = null
let domains: CacheEntry | null = null

async function countRules(): Promise<number> {
  const agg = await db.rule.aggregate({ _count: { _all: true } })
  return agg._count._all
}

async function countDomains(): Promise<number> {
  const agg = await db.domainRecord.aggregate({ _count: { _all: true } })
  return agg._count._all
}

/** Общая механика: свежий кэш → сразу; устаревший → значение + фоновый пересчёт; пусто → честный пересчёт */
async function cachedCount(entry: CacheEntry | null, counter: () => Promise<number>): Promise<{ value: CacheEntry | null; n: number | null }> {
  if (entry && Date.now() - entry.at < TTL_MS) return { value: entry, n: entry.n }
  if (entry) {
    // устаревший кэш: отдаём прошлое значение, пересчитываем в фоне
    if (!entry.refreshing) {
      entry.refreshing = true
      void counter()
        .then((n) => { entry.n = n; entry.at = Date.now() })
        .catch(() => undefined)
        .finally(() => { entry.refreshing = false })
    }
    return { value: entry, n: entry.n }
  }
  // первый вызов: кэша нет — считаем честно (заполняем кэш)
  try {
    const n = await counter()
    return { value: { n, at: Date.now(), refreshing: false }, n }
  } catch {
    return { value: null, n: null }
  }
}

/** Число правил в БД (TTL-кэш, фоновое обновление) */
export async function rulesCountCached(): Promise<number> {
  const r = await cachedCount(rules, countRules)
  if (r.value) rules = r.value
  return r.n ?? 0
}

/** Число доменных записей в БД (TTL-кэш, фоновое обновление) */
export async function domainRecordsCountCached(): Promise<number> {
  const r = await cachedCount(domains, countDomains)
  if (r.value) domains = r.value
  return r.n ?? 0
}

/** Инвалидация после массовых операций (сборка, импорт, очистка) */
export function invalidateCounts(): void {
  rules = null
  domains = null
}

/** Только для тестов: сбросить кэш */
export function resetCountCache(): void {
  rules = null
  domains = null
}
