import { NextRequest, NextResponse } from 'next/server'
import { apiError } from '@/lib/api-error'
import {
  loadUpdateSettings,
  maskSecrets,
} from '@/lib/engine/clearndr-update'
import {
  OSD_APPLY_KINDS,
  OSD_PACK_KEYS,
  cancelOsdRun,
  listOsdRuns,
  probeOsd,
  readOsdRunStatus,
  startOsdRun,
  syncOsdScripts,
  type OsdApplyKind,
  type OsdPackKey,
  type OsdProbe,
  type OsdRunOptions,
} from '@/lib/engine/clearndr-osd'

export const dynamic = 'force-dynamic'

function normPacks(raw: unknown): OsdPackKey[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const arr = raw.filter((x): x is OsdPackKey => typeof x === 'string' && (OSD_PACK_KEYS as readonly string[]).includes(x))
  return [...new Set(arr)]
}

function normWhat(raw: unknown): OsdApplyKind {
  return (OSD_APPLY_KINDS as readonly string[]).includes(String(raw)) ? (raw as OsdApplyKind) : 'all'
}

/** GET /api/clearndr-osd — статус раздела (или лог прогона: ?log=<runId>) */
export async function GET(req: NextRequest) {
  try {
    const runId = req.nextUrl.searchParams.get('log')
    const cfg = await loadUpdateSettings()
    if (runId) {
      const tail = Math.min(120_000, Math.max(2_000, parseInt(req.nextUrl.searchParams.get('tail') || '24000', 10) || 24_000))
      return NextResponse.json(await readOsdRunStatus(cfg, runId, tail))
    }
    const [probe, runs] = await Promise.all([
      probeOsd(cfg).catch(
        (e): OsdProbe => ({
          ok: false,
          mode: cfg.updateMode,
          error: (e as Error).message,
          ranAt: new Date().toISOString(),
        }),
      ),
      listOsdRuns(),
    ])
    let activeRun = null as null | { runId: string; active: boolean; exitCode?: number; startedAt?: string; cancelled?: boolean }
    for (const r of runs.slice(0, 3)) {
      if (!r.finishedAt) {
        const st = await readOsdRunStatus(cfg, r.runId, 2_000)
        if (st.active) {
          activeRun = { runId: st.runId, active: true, exitCode: st.exitCode, startedAt: st.startedAt, cancelled: st.cancelled }
          break
        }
      }
    }
    return NextResponse.json({
      settings: maskSecrets(cfg),
      packs: OSD_PACK_KEYS,
      applyKinds: OSD_APPLY_KINDS,
      probe,
      activeRun,
      runs: runs.slice(0, 20),
    })
  } catch (e) {
    return apiError(e)
  }
}

/** POST /api/clearndr-osd — действия: probe | sync-scripts | start | cancel */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const action = body?.action
    const cfg = await loadUpdateSettings()

    if (action === 'probe') {
      const probe = await probeOsd(cfg, true)
      return NextResponse.json({ ok: probe.ok, probe })
    }

    if (action === 'sync-scripts') {
      const r = await syncOsdScripts(cfg)
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    }

    if (action === 'start') {
      const o: OsdRunOptions = {
        kind: (['apply', 'import', 'remove'] as const).includes(body?.kind) ? body.kind : 'apply',
        what: normWhat(body?.what),
        packs: normPacks(body?.packs),
        dryRun: !!body?.dryRun,
      }
      // удаление — только при явном подтверждении из UI
      if (o.kind === 'remove' && body?.confirm !== true) {
        return NextResponse.json({ error: 'для удаления нужно confirm: true' }, { status: 400 })
      }
      const r = await startOsdRun(cfg, o)
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    }

    if (action === 'cancel') {
      if (!body?.runId) return NextResponse.json({ error: 'нужен runId' }, { status: 400 })
      const r = await cancelOsdRun(cfg, String(body.runId))
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    }

    return NextResponse.json({ error: 'action: probe | sync-scripts | start | cancel' }, { status: 400 })
  } catch (e) {
    return apiError(e)
  }
}
