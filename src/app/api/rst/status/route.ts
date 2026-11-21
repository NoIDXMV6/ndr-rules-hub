// Статус интеграции RST Cloud: GET /api/rst/status (только администратор).
// Без обращений к внешнему API: задан ли ключ (rstApiKey), состояние четырёх
// фидов Threat Feed — три в «Правилах» (IP/URL/SHA-256, authType=rstkey) и
// доменный фид в «DNS списках» (DomainSource, authType=rstkey). Используется
// карточкой RST Cloud на вкладке «Интеграции».
import { NextRequest, NextResponse } from 'next/server'
import { guard } from '@/lib/security/guard'
import { db } from '@/lib/db'
import { getSettings } from '@/lib/engine/service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst-status', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  const settings = await getSettings()
  const [ruleSources, dnsSources] = await Promise.all([
    db.source.findMany({
      where: { authType: 'rstkey', deletedAt: null },
      select: { id: true, name: true, enabled: true, status: true, lastError: true, ruleCount: true, category: true },
      orderBy: { name: 'asc' },
    }),
    db.domainSource.findMany({
      where: { authType: 'rstkey', deletedAt: null },
      select: { id: true, name: true, enabled: true, status: true, lastError: true, domainCount: true },
      orderBy: { name: 'asc' },
    }),
  ])
  return NextResponse.json({
    keySet: Boolean(settings.rstApiKey?.trim()),
    ruleSources,
    dnsSources,
  })
}
