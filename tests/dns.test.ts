// Тесты DNS-фильтрации: разбор хостлистов, слияние источников, рендер файла,
// потоковый парсер SQL-дампа, scope токенов скачивания.
import { describe, it, expect } from 'vitest'
import {
  parseDomainList, mergeDomainSources, renderDomainFile, normalizeDomain, isDomainLike,
} from '@/lib/engine/dns'
import {
  parseDumpFile, dumpCategoryName,
  isValidDumpIp, isValidDumpCidr, normalizeDumpUrl, isValidDumpRegex, isValidDumpPhrase,
  generateDumpIpRules, generateDumpUrlRules, generateDumpRegexRules, generateDumpPhraseRules,
  dumpRulesHeader,
} from '@/lib/engine/dns-import'
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
  it('домены → DNS с категориями; URL → хост в DNS + индикатор; IP/CIDR/Regex/Phrase → индикаторы', async () => {
    const sql = [
      "-- Дамп",
      "INSERT INTO `category` (`id`, `number`, `name`, `name_eng`, `description`) VALUES",
      "\t(1, 1, 'Фишинг', 'Phishing', 'desc'),",
      "\t(2, 2, 'Малварь', 'Malware', 'desc');",
      "INSERT INTO `resource` (`id`, `name`, `create_time`, `parent_id`, `rating_id`, `resource_type_id`, `source_id`, `comment`, `domain_registered_date`, `cat_quality`) VALUES",
      "\t(10, 'phish.example.com', '2026-01-01 00:00:00.000000', NULL, NULL, 1, 13, 'note', NULL, 4),",
      "\t(11, 'http://bad.example.com/x?q=1', '2026-01-01 00:00:00.000000', NULL, NULL, 2, 13, 'note', NULL, NULL),",
      "\t(12, '1.2.3.4', '2026-01-01 00:00:00.000000', NULL, NULL, 3, 10, 'note', NULL, NULL),",
      "\t(13, '198.51.100.0/24', '2026-01-01 00:00:00.000000', NULL, NULL, 4, 10, 'note', NULL, NULL),",
      "\t(14, '10.0.0.5', '2026-01-01 00:00:00.000000', NULL, NULL, 3, 10, 'note', NULL, NULL),",
      "\t(15, 'casino[0-9]+\\.example', '2026-01-01 00:00:00.000000', NULL, NULL, 5, 10, 'note', NULL, NULL),",
      "\t(16, 'казино бесплатно', '2026-01-01 00:00:00.000000', NULL, NULL, 6, 10, 'note', NULL, NULL),",
      "\t(17, 'не домен вообще', '2026-01-01 00:00:00.000000', NULL, NULL, 2, 10, 'note', NULL, NULL);",
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
    const domains: Array<{ id: number; domain: string; sourceId: number; categoryIds: number[]; fromUrl?: boolean }> = []
    const indicators: Array<{ kind: string; value: string }> = []
    const stats = await parseDumpFile(tmp, {
      onCategories: async (c) => { cats.push(...c) },
      onDomains: async (d) => { domains.push(...d) },
      onIndicators: async (b) => { indicators.push(...b) },
    })
    await fs.unlink(tmp).catch(() => undefined)

    expect(cats.map((c) => c.nameEng)).toEqual(['Phishing', 'Malware'])
    // домен типа 1 + хост URL (тип 2); «не домен вообще» — невалидный URL → otherTypes
    expect(domains).toEqual([
      { id: 10, domain: 'phish.example.com', sourceId: 13, categoryIds: [1, 2] },
      { id: 11, domain: 'bad.example.com', sourceId: 13, categoryIds: [2], fromUrl: true },
    ])
    expect(stats.domains).toBe(1)
    expect(stats.urlCount).toBe(2)
    expect(stats.otherTypes).toBe(1) // невалидный URL
    expect(stats.ipCount).toBe(2)
    expect(stats.cidrCount).toBe(1)
    expect(stats.regexCount).toBe(1)
    expect(stats.phraseCount).toBe(1)
    // индикаторы: приватный 10.0.0.5 отброшен, URL нормализован с схемой
    expect(indicators).toContainEqual({ kind: 'ip', value: '1.2.3.4' })
    expect(indicators).toContainEqual({ kind: 'cidr', value: '198.51.100.0/24' })
    expect(indicators).toContainEqual({ kind: 'url', value: 'http://bad.example.com/x?q=1' })
    expect(indicators).toContainEqual({ kind: 'regex', value: 'casino[0-9]+\\.example' })
    expect(indicators).toContainEqual({ kind: 'phrase', value: 'казино бесплатно' })
    expect(indicators.some((i) => i.value === '10.0.0.5')).toBe(false)
    // ссылка на URL-ресурс теперь несёт категорию (не linksWithoutDomain)
    expect(stats.linksWithoutDomain).toBe(0)
    expect(stats.categoryLinks).toBe(3)
  })

  it('имя категории ifaro стабильно и содержит номер', () => {
    const name = dumpCategoryName({ number: 34, nameEng: 'Phishing' })
    expect(name).toBe('ifaro:34:Phishing')
    expect(dumpCategoryName({ number: 34, nameEng: 'Phishing' })).toBe(name)
  })
})

