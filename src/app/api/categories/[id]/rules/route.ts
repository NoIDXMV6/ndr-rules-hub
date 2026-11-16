import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'

/** GET /api/categories/:id/rules — правила категории (страница + поиск + состояние override) */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const cat = await db.category.findUnique({ where: { id } })
    if (!cat) return NextResponse.json({ error: 'категория не найдена' }, { status: 404 })

    const sp = req.nextUrl.searchParams
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10))
    const perPage = Math.min(200, Math.max(10, parseInt(sp.get('perPage') || '50', 10)))
    const q = sp.get('q')?.trim()

    const where: Record<string, unknown> = {
      source: { deletedAt: null },
      clsType: cat.name === 'none' ? null : cat.name,
    }
    if (q) {
      const sid = parseInt(q, 10)
      // число целиком — поиск по sid, иначе подстрока в msg
      where.OR = Number.isFinite(sid) && String(sid) === q
        ? [{ sid }, { msg: { contains: q } }]
        : [{ msg: { contains: q } }]
    }

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
    const sids = rules.map((r) => r.sid)
    const overrides = sids.length
      ? await db.ruleOverride.findMany({ where: { sid: { in: sids } } })
      : []
    const ovMap = new Map(overrides.map((o) => [o.sid, o]))

    return NextResponse.json({
      category: { id: cat.id, name: cat.name, label: cat.label, enabled: cat.enabled },
      total,
      page,
      perPage,
      rules: rules.map((r) => ({
        id: r.id,
        sid: r.sid,
        rev: r.rev,
        action: r.action,
        proto: r.proto,
        msg: r.msg,
        raw: r.raw,
        suricataOk: r.suricataOk,
        compatNotes: r.compatNotes,
        sourceName: r.source.name,
        overrideEnabled: ovMap.get(r.sid)?.enabled ?? null,
      })),
    })
  } catch (e) {
    return apiError(e)
  }
}

/**
 * PUT /api/categories/:id/rules — переключатель правила (RuleOverride):
 * { sid: number, enabled: boolean }
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await params // категория — контекст; override глобален по sid
    const body = await req.json().catch(() => null)
    if (!body || typeof body.sid !== 'number' || typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'нужен { sid: number, enabled: boolean }' }, { status: 400 })
    }
    const ov = await db.ruleOverride.upsert({
      where: { sid: body.sid },
      create: { sid: body.sid, enabled: body.enabled },
      update: { enabled: body.enabled },
    })
    return NextResponse.json({ ok: true, override: { sid: ov.sid, enabled: ov.enabled } })
  } catch (e) {
    return apiError(e)
  }
}
