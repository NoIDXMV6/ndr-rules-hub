// Проверка API-ключа RST Cloud: POST /api/rst/check
// Вызывает GET https://api.rstcloud.net/v1/auth/check — валидность ключа,
// права (entitlements) и квота запросов (used/limit/remaining/period).
// Только для администратора (ключ — секрет уровня системы); тратит 1 запрос
// квоты. Ключ берётся из настройки rstApiKey либо из тела запроса {key}.
import { NextRequest, NextResponse } from 'next/server'
import { getSettings, setSetting } from '@/lib/engine/service'
import { rstCheckKey } from '@/lib/engine/rst'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'rst', rule: { limit: 20, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => null) as { key?: string } | null
    let key = body?.key?.trim() ?? ''
    if (!key) key = (await getSettings()).rstApiKey?.trim() ?? ''
    if (!key) {
      return NextResponse.json({ ok: false, error: 'Ключ не задан — введите API-ключ RST Cloud в поле выше' }, { status: 400 })
    }
    // сохраняем проверенный ключ в настройки (как oinkcode/abusechAuthKey)
    await setSetting('rstApiKey', key)
    const res = await rstCheckKey(key)
    return NextResponse.json(res)
  } catch (e) {
    return apiError(e)
  }
}
