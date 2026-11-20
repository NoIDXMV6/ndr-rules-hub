// DNS-фильтрация: прогресс сборки списка доменов (администратор)
import { NextRequest, NextResponse } from 'next/server'
import { guard } from '@/lib/security/guard'
import { dnsBuildProgressState } from '@/lib/engine/dns-service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns', rule: { limit: 600, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  return NextResponse.json({ progress: dnsBuildProgressState() })
}
