import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/** GET /api — краткая информация о сервисе (проверка доступности бэкенда) */
export async function GET() {
  return NextResponse.json({
    service: 'NDR Rules Hub',
    version: process.env.APP_VERSION ?? 'dev',
    api: ['/api/health', '/api/dashboard', '/api/sources', '/api/rules', '/api/build', '/api/export', '/api/vpn', '/api/settings', '/api/logs'],
  })
}
