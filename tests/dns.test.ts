// Тесты DNS-фильтрации: разбор хостлистов, слияние источников, рендер файла,
// потоковый парсер SQL-дампа, scope токенов скачивания.
import { describe, it, expect } from 'vitest'
import {
  parseDomainList, mergeDomainSources, renderDomainFile, normalizeDomain, isDomainLike,
} from '@/lib/engine/dns'
import { parseDumpFile, dumpCategoryName } from '@/lib/engine/dns-import'
import { normalizeTokenScope } from '@/lib/security/download-token'

describe('dns: normalizeDomain / isDomainLike', () => {
  it('приводит домен к каноническому виду', () => {
    expect(normalizeDomain(' Example.COM. ')).toBe('example.com')
    expect(normalizeDomain('www.example.com/path')).toBe('www.example.com')
    expect(isDomainLike('example.com')).toBe(true)
    expect(isDomainLike('métique.example')).toBe(false) // не-ASCII → невалиден
    expect(isDomainLike('top')).toBe(true) // одно-метка TLD
    expect(isDomainLike('localhost')).toBe(false)
    expect(isDomainLike('')).toBe(false)
  })
})

describe('dns: parseDomainList', () => {
  it('разбирает AdGuard-формат: ||домен^, TLD и исключения @@', () => {
    const text = [
      '[Adblock Plus 2.0]',
      '! Title: test',
      '||ads.example.com^',
      '||top^',
      '||multi.example.com^$important',
      '@@||ok.example.com^',
      '# просто комментарий',
      'plain-not-a-domain!!!',
    ].join('\n')
    const r = parseDomainList(text, 'auto')
    expect(r.format).toBe('adguard')
    expect(r.blocked).toEqual(['ads.example.com', 'multi.example.com'])
    expect(r.tld).toEqual(['top'])
    expect(r.allowed).toEqual(['ok.example.com'])
    expect(r.skipped).toBe(1)
  })

  it('разбирает hosts-формат с комментариями', () => {
    const text = [
      '# Title',
      '0.0.0.0 ads1.example.com',
      '127.0.0.1 ads2.example.com # inline comment',
      '::1 ipv6.example.com',
      '10.0.0.1 not-blocked.example.com', // не блокирующий IP — пропускается
    ].join('\n')
    const r = parseDomainList(text, 'auto')
    expect(r.format).toBe('hosts')
    expect(r.blocked).toEqual(['ads1.example.com', 'ads2.example.com', 'ipv6.example.com'])
    expect(r.skipped).toBe(1)
  })

  it('разбирает простой список (plain)', () => {
    const r = parseDomainList('a.example.com\nb.example.com,\n#c\n\n垃圾.example', 'plain')
    expect(r.blocked).toEqual(['a.example.com', 'b.example.com'])
    expect(r.skipped).toBe(1) // только 垃圾.example (#c — комментарий, не skipped)
  })
})

describe('dns: mergeDomainSources', () => {
  const src = (
    name: string,
    priority: number,
    domains: string[],
    purpose: 'block' | 'allow' = 'block',
    category = 'ads',
  ) => ({
    id: name, name, purpose: purpose as 'block' | 'allow', priority, category, enabled: true,
    entries: domains.map((d) => [d, 'block' as const] as [string, 'block']),
  })

  it('дубликат достаётся источнику с меньшим приоритетом, проигравшие считаются', async () => {
    const { domains, stats } = await mergeDomainSources([
      src('high', 50, ['dup.example.com', 'only-high.example.com']),
      src('low', 10, ['dup.example.com', 'only-low.example.com']),
    ])
    // сортировка лексикографическая: dup < only-high < only-low
    expect(domains).toEqual(['dup.example.com', 'only-high.example.com', 'only-low.example.com'])
    expect(stats.duplicateByDomain).toBe(1)
    expect(stats.perSource['high'].droppedDuplicate).toBe(1)
    expect(stats.perSource['low'].kept).toBe(2)
    expect(stats.duplicateDomains).toContainEqual({ domain: 'dup.example.com', count: 2 })
  })

  it('allow-источник исключает домен даже из более приоритетного блок-источника', async () => {
    const { domains, stats } = await mergeDomainSources([
      src('block', 10, ['good.example.com', 'bad.example.com']),
      src('allow', 90, ['good.example.com'], 'allow'),
    ])
    expect(domains).toEqual(['bad.example.com'])
    expect(stats.allowedRemoved).toBeGreaterThanOrEqual(1)
  })

  it('allow-строка (@@) внутри блок-источника применяется после сбора', async () => {
    const s = {
      id: 's', name: 's', purpose: 'block' as const, priority: 10, category: 'ads', enabled: true,
      entries: [
        ['good.example.com', 'block' as const],
        ['good.example.com', 'allow' as const],
        ['bad.example.com', 'block' as const],
      ] as Array<[string, 'block' | 'allow']>,
    }
    const { domains } = await mergeDomainSources([s])
    expect(domains).toEqual(['bad.example.com'])
  })

  it('выключенная категория убирает домены источника', async () => {
    const { domains, stats } = await mergeDomainSources([
      src('ads', 10, ['a.example.com']),
      src('mal', 20, ['b.example.com'], 'block', 'malware'),
    ], { disabledCategories: new Set(['ads']) })
    expect(domains).toEqual(['b.example.com'])
    expect(stats.categoryRemoved).toBe(1)
  })

  it('DomainOverride: enabled=false исключает, force=true возвращает поверх белого списка', async () => {
    const base = [src('s1', 10, ['x.example.com', 'y.example.com']), src('allow', 90, ['y.example.com'], 'allow')]
    // x выключен вручную; y в белом списке → итог пуст
    const off = await mergeDomainSources(base, { disabledDomains: new Set(['x.example.com']) })
    expect(off.domains).toEqual([])
    expect(off.stats.overrideRemoved).toBe(1)
    // force=true возвращает y в сборку поверх белого списка
    const force = await mergeDomainSources(base, { forcedDomains: new Set(['y.example.com']) })
    expect(force.domains.sort()).toEqual(['x.example.com', 'y.example.com'])
    expect(force.stats.forcedBlock).toBe(1)
  })
})

