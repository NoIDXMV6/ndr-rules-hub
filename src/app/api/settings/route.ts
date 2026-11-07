import { NextRequest, NextResponse } from 'next/server'
import { getSettings, setSetting, reinitScheduler } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json({ settings: await getSettings() })
  } catch (e) {
    return apiError(e)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'нужен объект {key: value}' }, { status: 400 })
    for (const [k, v] of Object.entries(body)) {
      await setSetting(k, String(v))
    }
    await reinitScheduler()
    return NextResponse.json({ ok: true, settings: await getSettings() })
  } catch (e) {
    return apiError(e)
  }
}