describe('dns-import: валидация индикаторов дампа', () => {
  it('IP: корректный IPv4; приватные/служебные диапазоны отброшены', () => {
    expect(isValidDumpIp('8.8.8.8')).toBe(true)
    expect(isValidDumpIp('203.0.113.10')).toBe(true)
    expect(isValidDumpIp('256.1.1.1')).toBe(false)
    expect(isValidDumpIp('1.2.3')).toBe(false)
    expect(isValidDumpIp('10.0.0.1')).toBe(false)
    expect(isValidDumpIp('127.0.0.1')).toBe(false)
    expect(isValidDumpIp('192.168.1.1')).toBe(false)
    expect(isValidDumpIp('172.16.0.1')).toBe(false)
    expect(isValidDumpIp('169.254.1.1')).toBe(false)
    expect(isValidDumpIp('224.0.0.1')).toBe(false)
    expect(isValidDumpIp('100.64.0.1')).toBe(false)
  })

  it('CIDR: корректный префикс 0..32 вне приватных сетей', () => {
    expect(isValidDumpCidr('198.51.100.0/24')).toBe(true)
    expect(isValidDumpCidr('203.0.113.0/8')).toBe(true)
    expect(isValidDumpCidr('10.0.0.0/8')).toBe(false)
    expect(isValidDumpCidr('192.168.0.0/16')).toBe(false)
    expect(isValidDumpCidr('1.2.3.4/33')).toBe(false)
    expect(isValidDumpCidr('1.2.3.4')).toBe(false)
  })

  it('URL: хост извлекается, схема добавляется; не-домены отброшены', () => {
    expect(normalizeDumpUrl('http://bad.example.com/x?q=1')).toEqual({ host: 'bad.example.com', url: 'http://bad.example.com/x?q=1' })
    expect(normalizeDumpUrl('bad.example.com/path')).toEqual({ host: 'bad.example.com', url: 'http://bad.example.com/path' })
    expect(normalizeDumpUrl('HTTPS://BAD.Example.COM')).toEqual({ host: 'bad.example.com', url: 'https://bad.example.com' })
    expect(normalizeDumpUrl('ftp://bad.example.com')).toBe(null) // схема ftp не URL-индикатор
    expect(normalizeDumpUrl('не домен вообще')).toBe(null)
    expect(normalizeDumpUrl('')).toBe(null)
  })

  it('Regex: компилируется и не слишком широкий; Phrase: осмысленная строка', () => {
    expect(isValidDumpRegex('casino[0-9]+\\.example')).toBe(true)
    expect(isValidDumpRegex('pharm[a-z]*\\.top')).toBe(true)
    expect(isValidDumpRegex('.*')).toBe(false) // матчит любые benign-хосты
    expect(isValidDumpRegex('(unclosed')).toBe(false) // не компилируется
    expect(isValidDumpRegex('')).toBe(false)
    expect(isValidDumpPhrase('казино бесплатно')).toBe(true)
    expect(isValidDumpPhrase('Buy cheap meds online')).toBe(true)
    expect(isValidDumpPhrase('ab')).toBe(false) // короче 3
    expect(isValidDumpPhrase('!!!')).toBe(false) // только пунктуация
    expect(isValidDumpPhrase('слово "в кавычках"')).toBe(false) // кавычка не пройдёт в content
  })
})

