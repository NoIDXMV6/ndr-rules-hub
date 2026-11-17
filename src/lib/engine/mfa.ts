// ─────────────────────────────────────────────────────────────────────────────
// Двухфакторная аутентификация (2FA): одноразовые коды (Telegram) и TOTP
// (RFC 6238, совместим с Google Authenticator / Authy / FreeOTP).
// Коды хранятся открытыми ровно до отправки/истечения (нужны для доставки
// в Telegram), TTL 5 минут, максимум 5 неверных вводов.
// TOTP-секрет — base32; QR-код генерируется в data-URL сервером (qrcode).
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'

export type TwoFactorMethod = 'none' | 'telegram' | 'totp'

export const CODE_TTL_MS = 5 * 60_000
export const MAX_CODE_ATTEMPTS = 5

// ── Одноразовые коды ─────────────────────────────────────────────────────────

/** 6-значный код: криптостойкий ГСЧ, без ведущих нулей не требуется — строкой */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Записать код пользователю (перезаписывает предыдущий) */
export async function issueVerificationCode(userId: string): Promise<string> {
  const code = generateCode()
  await db.user.update({
    where: { id: userId },
    data: {
      verificationCode: code,
      verificationExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      verificationAttempts: 0,
    },
  })
  return code
}

export interface CodeVerdict {
  ok: boolean
  error?: string
}

/** Проверить и погасить одноразовый код (Telegram-ветка 2FA) */
export async function verifyVerificationCode(userId: string, code: string): Promise<CodeVerdict> {
  const u = await db.user.findUnique({ where: { id: userId } })
  if (!u) return { ok: false, error: 'пользователь не найден' }
  if (!u.verificationCode || !u.verificationExpiresAt) return { ok: false, error: 'код не выпущен — запросите новый' }
  if (u.verificationExpiresAt.getTime() < Date.now()) {
    await clearVerificationCode(userId)
    return { ok: false, error: 'код истёк — запросите новый' }
  }
  if (u.verificationAttempts >= MAX_CODE_ATTEMPTS) {
    await clearVerificationCode(userId)
    return { ok: false, error: 'слишком много неверных вводов — запросите новый код' }
  }
  const a = String(code ?? '').trim()
  const ok = a.length === 6 && timingSafeEqual(Buffer.from(a), Buffer.from(u.verificationCode))
  if (!ok) {
    await db.user.update({ where: { id: userId }, data: { verificationAttempts: { increment: 1 } } })
    const left = MAX_CODE_ATTEMPTS - (u.verificationAttempts + 1)
    return { ok: false, error: left > 0 ? `неверный код (осталось попыток: ${left})` : 'неверный код — попытки исчерпаны, запросите новый' }
  }
  await clearVerificationCode(userId)
  return { ok: true }
}

async function clearVerificationCode(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { verificationCode: null, verificationExpiresAt: null, verificationAttempts: 0 },
  })
}

// ── Base32 (RFC 4648) ────────────────────────────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// ── TOTP (RFC 6238, SHA-1, 6 цифр, шаг 30 c) ─────────────────────────────────

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', secret).update(buf).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

/** Текущий код TOTP (для тестов и отладки) */
export function totpNow(secretBase32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 30_000))
}

/**
 * Проверить код TOTP с окном ±windowSteps шагов (по умолчанию ±2 шага = ±60 c) —
 * компенсация расхождения часов устройства с сервером: коды, показанные приложением
 * «раньше» или «позже» текущего шага сервера, всё равно принимаются. Сравнение
 * константное по всем кандидатам.
 */
export function verifyTotp(secretBase32: string, code: string, atMs = Date.now(), windowSteps = 2): boolean {
  if (!/^\d{6}$/.test(String(code ?? '').trim())) return false
  const secret = base32Decode(secretBase32)
  if (secret.length < 10) return false // < 80 бит — некорректный секрет
  const counter = Math.floor(atMs / 30_000)
  const provided = Buffer.from(String(code).trim())
  for (let d = -windowSteps; d <= windowSteps; d++) {
    const c = counter + d
    if (c < 0) continue
    if (timingSafeEqual(Buffer.from(hotp(secret, c)), provided)) return true
  }
  return false
}

/** Новый секрет TOTP: 20 случайных байт → base32 (160 бит, как рекомендует RFC) */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** otpauth:// URI для приложения-аутентификатора */
export function otpauthUri(secretBase32: string, account: string): string {
  const issuer = 'NDR Rules Hub'
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

/** QR-код otpauth-URI в data-URL (рендерится на сервере) */
export async function totpQrDataUrl(uri: string): Promise<string> {
  const QR = (await import('qrcode')).default
  return QR.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
}

// ── Билет второго шага (MFA ticket) ──────────────────────────────────────────
// После пароля пользователь ещё НЕ аутентифицирован: выдаём короткоживущий
// HMAC-билет в HttpOnly cookie — второй шаг обязан прийти с ним. Секрет
// билета хранится в Setting (генерируется один раз, переживает рестарт).

import { randomToken } from '@/lib/security/ids'

export const MFA_COOKIE = 'ndrh_mfa'
const MFA_TTL_MS = 5 * 60_000

async function mfaSecret(): Promise<string> {
  const row = await db.setting.findUnique({ where: { key: 'mfaTicketSecret' } })
  if (row?.value) return row.value
  const value = randomToken(32)
  await db.setting.upsert({ where: { key: 'mfaTicketSecret' }, create: { key: 'mfaTicketSecret', value }, update: { value } }).catch(() => undefined)
  return value
}

/** Выдать билет второго шага: строка base64url(payload).hmac */
export async function issueMfaTicket(purpose: 'login' | 'register', userId: string): Promise<{ ticket: string; expiresSec: number }> {
  const key = await mfaSecret()
  const exp = Date.now() + MFA_TTL_MS
  const payload = `${purpose}|${userId}|${exp}`
  const sig = createHmac('sha256', key).update(payload).digest('hex').slice(0, 32)
  return { ticket: `${Buffer.from(payload).toString('base64url')}.${sig}`, expiresSec: MFA_TTL_MS / 1000 }
}

/** Проверить билет из cookie; возвращает userId или null */
export async function verifyMfaTicket(req: Request, purpose: 'login' | 'register'): Promise<string | null> {
  const cookie = req.headers.get('cookie') ?? ''
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${MFA_COOKIE}=([^;]+)`))
  if (!m) return null
  const [payload, sig] = decodeURIComponent(m[1]).split('.')
  if (!payload || !sig) return null
  let parts: string[]
  try {
    parts = Buffer.from(payload, 'base64url').toString('utf8').split('|')
  } catch {
    return null
  }
  if (parts.length !== 3 || parts[0] !== purpose) return null
  const key = await mfaSecret()
  const expect = createHmac('sha256', key).update(`${parts[0]}|${parts[1]}|${parts[2]}`).digest('hex').slice(0, 32)
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
  if (parseInt(parts[2], 10) < Date.now()) return null
  return parts[1]
}

export function mfaCookieAttrs(expiresSec: number, https: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: https,
    path: '/',
    maxAge: expiresSec,
  }
}
