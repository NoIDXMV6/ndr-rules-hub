import { NextResponse } from 'next/server'
import { fetchAllSources } from '@/lib/engine/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

export async function POST() {
  const res = await fetchAllSources('manual')
  return NextResponse.json(res)
}
