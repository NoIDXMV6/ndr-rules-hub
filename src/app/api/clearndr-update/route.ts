import { NextRequest, NextResponse } from 'next/server'
import { apiError } from '@/lib/api-error'
import {
  UPDATE_SETTING_KEYS,
  UPDATE_OPTIONS_DEFAULTS,
  fetchLatestRelease,
  listRuns,
  loadUpdateSettings,
  maskSecrets,
  probeHost,
  readRunStatus,
  cancelRun,
  startUpdate,
  syncScript,
  updateAvailable,
  HostProbe,
  UpdateOptions,
} from '@/lib/engine/clearndr-update'

export const dynamic = 'force-dynamic'

const MASK = '********'

/** GET /api/clearndr-update — статус раздела (или лог прогона: ?log=<runId>) */
export async function GET(req: NextRequest) {
  try {
    const runId = req.nextUrl.searchParams.get('log')
    const cfg = await loadUpdateSettings()
    if (runId) {
      const tail = Math.min(120_000, Math.max(2_000, parseInt(req.nextUrl.searchParams.get('tail') || '24000', 10) || 24_000))
      return NextResponse.json(await readRunStatus(cfg, runId, tail))
    }

    const [latest, runs, probe] = await Promise.all([
      fetchLatestRelease(),
      listRuns(),
      probeHost(cfg).catch(
        (e): HostProbe => ({
          ok: false,
          mode: cfg.updateMode,
          error: (e as Error).message,
          containers: [],
          ranAt: new Date().toISOString(),
        }),
      ),
    ])
    // если выполняется прогон — забираем свежий статус (лог-хвост не нужен в общем статусе)
    let activeRun = null as null | { runId: string; active: boolean; exitCode?: number; startedAt?: string }
    for (const r of runs.slice(0, 3)) {
      if (!r.finishedAt) {
        const st = await readRunStatus(cfg, r.runId, 2_000)
        if (st.active) {
          activeRun = { runId: st.runId, active: true, exitCode: st.exitCode, startedAt: st.startedAt }
          break
        }
      }
    }
    return NextResponse.json({
      settings: maskSecrets(cfg),
      latest,
      host: probe,
      updateAvailable: updateAvailable(probe.stackVersion, latest.tag || undefined),
      activeRun,
      runs: runs.slice(0, 20),
    })
  } catch (e) {
    return apiError(e)
  }
}

/** POST /api/clearndr-update — действия: probe | start | cancel | sync-script */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const action = body?.action
    const cfg = await loadUpdateSettings()

    if (action === 'probe') {
      const probe = await probeHost(cfg, true)
      return NextResponse.json({ ok: probe.ok, probe })
    }

    if (action === 'sync-script') {
      const r = await syncScript(cfg)
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    }

    if (action === 'start') {
      const opts = normalizeOptions(body?.options)
      const r = await startUpdate(cfg, opts)
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    }

    if (action === 'cancel') {
      if (!body?.runId) return NextResponse.json({ error: 'нужен runId' }, { status: 400 })
      const r = await cancelRun(cfg, String(body.runId))
      return NextResponse.json(r, { status: r.ok ? 200 : 400 })
    }

    return NextResponse.json({ error: 'action: probe | start | cancel | sync-script' }, { status: 400 })
  } catch (e) {
    return apiError(e)
  }
}

/** PUT /api/clearndr-update — сохранить настройки подключения/параметров */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'нужен объект {key: value}' }, { status: 400 })
    const { setSetting } = await import('@/lib/engine/service')
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (!(UPDATE_SETTING_KEYS as readonly string[]).includes(k)) continue
      const val = String(v ?? '')
      // маска из UI не перезаписывает сохранённый секрет
      if (val === MASK) continue
      await setSetting(k, val)
    }
    const cfg = await loadUpdateSettings()
    return NextResponse.json({ ok: true, settings: maskSecrets(cfg) })
  } catch (e) {
    return apiError(e)
  }
}

/** Валидация опций из UI (белые списки значений) */
function normalizeOptions(raw: unknown): UpdateOptions {
  const o = (raw ?? {}) as Partial<UpdateOptions>
  return {
    version: typeof o.version === 'string' ? o.version : '',
    opensearchData: o.opensearchData === 'wipe' ? 'wipe' : 'keep',
    pgStrategy: 'restore',
    updateCli: !!o.updateCli,
    skipDbDump: !!o.skipDbDump,
    skipVolume: !!o.skipVolume,
    fullConfig: !!o.fullConfig,
    skipMikrocataCheck: !!o.skipMikrocataCheck,
    healthTimeout: Math.min(3600, Math.max(60, parseInt(String(o.healthTimeout ?? ''), 10) || UPDATE_OPTIONS_DEFAULTS.healthTimeout)),
  }
}
