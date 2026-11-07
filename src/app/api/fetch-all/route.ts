import { NextResponse } from 'next/server'
import { fetchAllSources } from '@/lib/engine/service'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

export async function POST() {
  try {
    const res = await fetchAllSources('manual')
    return NextResponse.json(res)
  } catch (e) {
    return apiError(e)
  }
}
