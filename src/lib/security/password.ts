// ─────────────────────────────────────────────────────────────────────────────
// Хеширование паролей (scrypt) и проверка политики пароля.
// Формат хранения: scrypt$N$r$p$<salt b64>$<hash b64>
// Параметры подобран под контейнер (SQLite + scrypt 16384 ≈ 40–60 мс на вход).
// Сравнение — только timingSafeEqual, чтобы не раскрывать время угадывания.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

const N = 16384 // 2^14 — стоимость
const R = 8
const P = 1
const KEYLEN = 64
const SALTLEN = 16

export function hashPassword(password: string): string {
  const salt = randomBytes(SALTLEN)
  const hash = scryptSync(Buffer.from(password, 'utf8'), salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const n = parseInt(parts[1], 10)
    const r = parseInt(parts[2], 10)
    const p = parseInt(parts[3], 10)
    const salt = Buffer.from(parts[4], 'base64')
    const expected = Buffer.from(parts[5], 'base64')
    const actual = scryptSync(Buffer.from(password, 'utf8'), salt, expected.length, { N: n, r, p })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** Требования к паролю: ≥ 8 символов, буквы и цифры. Возвращает список проблем. */
export function passwordIssues(password: string): string[] {
  const issues: string[] = []
  if (password.length < 8) issues.push('минимум 8 символов')
  if (!/[A-Za-zА-Яа-яЁё]/.test(password)) issues.push('нужна хотя бы одна буква')
  if (!/\d/.test(password)) issues.push('нужна хотя бы одна цифра')
  return issues
}
