import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeed, getSettings } from '@/lib/engine/service'
import { wgStatus } from '@/lib/engine/vpn'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureSeed()
  const [sources, builds, settings, logs, ruleAgg] = await Promise.all([
    db.source.findMany({ orderBy: [{ enabled: 'desc' }, { priority: 'asc' }] }),
    db.build.findFirst({ orderBy: { createdAt: 'desc' } }),
    getSettings(),
    db.logEntry.findMany({ orderBy: { ts: 'desc' }, take: 50 }),
    db.rule.aggregate({ _count: { _all: true } }),
  ])
  const wg = await wgStatus()
  return NextResponse.json({
    sources: {
      total: sources.length,
      enabled: sources.filter((s) => s.enabled).length,
      ok: sources.filter((s) => s.status === 'ok').length,
      error: sources.filter((s) => s.status === 'error').length,
      list: sources.map((s) => ({
        id: s.id, name: s.name, category: s.category, kind: s.kind, url: s.url,
        authType: s.authType, enabled: s.enabled, priority: s.priority,
        status: s.status, lastFetchAt: s.lastFetchAt, lastError: s.lastError,
        ruleCount: s.ruleCount, sizeBytes: s.sizeBytes, badge: s.badge, notes: s.notes,
        builtin: s.builtin, extraJson: s.extraJson,
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
    settings,
    vpn: wg,
    logs: logs.map((l) => ({ id: l.id, ts: l.ts, level: l.level, scope: l.scope, message: l.message })),
  })
}