describe('dns: renderDomainFile', () => {
  it('рендерит все четыре формата', () => {
    const meta = { generatedAt: new Date('2026-01-01T00:00:00Z'), sources: ['s'], stats: { duplicateByDomain: 1 } }
    const plain = renderDomainFile(['a.com'], [], 'plain', meta)
    expect(plain).toContain('# Blocked domains')
    expect(plain).toContain('\na.com')
    expect(renderDomainFile(['a.com'], [], 'hosts', meta)).toContain('0.0.0.0 a.com')
    expect(renderDomainFile(['a.com'], [], 'dnsmasq', meta)).toContain('address=/a.com/')
    expect(renderDomainFile(['a.com'], [], 'adblock', meta)).toContain('||a.com^')
  })
})

describe('dns-import: потоковый парсер SQL-дампа', () => {
  it('извлекает категории, домены (тип 1) и их категории; прочие типы считаются', async () => {
    const sql = [
      "-- Дамп",
      "INSERT INTO `category` (`id`, `number`, `name`, `name_eng`, `description`) VALUES",
      "\t(1, 1, 'Фишинг', 'Phishing', 'desc'),",
      "\t(2, 2, 'Малварь', 'Malware', 'desc');",
      "INSERT INTO `resource` (`id`, `name`, `create_time`, `parent_id`, `rating_id`, `resource_type_id`, `source_id`, `comment`, `domain_registered_date`, `cat_quality`) VALUES",
      "\t(10, 'phish.example.com', '2026-01-01 00:00:00.000000', NULL, NULL, 1, 13, 'note', NULL, 4),",
      "\t(11, 'URL http://bad.example/x', '2026-01-01 00:00:00.000000', NULL, NULL, 2, 13, 'note', NULL, NULL),",
      "\t(12, '1.2.3.4', '2026-01-01 00:00:00.000000', NULL, NULL, 3, 10, 'note', NULL, NULL);",
      "INSERT INTO `resource_has_category` (`id`, `approved`, `category_id`, `resource_id`) VALUES",
      "\t(100, 1, 1, 10),",
      "\t(101, 1, 2, 10),",
      "\t(102, 0, 2, 10),",
      "\t(103, 1, 2, 11);",
    ].join('\n')
    // пишем временный файл и парсим потоково (как в проде)
    const { promises: fs } = await import('fs')
    const path = await import('path')
    const os = await import('os')
    const tmp = path.join(os.tmpdir(), `dns-dump-test-${Date.now()}.sql`)
    await fs.writeFile(tmp, sql, 'utf8')
    const cats: Array<{ id: number; name: string; nameEng: string }> = []
    const domains: Array<{ id: number; domain: string; sourceId: number; categoryIds: number[] }> = []
    const stats = await parseDumpFile(tmp, {
      onCategories: async (c) => { cats.push(...c) },
      onDomains: async (d) => { domains.push(...d) },
    })
    await fs.unlink(tmp).catch(() => undefined)

    expect(cats.map((c) => c.nameEng)).toEqual(['Phishing', 'Malware'])
    expect(stats.otherTypes).toBe(2) // URL + IP
    expect(domains).toEqual([{ id: 10, domain: 'phish.example.com', sourceId: 13, categoryIds: [1, 2] }])
    expect(stats.invalidDomains).toBe(0)
    expect(stats.linksWithoutDomain).toBe(1) // ссылка на URL-ресурс
  })

  it('имя категории ifaro стабильно и содержит номер', () => {
    const name = dumpCategoryName({ number: 34, nameEng: 'Phishing' })
    expect(name).toBe('ifaro:34:Phishing')
    expect(dumpCategoryName({ number: 34, nameEng: 'Phishing' })).toBe(name)
  })
})

describe('tokens: scope', () => {
  it('нормализует scope: rules (дефолт) | domains | both', () => {
    expect(normalizeTokenScope(undefined)).toBe('rules')
    expect(normalizeTokenScope('rules')).toBe('rules')
    expect(normalizeTokenScope('domains')).toBe('domains')
    expect(normalizeTokenScope('both')).toBe('both')
    expect(normalizeTokenScope('hack')).toBe('rules')
  })
})
