// Живость доменов (dns-alive.ts): состояние и управление сканом.
//  GET  /api/dns/alive — настройки (dnsAlive*), прогресс скана, счётчики вердиктов;
//  POST /api/dns/alive { action: 'start' | 'cancel' } — запуск/отмена проверки.
// Только администратор: скан шлёт массовые DNS-запросы наружу.
import { NextRequest, NextResponse } from 'next/server'
import { guard } from '@/lib/security/guard'
import { getSettings } from '@/lib/engine/service'
import {
  startDomainAliveScan, cancelDomainAliveScan, getDomainAliveProgress,
  domainAliveCounts, DNS_ALIVE_DEFAULTS,
} from '@/lib/engine/dns-alive'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns-alive', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  const [settings, progress, counts] = await Promise.all([
    getSettings(),
    Promise.resolve(getDomainAliveProgress()),
    domainAliveCounts(),
  ])
  return NextResponse.json({
    settings: {
      dnsAliveCheckEnabled: settings.dnsAliveCheckEnabled ?? DNS_ALIVE_DEFAULTS.dnsAliveCheckEnabled,
      dnsAliveTtlDays: settings.dnsAliveTtlDays ?? DNS_ALIVE_DEFAULTS.dnsAliveTtlDays,
      dnsAliveConcurrency: settings.dnsAliveConcurrency ?? DNS_ALIVE_DEFAULTS.dnsAliveConcurrency,
      dnsAliveTimeoutMs: settings.dnsAliveTimeoutMs ?? DNS_ALIVE_DEFAULTS.dnsAliveTimeoutMs,
    },
    progress,
    counts,
  })
}

export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'dns-alive', rule: { limit: 30, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  const body = await req.json().catch(() => null) as { action?: string } | null
  const action = body?.action
  if (action === 'start') {
    const started = await startDomainAliveScan('manual')
    if (!started) return NextResponse.json({ ok: false, error: 'Проверка живости уже выполняется' }, { status: 409 })
    return NextResponse.json({ ok: true })
  }
  if (action === 'cancel') {
    return NextResponse.json({ ok: cancelDomainAliveScan() })
  }
  return NextResponse.json({ ok: false, error: 'action: start | cancel' }, { status: 400 })
}
