// ─────────────────────────────────────────────────────────────────────────────
// Единый шлюз доступа для API-роутов: rate limit → CSRF (origin) → аутентификация
// → авторизация (роль). Использование в роуте:
//   const g = await guard(req, { admin: true })
//   if (g instanceof NextResponse) return g   // 401/403/429 уже сформированы
//   const { user, role } = g
//
// Community-редакция: аутентификации нет — guard пропускает всех (как раньше),
// возвращая роль 'admin' и user=null. Enterprise: доступ только верифицированным
// пользователям; admin: true — только администраторам.
// ─────────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from 'next/server'
import { multiUserEnabled } from '@/lib/edition'
import { getSetting } from '@/lib/engine/service'
import { clientIp, rateLimit, RateRule, RateVerdict } from './ratelimit'
import { getSession, SafeUser } from './session'
import { audit } from './audit'

export interface GuardOpts {
  /** Только для администраторов */
  admin?: boolean
  /** Лимит частоты: key — scope (добавится ':ip'), rule — окно/лимит */
  rate?: { key: string; rule: RateRule }
  /** Разрешить анонимный доступ и в Enterprise (эндпоинты с токен-аутентификацией) */
  allowAnonymous?: boolean
}

export interface GuardCtx {
  user: SafeUser | null
  role: 'admin' | 'user' | 'anon'
  ip: string
}

export function jsonError(status: number, message: string, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error: message }, { status, headers })
}

/** Гейт редакции: эндпоинты многопользовательского режима существуют только в Enterprise */
export function requireMultiUser(): NextResponse | null {
  if (!multiUserEnabled()) {
    return jsonError(404, 'Многопользовательский режим доступен только в редакции Enterprise')
  }
  return null
}

export function tooMany(v: RateVerdict, message = 'Слишком много запросов — попробуйте позже'): NextResponse {
  return jsonError(429, message, { 'Retry-After': String(Math.max(1, v.retryAfterSec)) })
}

/**
 * Проверка источника state-changing запросов (анти-CSRF).
 * Браузер всегда шлёт Sec-Fetch-Site/Origin; curl и scirius их не шлют —
 * им не запрещаем (аутентификация у них по токену, а не по cookie).
 */
export function sameOriginOk(req: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.get('origin')
  if (!origin) return true // не-браузерный клиент
  try {
    const host = req.headers.get('host')
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}

/** Ключи настроек, которые нельзя отдавать не-администратору (секреты) */
export const SECRET_SETTING_KEYS = [
  'serveToken',
  'dnsServeToken', // ключ отдачи списка доменов (GET /api/dns/export)
  'oinkcode',
  'etProOinkcode', // oinkcode ET Pro (Proofpoint) — отдельно от снортовского
  'abusechAuthKey',
  'mispAuthKey', // ключ REST API MISP
  'openNrdLicense', // код лицензии Open NRD (Stamus Networks)
  'clearndrExportToken',
  'tgBotToken', // токен Telegram-бота
  'gotifyToken', // app-токен Gotify
  'mispIngestToken', // токен webhook-приёмника /api/misp/ingest
  'mispConnWazuhPass', // пароль Wazuh Indexer
  'mispConnZabbixPassword', // пароль Zabbix API
  'mispConnZabbixToken', // API-токен Zabbix
  'mispConnMikrotikPass', // пароль RouterOS REST
]

export function sanitizeSettings<T extends Record<string, string>>(settings: T, role: GuardCtx['role']): T {
  if (role === 'admin') return settings
  const out = { ...settings }
  for (const k of SECRET_SETTING_KEYS) delete out[k]
  return out
}

export async function guard(req: Request, opts: GuardOpts = {}): Promise<GuardCtx | NextResponse> {
  const ip = clientIp(req)

  // 1) rate limit — до аутентификации: перебор ключей/паролей отсекается сразу
  if (opts.rate) {
    const v = rateLimit(`${opts.rate.key}:${ip}`, opts.rate.rule)
    if (!v.ok) {
      void audit('ratelimit', { ip, detail: `scope=${opts.rate.key}` })
      return tooMany(v)
    }
  }

  // 2) анти-CSRF для state-changing запросов браузера
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')

  // 3) Community: пропускаем всех с полными правами (совместимость)
  if (!multiUserEnabled()) return { user: null, role: 'admin', ip }

  // 4) Enterprise: сессия обязательна (если не разрешён аноним — токен-эндпоинты)
  const ttlHours = parseInt(await getSetting('sessionTtlHours'), 10) || null
  const session = await getSession(req, ttlHours)
  if (!session) {
    if (opts.allowAnonymous) return { user: null, role: 'anon', ip }
    return jsonError(401, 'Требуется вход в систему')
  }
  const u = session.user
  if (opts.admin && u.role !== 'admin') return jsonError(403, 'Доступно только администратору')
  return { user: u, role: u.role === 'admin' ? 'admin' : 'user', ip }
}