describe('dns-import: генераторы правил NDR из дампа', () => {
  it('IP/CIDR → drop-правила чанками, SID-блок 1 200 000+, action/proto/header', () => {
    // 1200 валидных IP: 198.51.0.1 … 198.51.4.249 (TEST-NET-2, не приватные)
    const ips = Array.from({ length: 1200 }, (_, i) => `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`)
    const rules = generateDumpIpRules(ips)
    expect(rules.length).toBe(3) // 1200 / 500 → 3 правила
    expect(rules[0].sid).toBe(1_200_000)
    expect(rules[1].sid).toBe(1_200_001)
    expect(rules[0].raw).toMatch(/^drop ip \$HOME_NET any -> \[198\.51\./)
    expect(rules[0].raw).toContain('msg:"DUMP-IFARO known unwanted IP/CIDR 500 indicator(s)"')
    expect(rules[0].raw).toContain('classtype:policy-violation;')
    expect(rules[0].raw).toContain('metadata:ruleset dump-ifaro;')
  })

  it('URL → HTTP-правила (http.host + http.uri), SID-блок 1 300 000+', () => {
    const rules = generateDumpUrlRules(['http://bad.example.com/x?q=1', 'http://other.example.com'])
    expect(rules.length).toBe(2)
    expect(rules[0].sid).toBe(1_300_000)
    expect(rules[0].raw).toContain('http.host; content:"bad.example.com";')
    expect(rules[0].raw).toContain('http.uri; content:"/x?q=1";')
    expect(rules[1].raw).toContain('http.uri; content:"/";')
    expect(rules[0].raw).toMatch(/^drop http /)
  })

  it('Regex → pcre-правила на http.uri.raw с экранированием, SID-блок 1 400 000+', () => {
    const rules = generateDumpRegexRules(['casino[0-9]+\\.example', 'a/b"c\\d+'])
    expect(rules.length).toBe(2)
    expect(rules[0].sid).toBe(1_400_000)
    // синтаксис regex (\.) не искажается — экранируются только / и "
    expect(rules[0].raw).toContain('http.uri.raw; pcre:"/casino[0-9]+\\.example/i";')
    // экранирование: / → \/, " → \"
    expect(rules[1].raw).toContain('pcre:"/a\\/b\\"c\\d+/i";')
  })

  it('Phrase → правила http.response_body с экранированием, SID-блок 1 500 000+', () => {
    const rules = generateDumpPhraseRules(['казино бесплатно', 'a\\b'])
    expect(rules.length).toBe(2)
    expect(rules[0].sid).toBe(1_500_000)
    expect(rules[0].raw).toContain('http.response_body; content:"казино бесплатно"; nocase;')
    expect(rules[1].raw).toContain('content:"a\\\\b";')
    expect(rules[0].raw).toMatch(/^drop http /)
  })

  it('шапка .rules-файла содержит число правил, SID-блок и подсказку про источник', () => {
    const h = dumpRulesHeader('ip', 3, 1200, 1_200_000)
    expect(h).toContain('# Правил / Rules: 3')
    expect(h).toContain('SID 1200000+')
    expect(h).toContain('включите его в «Правилах → Источниках»')
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

describe('dns: mergeDomainSources — живость и по-источниковые колбэки', () => {
  const src = (name: string, priority: number, entries: Array<[string, 'block' | 'allow']>) => ({
    id: name, name, purpose: 'block' as const, priority, category: 'mixed', enabled: true,
    entries,
  })

  it('deadDomains: неделегированные домены не попадают в сборку (deadRemoved/droppedDead)', async () => {
    const r = await mergeDomainSources([
      src('A', 10, [['dead1.example', 'block'], ['live1.example', 'block']]),
      src('B', 20, [['dead1.example', 'block'], ['live2.example', 'block']]),
    ], { deadDomains: new Set(['dead1.example']) })
    expect(r.domains.sort()).toEqual(['live1.example', 'live2.example'])
    // dead-домен встречается в обоих источниках: каждый учёл свой drop (dead-проверка
    // идёт до дедупликации — как у категорий/override)
    expect(r.stats.deadRemoved).toBe(2)
    expect(r.stats.perSource['A'].droppedDead).toBe(1)
    expect(r.stats.perSource['B'].droppedDead).toBe(1)
  })

  it('onSourceStart/onSourceEnd: ход слияния по источникам с временем и долями', async () => {
    const starts: Array<{ index: number; total: number; name: string }> = []
    const ends: Array<{ name: string; total: number; kept: number; droppedDuplicate: number; elapsedMs: number }> = []
    const r = await mergeDomainSources([
      src('A', 10, [['x.example', 'block'], ['dup.example', 'block']]),
      src('B', 20, [['dup.example', 'block'], ['y.example', 'block']]),
    ], {
      onSourceStart: (info) => starts.push({ ...info }),
      onSourceEnd: (info) => ends.push({ name: info.name, total: info.total, kept: info.kept, droppedDuplicate: info.droppedDuplicate, elapsedMs: info.elapsedMs }),
    })
    expect(starts.map((s) => s.name)).toEqual(['A', 'B'])
    expect(starts[0]).toMatchObject({ index: 1, total: 2 })
    expect(ends.map((e) => e.name)).toEqual(['A', 'B'])
    expect(ends[0]).toMatchObject({ total: 2, kept: 2, droppedDuplicate: 0 })
    expect(ends[1]).toMatchObject({ total: 2, kept: 1, droppedDuplicate: 1 })
    expect(r.stats.duplicateByDomain).toBe(1)
  })

  it('heartbeat: обновляется каждые 65 536 записей (гранулярный процент)', async () => {
    // 70 000 записей — должен случиться минимум один heartbeat (65 536)
    const many = Array.from({ length: 70_000 }, (_, i) => [`d${i}.example`, 'block'] as [string, 'block' | 'allow'])
    let heartbeats = 0
    await mergeDomainSources([src('A', 10, many)], { onHeartbeat: () => heartbeats++ })
    expect(heartbeats).toBeGreaterThanOrEqual(1)
  })
})

describe('dns: parseDomainList — collectOthers (строки-не-домены)', () => {
  it('собирает IP/URL/regex строки в others, счётчики честные', () => {
    const text = [
      '# comment',
      'ads.example.com',
      '93.184.216.34',
      'http://bad.example.com/x',
      '^https?://[a-z]+\\.phish\\.example',
      'не домен и не ip',
    ].join('\n')
    const r = parseDomainList(text, 'plain', { collectOthers: true })
    expect(r.blocked).toEqual(['ads.example.com'])
    expect(r.skipped).toBe(4)
    expect(r.othersTotal).toBe(4)
    expect(r.others).toEqual(['93.184.216.34', 'http://bad.example.com/x', '^https?://[a-z]+\\.phish\\.example', 'не домен и не ip'])
  })
  it('без collectOthers — others пустые (совместимость), счётчик skipped прежний', () => {
    const r = parseDomainList('93.184.216.34\nads.example.com\n', 'plain')
    expect(r.others).toEqual([])
    expect(r.othersTotal).toBe(0)
    expect(r.skipped).toBe(1)
  })
  it('maxOthers: cap памяти — лишние строки только считаются', () => {
    const text = ['93.184.216.34', '93.184.216.35', '93.184.216.36'].join('\n')
    const r = parseDomainList(text, 'plain', { collectOthers: true, maxOthers: 2 })
    expect(r.others.length).toBe(2)
    expect(r.othersTotal).toBe(3)
  })
  it('hosts-формат: «0.0.0.0 домен» не попадает в others (IP-часть — не индикатор)', () => {
    const r = parseDomainList('0.0.0.0 ads.example.com\n127.0.0.1 tracker.example.com\n', 'hosts', { collectOthers: true })
    expect(r.blocked).toEqual(['ads.example.com', 'tracker.example.com'])
    expect(r.skipped).toBe(0)
    expect(r.others).toEqual([])
  })
})
