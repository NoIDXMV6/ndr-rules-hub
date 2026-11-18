import { NextRequest, NextResponse } from 'next/server'
import { guard } from '@/lib/security/guard'
import { apiError } from '@/lib/api-error'
import { getSettings, log } from '@/lib/engine/service'
import { deployMisp, removeMisp, mispDeployState } from '@/lib/engine/misp-deploy'
import { mispTestConnection, connectorStates, runConnector, ensureConnectorLoop, CONNECTOR_IDS } from '@/lib/engine/misp-connectors'

export const dynamic = 'force-dynamic'

/** GET /api/misp — состояние раздела: связь (URL/ключ), деплой, коннекторы */
export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'misp', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  ensureConnectorLoop()
  try {
    const s = await getSettings()
    const deploy = await mispDeployState()
    let version: string | null = null
    let connectionOk = false
    let connectionError: string | undefined
    if (s.mispUrl && s.mispAuthKey) {
      const t = await mispTestConnection()
      connectionOk = t.ok
      version = t.version ?? null
      if (!t.ok) connectionError = t.error
    }
    return NextResponse.json({
      connection: { url: s.mispUrl ?? '', authKeySet: !!s.mispAuthKey, ok: connectionOk, version, error: connectionError },
      deploy,
      ingest: { tokenSet: !!s.mispIngestToken },
      connectors: await connectorStates(),
    })
  } catch (e) {
    return apiError(e)
  }
}

/** POST /api/misp — действия (только администратор):
 *  {action: 'test'}                     — проверить связь с MISP (значения из формы уже сохранены);
 *  {action: 'deploy', port?, baseUrl?}  — развернуть стек MISP (docker compose);
 *  {action: 'remove'}                   — удалить стек (тома данных сохраняются);
 *  {action: 'run-connector', id}        — запустить коннектор вручную;
 *  {action: 'regen-ingest-token'}       — перевыпустить токен webhook-приёмника. */
export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'misp', rule: { limit: 20, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  ensureConnectorLoop()
  try {
    const body = await req.json().catch(() => ({}))
    const action = body?.action
    if (action === 'test') {
      const cfg = {
        url: typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined,
        key: typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined,
      }
      const r = await mispTestConnection(cfg)
      await log(r.ok ? 'info' : 'error', 'misp', `Тест связи с MISP: ${r.ok ? `версия ${r.version}` : r.error}`)
      return NextResponse.json(r)
    }
    if (action === 'deploy') {
      const port = parseInt(body.port, 10) || undefined
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : undefined
      const r = await deployMisp({ port, baseUrl })
      return NextResponse.json(r)
    }
    if (action === 'remove') {
      const r = await removeMisp()
      return NextResponse.json(r)
    }
    if (action === 'run-connector') {
      const id = String(body.id ?? '')
      if (!CONNECTOR_IDS.includes(id as (typeof CONNECTOR_IDS)[number])) {
        return NextResponse.json({ error: `id: ${CONNECTOR_IDS.join(' | ')}` }, { status: 400 })
      }
      const r = await runConnector(id as (typeof CONNECTOR_IDS)[number])
      return NextResponse.json(r)
    }
    if (action === 'regen-ingest-token') {
      const { randomBytes } = await import('crypto')
      const { setSetting } = await import('@/lib/engine/service')
      const token = `misp_${randomBytes(24).toString('base64url')}`
      await setSetting('mispIngestToken', token)
      await log('info', 'misp', 'Токен webhook-приёмника MISP перевыпущен')
      return NextResponse.json({ ok: true, token })
    }
    return NextResponse.json({ error: 'action: test | deploy | remove | run-connector | regen-ingest-token' }, { status: 400 })
  } catch (e) {
    return apiError(e)
  }
}
