import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const take = Math.min(500, Math.max(10, parseInt(req.nextUrl.searchParams.get('take') || '100', 10)))
  const logs = await db.logEntry.findMany({ orderBy: { ts: 'desc' }, take })
  return NextResponse.json({ logs })
}
