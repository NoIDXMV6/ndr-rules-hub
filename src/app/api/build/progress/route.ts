// GET /api/build/progress — состояние текущей/последней сборки (прогрессбар UI).
// Возвращает фазу, процент, хвост журнала и (после завершения) результат.
import { NextResponse } from 'next/server'
import { getBuildProgress } from '@/lib/engine/build-progress'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const g = await guard(req, { rate: { key: 'build', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  return NextResponse.json({ progress: getBuildProgress() })
}
