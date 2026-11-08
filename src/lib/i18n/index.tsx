'use client'

// React-провайдер языка интерфейса.
// Хранилище языка — внешнее (localStorage + строки браузера navigator.languages),
// поэтому используется useSyncExternalStore: SSR и гидрация рендерят русский
// (основной язык проекта), сразу после монтирования React переключается на
// определённый по браузеру язык без рассинхрона гидрации и без setState в effect.
// Переключатель в шапке вызывает setLang(); выбор сохраняется и применяется мгновенно.

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { ru, type Dictionary } from './ru'
import { en } from './en'
import { detectLang, localeOf, tr, persistLangCookie, LANG_STORAGE_KEY, type Lang } from './detect'

const DICTS: Record<Lang, Dictionary> = { ru, en }

// --- внешнее хранилище языка -------------------------------------------------
// currentLang === null → на этом клиенте ещё не определяли (сервер: всегда 'ru')
let currentLang: Lang | null = null
const listeners = new Set<() => void>()

function detectOnce(): Lang {
  if (currentLang) return currentLang
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(LANG_STORAGE_KEY)
  } catch {
    // localStorage может быть недоступен (приватный режим) — берём только браузер
  }
  const browser = (navigator.languages && navigator.languages.length > 0
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : []) as readonly string[]
  currentLang = detectLang(browser, stored)
  // синхронизируем cookie с реальным языком: сервер (generateMetadata, <html lang>)
  // рендерит title/атрибуты под этот язык при каждой загрузке
  persistLangCookie(currentLang)
  return currentLang
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): Lang {
  return detectOnce()
}

function getServerSnapshot(): Lang {
  return 'ru'
}

function setLang(l: Lang): void {
  currentLang = l
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, l)
  } catch {
    // приватный режим — выбор проживёт до перезагрузки страницы
  }
  persistLangCookie(l)
  for (const cb of listeners) cb()
}
// ------------------------------------------------------------------------------

const I18nContext = createContext<I18nContextValue | null>(null)

interface I18nContextValue {
  lang: Lang
  setLang: (l: Lang) => void
  /** словарь текущего языка */
  t: Dictionary
  /** интерполяция шаблонов: tr(t.hello, {name: 'X'}) */
  tr: typeof tr
  /** BCP-47 локаль текущего языка для toLocaleString */
  loc: string
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // синхронизация внешних систем (DOM) — это законная работа effect'а.
  // Повтор через 300мс — страховка: React/Next после гидрации один раз
  // восстанавливают <title> из серверных метаданных (актуально только для
  // первого визита, когда cookie ещё не была выставлена — при следующих
  // загрузках сервер сам рендерит правильный title по cookie).
  useEffect(() => {
    const apply = () => {
      document.documentElement.lang = lang
      const expected = DICTS[lang].meta.title
      if (document.title !== expected) document.title = expected
    }
    apply()
    const id = window.setTimeout(apply, 300)
    return () => window.clearTimeout(id)
  }, [lang])

  const set = useCallback((l: Lang) => setLang(l), [])
  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang: set, t: DICTS[lang], tr, loc: localeOf(lang) }),
    [lang, set],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}

export { detectLang, isLang, localeOf, tr, persistLangCookie, readLangCookie, LANGS, LANG_STORAGE_KEY, DEFAULT_LANG } from './detect'
export type { Lang } from './detect'
export type { Dictionary } from './ru'
