// ─────────────────────────────────────────────────────────────────────────────
// Редакции NDR&DNS Rules HUB.
//   community  (по умолчанию) — однопользовательский режим, без аутентификации:
//               весь функционал доступен как раньше, таблицы пользователей
//               не используются.
//   enterprise — многопользовательский режим: регистрация, верификация
//               администратором, личный кабинет, персональные токены скачивания.
// Задаётся переменной окружения NDR_EDITION (docker-compose.yml / .env).
// ─────────────────────────────────────────────────────────────────────────────

export type Edition = 'community' | 'enterprise'

export function edition(): Edition {
  return process.env.NDR_EDITION === 'enterprise' ? 'enterprise' : 'community'
}

/** Многопользовательский режим включён (регистрация, кабинеты, верификация) */
export function multiUserEnabled(): boolean {
  return edition() === 'enterprise'
}

export function editionLabel(): string {
  return edition() === 'enterprise' ? 'Enterprise' : 'Community'
}
