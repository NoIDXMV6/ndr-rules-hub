// DNS-фильтрация: поиск по записям и дубликатам (администратор).
// GET /api/dns/records?search=...      — домены по подстроке, во всех источниках
//                                        (видно, где дубликат: несколько строк по одному домену)
// GET /api/dns/records?duplicates=1    — топ доменов, встречающихся в нескольких источниках
// GET /api/dns/records?sourceId=...&page=1 — записи источника (пагинация)
// Ответ объединён с DomainOverride (ручные решения).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 100

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

    const where = {
      ...(sourceId ? { sourceId } : {}),
      ...(search ? { domain: { contains: search } } : {}),
    }
    const [total, rows, overrides] = await Promise.all([
      db.domainRecord.count({ where }),
      db.domainRecord.findMany({
        where,
        include: { source: { select: { name: true, priority: true, purpose: true } } },
        orderBy: { domain: 'asc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.domainOverride.findMany({}),
    ])
    const ovMap = new Map(overrides.map((o) => [o.domain, o]))
    return NextResponse.json({
      total,
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
