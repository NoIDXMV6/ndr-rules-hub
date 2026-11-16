// ─────────────────────────────────────────────────────────────────────────────
// Криптографические примитивы: генерация токенов, хеши, константное сравнение.
// Все секреты (сессии, токены скачивания) хранятся ТОЛЬКО как SHA-256:
// утечка дампа БД не раскрывает действующие токены.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes, createHash, timingSafeEqual } from 'crypto'

/** Криптостойкий случайный токен в base64url (без «=») */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Константное сравнение строк через SHA-256: длины выравниваются хешем,
 * поэтому время сравнения не зависит от позиции первого различия.
 * Подходит для ключей отдачи; для проверки паролей — verifyPassword().
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}
