// Ядро определения языка. Чистые функции без React — легко тестируются.
// Язык интерфейса определяется по строкам браузера (navigator.languages),
// выбор пользователя сохраняется в localStorage и имеет наивысший приоритет.

export type Lang = 'ru' | 'en'

export const LANGS: readonly Lang[] = ['ru', 'en'] as const

/** Ключ localStorage И имя cookie, в которых хранится выбор языка */
export const LANG_STORAGE_KEY = 'ndrh.lang'

/**
 * Записать выбор языка в cookie (для сервера: generateMetadata и <html lang>
 * читают её при каждой загрузке — title/description совпадают с интерфейсом).
 * Безопасно вызывать и на сервере — там document не существует.
 */
export function persistLangCookie(lang: Lang): void {
  if (typeof document === 'undefined') return
  document.cookie = `${LANG_STORAGE_KEY}=${lang}; path=/; max-age=31536000; samesite=lax`
}

/** Прочитать выбор языка из cookie на сервере (null — cookie нет) */
export function readLangCookie(value: string | undefined | null): Lang | null {
  return isLang(value) ? value : null
}

/** Язык по умолчанию (основной язык проекта) */
export const DEFAULT_LANG: Lang = 'ru'

export function isLang(v: unknown): v is Lang {
  return v === 'ru' || v === 'en'
}

/**
 * Определить язык интерфейса.
 * @param candidates строки браузера в порядке предпочтения (navigator.languages / Accept-Language)
 * @param stored     сохранённый выбор пользователя (localStorage) — приоритетнее браузера
 *
 * Правила: точное совпадение 'ru'/'en' или совпадение первичного субтегра
 * ('ru-RU' → ru, 'en-US' → en). Первый совпавший язык браузера выигрывает.
 * Если ничего не совпало — язык проекта по умолчанию (ru).
 */
export function detectLang(candidates: readonly string[] | undefined, stored?: string | null): Lang {
  if (isLang(stored)) return stored
  for (const raw of candidates ?? []) {
    if (typeof raw !== 'string' || !raw) continue
    const sub = raw.toLowerCase().split('-')[0]
    if (sub === 'ru') return 'ru'
    if (sub === 'en') return 'en'
  }
  return DEFAULT_LANG
}

/** BCP-47 локаль для toLocaleString/toLocaleDateString */
export function localeOf(lang: Lang): string {
  return lang === 'ru' ? 'ru-RU' : 'en-US'
}

/**
 * Интерполяция шаблонов словаря: 'Собрано {n} правил' + {n: 5} → 'Собрано 5 правил'.
 * Неизвестные плейсхолдеры остаются как есть — их видно сразу при тестировании.
 */
export function tr(tpl: string, vars: Record<string, string | number> = {}): string {
  return tpl.replace(/\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m,
  )
}
