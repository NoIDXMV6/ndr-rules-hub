import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { log } from '@/lib/engine/service'
import { ruleCategory, UNCATEGORIZED } from '@/lib/engine/categories'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/categories — раздел «Категории»: предпочтения пользователя + живая
 * статистика по правилам активных (не в корзине) источников.
 */
export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'categories', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const [rules, catRows, overridesOff, overridesAll] = await Promise.all([
      db.rule.findMany({
        where: { source: { deletedAt: null } },
        select: { clsType: true, sourceId: true },
      }),
      db.category.findMany(),
      db.ruleOverride.count({ where: { enabled: false } }),
      db.ruleOverride.findMany({ select: { sid: true } }),
    ])

    // группировка с нормализацией classtype (та же, что и в фильтре сборки)
    const stats = new Map<string, { rules: number; sources: Set<string> }>()
    for (const r of rules) {
      const name = ruleCategory(r.clsType)
      let st = stats.get(name)
      if (!st) {
        st = { rules: 0, sources: new Set() }
        stats.set(name, st)
      }
      st.rules++
      st.sources.add(r.sourceId)
    }

    const byName = new Map(catRows.map((c) => [c.name, c]))
    const names = new Set<string>([...stats.keys(), ...byName.keys()])
    const categories = [...names].map((name) => {
      const row = byName.get(name)
      const st = stats.get(name)
      return {
        id: row?.id ?? null,
        name,
        label: row?.label ?? null,
        enabled: row?.enabled ?? true,
        hidden: row?.hidden ?? false,
        rules: st?.rules ?? 0,
        sources: st ? st.sources.size : 0,
        known: !!row,
      }
    })
    categories.sort((a, b) => b.rules - a.rules || a.name.localeCompare(b.name))

    return NextResponse.json({
      categories,
      totalRules: rules.length,
      activeSources: new Set(rules.map((r) => r.sourceId)).size,
      overridesOff,
      overridesAll: overridesAll.length,
      uncategorized: UNCATEGORIZED,
      categoriesRows: catRows.length,
    })
  } catch (e) {
    return apiError(e)
  }
}

/**
 * POST /api/categories — анализ правил активных источников и группировка
 * по категориям: создаются новые Category-строки (скрытые не трогаются),
 * classtype нормализуется (lower/trim) и в БД правил.
 */
export async function POST(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'categories', rule: { limit: 20, windowMs: 60_000, blockMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const rules = await db.rule.findMany({
      where: { source: { deletedAt: null } },
      select: { clsType: true },
    })
    // нормализация значений classtype в БД (ASCII lower/trim, один UPDATE)
    await db.$executeRawUnsafe(
      `UPDATE "Rule" SET clsType = lower(trim(clsType)) WHERE clsType IS NOT NULL AND clsType != lower(trim(clsType))`,
    )

    const names = new Set<string>()
    for (const r of rules) names.add(ruleCategory(r.clsType))
    const existing = new Set((await db.category.findMany({ select: { name: true } })).map((c) => c.name))
    let added = 0
    for (const name of names) {
      if (existing.has(name)) continue
      await db.category.create({ data: { name } })
      added++
    }
    const total = await db.category.count()
    await log('success', 'system', `Категории проанализированы: правил ${rules.length}, категорий ${names.size} (новых: ${added}, всего строк: ${total})`)
    return NextResponse.json({ ok: true, added, categories: names.size, totalRules: rules.length, rows: total })
  } catch (e) {
    return apiError(e)
  }
}

/** PUT /api/categories — массовое включение/выключение всех категорий: { enabled: boolean } */
export async function PUT(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'categories', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'нужен { enabled: boolean }' }, { status: 400 })
    }
    const res = await db.category.updateMany({ data: { enabled: body.enabled } })
    await log(body.enabled ? 'info' : 'warn', 'system', `Категории ${body.enabled ? 'включены' : 'выключены'} массово (${res.count} шт.)`)
    return NextResponse.json({ ok: true, updated: res.count })
  } catch (e) {
    return apiError(e)
  }
}
