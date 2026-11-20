// DNS-фильтрация: поиск по записям и дубликатам (администратор).
// GET /api/dns/records?search=...      — домены по подстроке, во всех источниках
//                                        (видно, где дубликат: несколько строк по одному домену)
// GET /api/dns/records?duplicates=1    — топ доменов, встречающихся в нескольких источниках
// GET /api/dns/records?sourceId=...&page=1 — записи источника (пагинация)
// Ответ объединён с DomainOverride (ручные решения).
//
// v1.35.0 — производительность на таблице в 6 млн записей:
//  • счётчик страницы — БЕЗ точного COUNT(*) по 6 млн строк (LIKE-фильтр
//    сканирует таблицу секунды на каждую страницу): без поиска — счётчик
//    источника (domainCount) или TTL-кэш общего числа; с поиском — ограниченный
//    перебор (до 20 001 совпадения) с кэшем на 60 с; при большем числе
//    совпадений отдаётся «20000+»;
//  • ручные решения (DomainOverride) выбираются ограниченно (select только
//    нужных полей);
//  • поиск по подстроке оставлен как был (contains) — первый запрос страницы
//    со свежим поисковым фильтром может сканировать таблицу, повторные
//    запросы того же фильтра мгновенны (кэш счётчика), а пагинация идёт
//    по индексу @@index([domain]).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { domainRecordsCountCached } from '@/lib/engine/count-cache'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 100
/** Верхняя граница ограниченного счётчика поиска */
const COUNT_CAP = 20_000

/** TTL-кэш ограниченных счётчиков поиска (60 с) — перелистывание страниц мгновенно */
const searchCountCache = new Map<string, { n: number; capped: boolean; at: number }>()

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/** Ограниченный счётчик по подстроке: перебор останавливается на COUNT_CAP+1 */
async function cappedSearchCount(search: string, sourceId?: string): Promise<{ n: number; capped: boolean }> {
  const key = `${sourceId ?? ''}|${search}`
  const hit = searchCountCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return { n: hit.n, capped: hit.capped }
  const pattern = `%${escapeLike(search)}%`
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM DomainRecord WHERE ${sourceId ? 'sourceId = ? AND ' : ''}domain LIKE ? ESCAPE '\\' LIMIT ${COUNT_CAP + 1})`,
    ...(sourceId ? [sourceId] : []),
    pattern,
  )
  const n = Number(rows[0]?.n ?? 0)
  const capped = n > COUNT_CAP
  const res = { n: capped ? COUNT_CAP : n, capped, at: Date.now() }
  // кэш ограничен: чистим старые записи при переполнении
  if (searchCountCache.size > 200) {
    const cutoff = Date.now() - 60_000
    for (const [k, v] of searchCountCache) if (v.at < cutoff) searchCountCache.delete(k)
  }
  searchCountCache.set(key, res)
  return { n: res.n, capped: res.capped }
}

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  try {
    const sp = req.nextUrl.searchParams
    const sourceId = sp.get('sourceId') ?? undefined
    const search = (sp.get('search') ?? '').trim().toLowerCase()
    const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)

    if (sp.get('duplicates')) {
      // топ дубликатов: домен в нескольких источниках (SQL group by по домену)
      const grouped = await db.$queryRawUnsafe<Array<{ domain: string; n: number }>>(
        `SELECT domain, COUNT(DISTINCT sourceId) AS n FROM DomainRecord GROUP BY domain HAVING n > 1 ORDER BY n DESC, domain ASC LIMIT 500`,
      )
      const top = grouped.slice(0, 50).map((r) => r.domain)
      const rows = await db.domainRecord.findMany({
        where: { domain: { in: top } },
        include: { source: { select: { name: true, priority: true, purpose: true } } },
        orderBy: { domain: 'asc' },
      })
      return NextResponse.json({
        duplicates: grouped.map((r) => ({ domain: r.domain, sources: r.n })),
        rows: rows.map((r) => ({
          id: r.id, domain: r.domain, mode: r.mode, sourceName: r.source.name,
          sourcePriority: r.source.priority, sourcePurpose: r.source.purpose,
        })),
      })
    }

    // счётчик страницы: без точного COUNT(*) по 6 млн строк (см. шапку)
    let total: number
    let totalCapped = false
    if (search) {
      const c = await cappedSearchCount(search, sourceId)
      total = c.n
      totalCapped = c.capped
    } else if (sourceId) {
      const src = await db.domainSource.findUnique({ where: { id: sourceId }, select: { domainCount: true } })
      total = src?.domainCount ?? 0
    } else {
      total = await domainRecordsCountCached()
    }

    const where = {
      ...(sourceId ? { sourceId } : {}),
      ...(search ? { domain: { contains: search } } : {}),
    }
    const [rows, overrides] = await Promise.all([
      db.domainRecord.findMany({
        where,
        include: { source: { select: { name: true, priority: true, purpose: true } } },
        orderBy: { domain: 'asc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.domainOverride.findMany({ select: { domain: true, enabled: true, note: true } }),
    ])
    const ovMap = new Map(overrides.map((o) => [o.domain, o]))
    return NextResponse.json({
      total,
      totalCapped,
      page,
      pageSize: PAGE_SIZE,
      rows: rows.map((r) => ({
        id: r.id, domain: r.domain, mode: r.mode, categories: r.categories,
        sourceName: r.source.name, sourcePriority: r.source.priority, sourcePurpose: r.source.purpose,
        override: ovMap.get(r.domain) ? { enabled: ovMap.get(r.domain)!.enabled, note: ovMap.get(r.domain)!.note } : null,
      })),
    })
  } catch (e) {
    return apiError(e)
  }
}
