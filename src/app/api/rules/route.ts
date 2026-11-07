import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const sid = sp.get('sid')
  const sourceId = sp.get('sourceId')
  const q = sp.get('q')
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10))
  const perPage = Math.min(200, Math.max(10, parseInt(sp.get('perPage') || '50', 10)))

  const where: Record<string, unknown> = {}
  if (sid) where.sid = parseInt(sid, 10)
  if (sourceId) where.sourceId = sourceId
  if (q) where.msg = { contains: q }

  const [total, rules] = await Promise.all([
    db.rule.count({ where }),
    db.rule.findMany({
      where,
      orderBy: { sid: 'asc' },
      skip: (page - 1) * perPage,
      take: perPage,
      include: { source: { select: { name: true } } },
    }),
  ])
  return NextResponse.json({
    total,
    page,
    perPage,
    rules: rules.map((r) => ({
      id: r.id, sid: r.sid, rev: r.rev, action: r.action, proto: r.proto,
      msg: r.msg, raw: r.raw, suricataOk: r.suricataOk, compatNotes: r.compatNotes,
      sourceName: r.source.name,
    })),
  })
}
