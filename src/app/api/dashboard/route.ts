import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeed, getSettings } from '@/lib/engine/service'
import { wgStatus } from '@/lib/engine/vpn'
import { apiError } from '@/lib/api-error'
import { guard, sanitizeSettings } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dashboard', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    await ensureSeed()
    const [sources, builds, settings, logs, ruleAgg] = await Promise.all([
      db.source.findMany({ orderBy: [{ enabled: 'desc' }, { priority: 'asc' }] }),
      db.build.findFirst({ orderBy: { createdAt: 'desc' } }),
      getSettings(),
      db.logEntry.findMany({ orderBy: { ts: 'desc' }, take: 50 }),
      db.rule.aggregate({ _count: { _all: true } }),
    ])
    // VPN — только администратору (статус туннелей/ключи пиров не для кабинета)
    const wg = g.role === 'admin' ? await wgStatus() : { available: false, error: 'WireGuard доступен только администратору', interfaces: [], tools: { wgQuick: false, wg: false, tunDevice: false, netAdmin: false, sysctl: false, srcValidMark: false, notes: [] as string[] } }
    return NextResponse.json({
      sources: {
        total: sources.filter((s) => !s.deletedAt).length,
        enabled: sources.filter((s) => s.enabled && !s.deletedAt).length,
        ok: sources.filter((s) => s.status === 'ok' && !s.deletedAt).length,
        error: sources.filter((s) => s.status === 'error' && !s.deletedAt).length,
        trash: sources.filter((s) => s.deletedAt).length,
        list: sources.map((s) => ({
          id: s.id, name: s.name, category: s.category, kind: s.kind, url: s.url,
          authType: s.authType, enabled: s.enabled, priority: s.priority,
          status: s.status, lastFetchAt: s.lastFetchAt, lastError: s.lastError,
          ruleCount: s.ruleCount, sizeBytes: s.sizeBytes, badge: s.badge, notes: s.notes,
          builtin: s.builtin, extraJson: s.extraJson, deletedAt: s.deletedAt, ownerId: s.ownerId,
        })),
      },
      rules: { inDb: ruleAgg._count._all, inBuild: builds?.totalRules ?? 0 },
      lastBuild: builds
        ? {
            id: builds.id, createdAt: builds.createdAt, totalRules: builds.totalRules,
            fileName: builds.fileName, filePath: builds.filePath, sha256: builds.sha256,
            sizeBytes: builds.sizeBytes, source: builds.source,
            stats: JSON.parse(builds.statsJson || '{}'),
          }
        : null,
      // секреты (serveToken, oinkcode, Auth-Key abuse.ch, токен Scirius) — только админу
      settings: sanitizeSettings(settings, g.role),
      vpn: wg,
      logs: logs.map((l) => ({ id: l.id, ts: l.ts, level: l.level, scope: l.scope, message: l.message })),
    })
  } catch (e) {
    return apiError(e)
  }
}
