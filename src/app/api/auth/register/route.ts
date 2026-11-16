// POST /api/auth/register — регистрация в многопользовательском режиме
// (только Enterprise). Первый зарегистрированный пользователь становится
// администратором (bootstrap), остальные попадают в статус pending и ждут
// верификации администратором. Лимит: 5 регистраций с IP в час (анти-бот).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireMultiUser, jsonError, sameOriginOk } from '@/lib/security/guard'
import { hashPassword, passwordIssues } from '@/lib/security/password'
import { clientIp, rateLimit, resetRate } from '@/lib/security/ratelimit'
import { audit } from '@/lib/security/audit'

export const dynamic = 'force-dynamic'

const REG_RULE = { limit: 5, windowMs: 3_600_000, blockMs: 3_600_000 }
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate

  const ip = clientIp(req)
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')
  const rl = rateLimit(`register:${ip}`, REG_RULE)
  if (!rl.ok) {
    void audit('ratelimit', { ip, detail: 'register: всплеск регистраций' })
    return NextResponse.json(
      { error: 'Слишком много регистраций с этого адреса — повторите через час' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const body = await req.json().catch(() => null) as { email?: string; displayName?: string; password?: string } | null
  const email = String(body?.email ?? '').trim().toLowerCase()
  const displayName = String(body?.displayName ?? '').trim()
  const password = String(body?.password ?? '')
  if (!EMAIL_RE.test(email) || email.length > 200) return jsonError(400, 'Некорректный email')
  if (!displayName || displayName.length > 100) return jsonError(400, 'Укажите имя (до 100 символов)')
  const issues = passwordIssues(password)
  if (issues.length) return jsonError(400, `Пароль слабый: ${issues.join(', ')}`)

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (existing) return jsonError(400, 'Пользователь с таким email уже зарегистрирован')

  // регистрация закрывается администратором; bootstrap (первый админ) разрешён всегда
  const userCount = await db.user.count()
  const open = (await db.setting.findUnique({ where: { key: 'registrationOpen' } }))?.value !== 'false'
  if (!open && userCount > 0) return jsonError(403, 'Регистрация закрыта администратором')

  const isFirst = userCount === 0
  const user = await db.user.create({
    data: {
      email,
      displayName,
      passwordHash: hashPassword(password),
      role: isFirst ? 'admin' : 'user',
      status: isFirst ? 'active' : 'pending',
      verifiedAt: isFirst ? new Date() : null,
    },
    select: { id: true, email: true, displayName: true, role: true, status: true },
  })
  void audit('register', { email, userId: user.id, ip, detail: isFirst ? 'bootstrap: первый пользователь → администратор' : 'ожидает верификации' })
  if (isFirst) resetRate(`login:ip:${ip}`)
  return NextResponse.json({
    ok: true,
    user,
    message: isFirst
      ? 'Первый пользователь создан как администратор — войдите в систему'
      : 'Регистрация принята — доступ будет открыт после верификации администратором',
  })
}
