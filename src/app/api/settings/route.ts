import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSettings, setSetting, reinitScheduler } from '@/lib/engine/service'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ settings: await getSettings() })
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'нужен объект {key: value}' }, { status: 400 })
  for (const [k, v] of Object.entries(body)) {
    await setSetting(k, String(v))
  }
  await reinitScheduler()
  return NextResponse.json({ ok: true, settings: await getSettings() })
}
