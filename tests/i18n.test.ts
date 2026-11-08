import { describe, expect, it } from 'vitest'
import { detectLang, isLang, localeOf, tr, DEFAULT_LANG } from '@/lib/i18n/detect'
import { ru } from '@/lib/i18n/ru'
import { en } from '@/lib/i18n/en'
import { fmtSize, fmtTime } from '@/components/hub/api'

/** Плоский список путей ключей словаря: ['header.fullCycle', ...] */
function flatten(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') {
      for (const [p, s] of flatten(v, path)) out.set(p, s)
    } else {
      out.set(path, String(v))
    }
  }
  return out
}

const ruFlat = flatten(ru)
const enFlat = flatten(en)

const PLACEHOLDER = /\{(\w+)\}/g

describe('detectLang — язык по строкам браузера', () => {
  it('сохранённый выбор пользователя приоритетнее браузера', () => {
    expect(detectLang(['en-US', 'ru'], 'ru')).toBe('ru')
    expect(detectLang(['ru-RU'], 'en')).toBe('en')
  })

  it('первый язык браузера, для которого есть перевод, выигрывает', () => {
    expect(detectLang(['en-US', 'ru-RU'])).toBe('en')
    expect(detectLang(['ru-RU', 'en-US'])).toBe('ru')
  })

  it('понимает точные теги и первичные субтега без учёта регистра', () => {
    expect(detectLang(['RU'])).toBe('ru')
    expect(detectLang(['en'])).toBe('en')
    expect(detectLang(['be-BY', 'ru-RU'])).toBe('ru') // белорусский не поддержан → следующий
  })

  it('ничего не совпало / пусто / мусор — язык проекта по умолчанию', () => {
    expect(detectLang(['fr-FR', 'de-DE'])).toBe(DEFAULT_LANG)
    expect(detectLang([])).toBe(DEFAULT_LANG)
    expect(detectLang(undefined)).toBe(DEFAULT_LANG)
    expect(detectLang(['', 42 as unknown as string])).toBe(DEFAULT_LANG)
  })

  it('битый stored игнорируется, но валидный принимается', () => {
    expect(detectLang(['en'], 'xx')).toBe('en')
    expect(detectLang([], 'en')).toBe('en')
    expect(isLang('ru')).toBe(true)
    expect(isLang('de')).toBe(false)
  })
})

describe('tr — интерполяция шаблонов', () => {
  it('подставляет строковые и числовые значения', () => {
    expect(tr('Собрано {n} правил → {file}', { n: 42, file: 'suricata.rules' })).toBe('Собрано 42 правил → suricata.rules')
    expect(tr('{ok}/{enabled} OK', { ok: 3, enabled: 5 })).toBe('3/5 OK')
  })

  it('неизвестный плейсхолдер остаётся как есть', () => {
    expect(tr('Hi {name} and {unknown}', { name: 'X' })).toBe('Hi X and {unknown}')
  })

  it('без переменных шаблон возвращается без изменений', () => {
    expect(tr('Just text')).toBe('Just text')
  })
})

describe('localeOf', () => {
  it('возвращает BCP-47 локаль', () => {
    expect(localeOf('ru')).toBe('ru-RU')
    expect(localeOf('en')).toBe('en-US')
  })
})

describe('паритет словарей ru/en', () => {
  it('наборы ключей совпадают один в один', () => {
    expect([...enFlat.keys()].sort()).toEqual([...ruFlat.keys()].sort())
  })

  it('нет пустых значений', () => {
    for (const [k, v] of [...ruFlat, ...enFlat]) {
      expect(v.trim(), `пустое значение: ${k}`).not.toBe('')
    }
  })

  it('плейсхолдеры совпадают в обоих языках', () => {
    for (const [k, ruV] of ruFlat) {
      const enV = enFlat.get(k) as string
      expect([...enV.matchAll(PLACEHOLDER)].map((m) => m[1]).sort(), `плейсхолдеры EN ${k}`).toEqual(
        [...ruV.matchAll(PLACEHOLDER)].map((m) => m[1]).sort(),
      )
    }
  })

  it('в русском по преимуществу кириллица, в английском её нет', () => {
    const cyr = /[а-яё]/i
    // большинство значений ru-словаря — русский текст;
    // технические термины (ruleset, oinkcode (snort.org), /dev/net/tun) — исключения
    const withCyr = [...ruFlat.values()].filter((v) => cyr.test(v)).length
    expect(withCyr / ruFlat.size).toBeGreaterThan(0.6)
    for (const k of ['tabs.help', 'tabs.about', 'header.fullCycle', 'overview.loading', 'settings.save']) {
      expect(cyr.test(ruFlat.get(k) ?? ''), `в ru.${k} нет кириллицы`).toBe(true)
    }
    for (const [k, v] of enFlat) {
      expect(cyr.test(v), `в en.${k} кириллица: «${v}»`).toBe(false)
    }
  })

  it('словарь содержит все вкладки и ключевые блоки', () => {
    for (const ns of ['meta', 'header', 'tabs', 'footer', 'messages', 'overview', 'sources', 'rules', 'build', 'vpn', 'settings', 'logs', 'help', 'about']) {
      expect(ruFlat.has(ns) || [...ruFlat.keys()].some((k) => k.startsWith(`${ns}.`)), ns).toBe(true)
    }
    expect(ruFlat.get('tabs.help')).toBe('Помощь')
    expect(enFlat.get('tabs.help')).toBe('Help')
    expect(ruFlat.get('tabs.about')).toBe('О системе')
    expect(enFlat.get('tabs.about')).toBe('About')
  })
})

describe('локализованные единицы и даты (api.ts)', () => {
  it('fmtSize учитывает язык', () => {
    expect(fmtSize(512, 'ru')).toBe('512 Б')
    expect(fmtSize(512, 'en')).toBe('512 B')
    expect(fmtSize(2048, 'ru')).toBe('2.0 КБ')
    expect(fmtSize(2048, 'en')).toBe('2.0 KB')
    expect(fmtSize(3 * 1048576, 'en')).toBe('3.0 MB')
  })

  it('fmtTime: пустая дата — тире; локали дают разные разделители', () => {
    expect(fmtTime(null, 'ru')).toBe('—')
    expect(fmtTime(null, 'en')).toBe('—')
    const ts = '2025-06-01T04:05:00.000Z'
    // ru: «01.06, 04:05» · en: «06/01, 04:05 AM» (без года: в шаблоне день/месяц/время)
    expect(fmtTime(ts, 'ru')).toMatch(/^\d{2}\.\d{2}/)
    expect(fmtTime(ts, 'en')).toMatch(/^\d{2}\/\d{2}/)
    expect(fmtTime(ts, 'ru')).toContain('.')
    expect(fmtTime(ts, 'en')).toContain('/')
  })
})
