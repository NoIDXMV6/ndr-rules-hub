// ─────────────────────────────────────────────────────────────────────────────
// Импорт SQL-дампа базы фильтрации нежелательных ресурсов (формат HeidiSQL/
// MariaDB: export.sql с INSERT INTO `category`/`resource`/`resource_has_category`).
// Потоковый разбор построчно: строки INSERT гигантские (миллионы), весь дамп
// в память не помещается. Парсер чистый (только текст → события), запись в БД
// — в dns-service.ts (importDomainDump).
//
// Схема дампа:
//   category(id, number, name, name_eng, description)              ~151 строка
//   resource(id, name, create_time, parent_id, rating_id,
//            resource_type_id, source_id, comment, …)              ~2,85 млн
//   resource_has_category(id, approved, category_id, resource_id)  ~2,64 млн
//   resource_type(id, name) — 1=Domain name, 2=URL, 3=IP, 4=CIDR, 5=Regex, 6=Phrase
//   source(id, name, description) — внутренние источники базы
//
// Судьба типов при импорте:
//   Domain name → DNS-список (DomainRecord с категориями дампа);
//   URL         → хост (доменная часть) в DNS-список + HTTP-правило NDR целиком;
//   IP / CIDR   → IP-правила NDR (чанками по 500 адресов, SID 1 200 000+);
//   Regex       → pcre-правила NDR на http.uri.raw (SID 1 400 000+);
//   Phrase      → правила NDR по содержимому ответа http.response_body (SID 1 500 000+).
// NDR-правила пишутся в .rules-файлы и регистрируются ВЫКЛЮЧЕННЫМИ источниками
// («Дамп фильтрации: …») — админ включает их осознанно в «Правилах → Источниках».
// ─────────────────────────────────────────────────────────────────────────────
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { convertIpList, convertUrlList, type ConvertedRule } from './convert'

export interface DumpCategory {
  id: number
  number: number
  name: string
  nameEng: string
}

export interface DumpDomain {
  id: number
  domain: string
  sourceId: number
  categoryIds: number[]
  /** запись получена из URL-ресурса (доменная часть URL) */
  fromUrl?: boolean
}

export type DumpIndicatorKind = 'ip' | 'cidr' | 'url' | 'regex' | 'phrase'
export interface DumpIndicator {
  kind: DumpIndicatorKind
  value: string
}

export interface DumpParseStats {
  lines: number
  categories: number
  resources: number
  domains: number
  otherTypes: number
  /** ресурс типа URL (2) */
  urlCount: number
  /** ресурс типа IP (3) */
  ipCount: number
  /** ресурс типа CIDR (4) */
  cidrCount: number
  /** ресурс типа Regex (5) */
  regexCount: number
  /** ресурс типа Phrase (6) */
  phraseCount: number
  categoryLinks: number
  linksWithoutDomain: number
  invalidDomains: number
  byDumpSource: Record<number, number>
}

export interface DumpParseEvents {
  onCategories?: (cats: DumpCategory[]) => Promise<void> | void
  /** батч доменов (категории уже присоединены после полного прогона rhc);
   *  включает и хосты URL-ресурсов (fromUrl) */
  onDomains?: (batch: DumpDomain[]) => Promise<void> | void
  /** батч индикаторов других типов (IP/CIDR/URL/Regex/Phrase) — без категорий,
   *  вылетает сразу при разборе resource-строк */
  onIndicators?: (batch: DumpIndicator[]) => Promise<void> | void
  onProgress?: (stats: DumpParseStats) => void
  /** каждые N строк — колбэк прогресса (по умолчанию 200_000) */
  progressEvery?: number
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\.[a-z]{2,24}$/
const TYPE_DOMAIN = 1
const TYPE_URL = 2
const TYPE_IP = 3
const TYPE_CIDR = 4
const TYPE_REGEX = 5
const TYPE_PHRASE = 6

const RE_CATEGORY = /^\t\((\d+), (\d+), '((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'(?:, '((?:[^'\\]|\\.)*')|, NULL)?\)[,;]\s*$/
const RE_RESOURCE = /^\t\((\d+), '((?:[^'\\]|\\.)*)', '(?:[^'\\]|\\.)*'(?:, NULL|\d+)?(?:, NULL|\d+)?, (\d+), (\d+),/
const RE_RHC = /^\t\((\d+), (\d+), (\d+), (\d+)\)[,;]\s*$/

function unescapeSql(s: string): string {
  return s.replace(/\\'/g, "'").replace(/\\n/g, ' ').replace(/\\\\/g, '\\')
}

function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase()
  while (d.endsWith('.')) d = d.slice(0, -1)
  return d
}

// ── Валидация индикаторов дампа (экспортированы для тестов) ──────────────────

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** Приватные/служебные диапазоны в правилах NDR не имеют смысла */
export function isPrivateIp(ip: string): boolean {
  const o = ip.split('.').map((x) => parseInt(x, 10))
  if (o.length !== 4 || o.some((n) => !Number.isFinite(n))) return true
  const [a, b] = o
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true // 0/8, 10/8, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 192 && b === 0) return true // 192.0.0/24, 192.0.2/24 (doc)
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark
  if (a === 255) return true
  return false
}

/** IP-индикатор дампа: корректный IPv4 вне приватных диапазонов */
export function isValidDumpIp(v: string): boolean {
  const t = v.trim()
  return IPV4_RE.test(t) && !isPrivateIp(t)
}

/** CIDR-индикатор дампа: корректный IPv4/префикс (0..32) вне приватных диапазонов */
export function isValidDumpCidr(v: string): boolean {
  const t = v.trim()
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(t)
  if (!m) return false
  const prefix = parseInt(m[2], 10)
  if (prefix > 32) return false
  if (!IPV4_RE.test(m[1])) return false
  return !isPrivateIp(m[1])
}

/** URL-индикатор дампа → { host, url } или null, если хост не похож на домен */
export function normalizeDumpUrl(raw: string): { host: string; url: string } | null {
  let u = raw.trim()
  if (!u || /\s/.test(u)) return null
  u = u.toLowerCase()
  if (!/^(?:https?:\/\/)?[a-z0-9][a-z0-9.-]*(?::\d{2,5})?(?:\/|$)/.test(u)) return null
  if (!u.includes('/') && !u.includes('.')) return null
  const host = normalizeDomain(u.replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, ''))
  if (!DOMAIN_RE.test(host)) return null
  return { host, url: u.startsWith('http') ? u : `http://${u}` }
}

/** Regex-индикатор дампа: не слишком длинный, компилируется и не слишком широкий
 *  (одновременно матчит три заведомо «хороших» имени — значит, это .*-подобное) */
export function isValidDumpRegex(v: string): boolean {
  const t = v.trim()
  if (!t || t.length > 200) return false
  // PCRE-совместимость проверяем приближённо: JS RegExp понимает большинство конструкций
  try {
    const re = new RegExp(t)
    // слишком широкий шаблон («.*», «.+» без якорей) не годится для правила
    const benign = ['example.com', 'microsoft.com', 'sberbank.ru']
    if (benign.every((b) => re.test(b))) return false
    return true
  } catch {
    return false
  }
}

/** Phrase-индикатор дампа: осмысленная фраза 3..120 символов с буквами/цифрами */
export function isValidDumpPhrase(v: string): boolean {
  const t = v.trim()
  if (t.length < 3 || t.length > 120) return false
  if (/[\x00-\x08\x0b-\x1f"]/.test(t)) return false // кавычка уйдёт в content-строку
  if (!/[\p{L}\p{N}]/u.test(t)) return false // только пунктуация — не фраза
  return true
}

/** Экранирование значения для content:"…" в правиле Suricata */
function escapeRuleContent(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Экранирование PCRE-шаблона для pcre:"/…/i": только разделитель и кавычка;
 *  бэкслэши не трогаем — это синтаксис самого регулярного выражения (\. , \d и т.п.) */
function escapeRulePcre(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\//g, '\\/')
}

/** Сократить msg-значение до безопасной длины без разрыва многобайтовых символов */
function msgTail(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if ([...out].length + 1 > max) break
    out += ch
  }
  return out
}

// ── Генераторы правил NDR из индикаторов дампа ───────────────────────────────

/** IP/CIDR → IP-правила чанками (convertIpList); SID-блок 1 200 000+;
 *  metadata дампа — dump-ifaro (конвертер шлёт converted-feed) */
export function generateDumpIpRules(entries: string[]): ConvertedRule[] {
  return convertIpList(entries.join('\n'), {
    sidStart: 1_200_000,
    action: 'drop',
    proto: 'ip',
    msgPrefix: 'DUMP-IFARO known unwanted IP/CIDR',
    perRule: 500,
    maxRules: 200_000,
    classtype: 'policy-violation',
  }).map((r) => ({ ...r, raw: r.raw.replace('metadata:ruleset converted-feed', 'metadata:ruleset dump-ifaro') }))
}

/** URL → HTTP-правила (host+uri); SID-блок 1 300 000+.
 *  URL без пути (после схемы) получает «/» — convertUrlList иначе пропускает
 *  такие строки; metadata дампа — dump-ifaro (конвертер шлёт converted-feed). */
export function generateDumpUrlRules(entries: string[]): ConvertedRule[] {
  const normalized = entries.map((u) => {
    const rest = u.replace(/^https?:\/\//i, '')
    return rest.includes('/') ? u : `${u}/`
  })
  return convertUrlList(normalized.join('\n'), {
    sidStart: 1_300_000,
    action: 'drop',
    msgPrefix: 'DUMP-IFARO known unwanted URL',
    maxRules: 100_000,
    classtype: 'policy-violation',
  }).map((r) => ({ ...r, raw: r.raw.replace('metadata:ruleset converted-feed', 'metadata:ruleset dump-ifaro') }))
}

/** Regex → pcre-правила на http.uri.raw; SID-блок 1 400 000+ */
export function generateDumpRegexRules(patterns: string[]): ConvertedRule[] {
  const rules: ConvertedRule[] = []
  let sid = 1_400_000
  for (const p of patterns) {
    if (rules.length >= 20_000) break
    const raw =
      `drop http $HOME_NET any -> $EXTERNAL_NET any ` +
      `(msg:"DUMP-IFARO unwanted URL pattern (regex)"; flow:to_server,established; http.uri.raw; pcre:"/${escapeRulePcre(p)}/i"; classtype:policy-violation; metadata:ruleset dump-ifaro; sid:${sid}; rev:1;)`
    rules.push({ sid, rev: 1, raw, suricataOk: true, compatNotes: null })
    sid++
  }
  return rules
}

/** Phrase → правила по содержимому ответа (http.response_body); SID-блок 1 500 000+ */
export function generateDumpPhraseRules(phrases: string[]): ConvertedRule[] {
  const rules: ConvertedRule[] = []
  let sid = 1_500_000
  for (const p of phrases) {
    if (rules.length >= 20_000) break
    const raw =
      `drop http $HOME_NET any -> $EXTERNAL_NET any ` +
      `(msg:"DUMP-IFARO unwanted page phrase: ${msgTail(escapeRuleContent(p), 40)}"; flow:to_server,established; http.response_body; content:"${escapeRuleContent(p)}"; nocase; classtype:policy-violation; metadata:ruleset dump-ifaro; sid:${sid}; rev:1;)`
    rules.push({ sid, rev: 1, raw, suricataOk: true, compatNotes: null })
    sid++
  }
  return rules
}

/** Шапка сгенерированного .rules-файла (аналог рендера итогового файла) */
export function dumpRulesHeader(kind: DumpIndicatorKind, ruleCount: number, entryCount: number, sidStart: number): string {
  const kindLabel = kind === 'ip' ? 'IP/CIDR → IP-правила' : kind === 'url' ? 'URL → HTTP-правила' : kind === 'regex' ? 'Regex → pcre-правила (http.uri.raw)' : 'Phrase → правила по содержимому ответа (http.response_body)'
  const kindLabelEn = kind === 'ip' ? 'IP/CIDR → IP rules' : kind === 'url' ? 'URL → HTTP rules' : kind === 'regex' ? 'Regex → pcre rules (http.uri.raw)' : 'Phrase → response-body content rules'
  const gen = new Date().toISOString()
  return [
    '# ─────────────────────────────────────────────────────────────',
    `# Дамп фильтрации нежелательных ресурсов — ${kindLabel}`,
    `# Unwanted-resource filtering dump — ${kindLabelEn}`,
    `# Сгенерировано при импорте базы / Generated on import: ${gen}`,
    `# Правил / Rules: ${ruleCount} (индикаторов / indicators: ${entryCount}), SID ${sidStart}+`,
    '# Источник создан выключенным — включите его в «Правилах → Источниках».',
    '# The source is created disabled — enable it under "Rules → Sources".',
    '# ─────────────────────────────────────────────────────────────',
    '',
  ].join('\n')
}

type Mode = null | 'category' | 'resource' | 'rhc'

/**
 * Разобрать файл дампа. Ресурс-строки и rhc-строки идут в файле РАЗДЕЛЬНО
 * (сначала все resource, потом resource_has_category), поэтому категории
 * присоединяются вторым накопителем: парсер держит в памяти только
 * domain-id/URL-id (Map<number, …>) и их категории — ~2,2 млн int-ключей.
 * Индикаторы других типов (IP/CIDR/URL/Regex/Phrase) не требуют категорий —
 * уходят батчами сразу из onIndicators.
 */
export async function parseDumpFile(filePath: string, events: DumpParseEvents): Promise<DumpParseStats> {
  const stats: DumpParseStats = {
    lines: 0, categories: 0, resources: 0, domains: 0, otherTypes: 0,
    urlCount: 0, ipCount: 0, cidrCount: 0, regexCount: 0, phraseCount: 0,
    categoryLinks: 0, linksWithoutDomain: 0, invalidDomains: 0, byDumpSource: {},
  }
  const progressEvery = events.progressEvery ?? 200_000

  // id ресурса → [домен|URL, sourceId]; домены — тип 1, URL — тип 2 (для хостов)
  const domainRows = new Map<number, { domain: string; sourceId: number }>()
  const urlRows = new Map<number, { host: string; sourceId: number }>()
  // id ресурса → ids категорий (домены и URL — оба попадают в DNS)
  const catByResource = new Map<number, number[]>()

  let mode: Mode = null
  let catBatch: DumpCategory[] = []
  let indBatch: DumpIndicator[] = []
  let lastProgress = 0

  const flushIndicators = async () => {
    if (indBatch.length) {
      const batch = indBatch
      indBatch = []
      await events.onIndicators?.(batch)
    }
  }
  /** накапливать индикаторы; флаш — await-ом в основном цикле (порядок батчей гарантирован) */
  const pushIndicator = (kind: DumpIndicatorKind, value: string) => {
    indBatch.push({ kind, value })
  }

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    stats.lines++
    if (stats.lines - lastProgress >= progressEvery) {
      lastProgress = stats.lines
      events.onProgress?.(stats)
    }
    if (line.startsWith('INSERT INTO')) {
      // флаш батчей категорий при смене секции
      if (mode === 'category' && catBatch.length) {
        await events.onCategories?.(catBatch)
        catBatch = []
      }
      if (line.includes('`resource_has_category`')) mode = 'rhc'
      else if (line.includes('`resource`')) mode = 'resource'
      else if (line.includes('`category`')) mode = 'category'
      else mode = null
      continue
    }
    if (mode === null || !line.startsWith('\t(')) continue

    if (mode === 'category') {
      const m = RE_CATEGORY.exec(line)
      if (m) {
        const row: DumpCategory = {
          id: parseInt(m[1], 10),
          number: parseInt(m[2], 10),
          name: unescapeSql(m[3]),
          nameEng: m[4] ? unescapeSql(m[4]) : `cat${m[1]}`,
        }
        catBatch.push(row)
        stats.categories++
        if (catBatch.length >= 200) {
          await events.onCategories?.(catBatch)
          catBatch = []
        }
      }
      continue
    }

    if (mode === 'resource') {
      const m = RE_RESOURCE.exec(line)
      if (!m) continue
      stats.resources++
      const rtype = parseInt(m[3], 10)
      const srcId = parseInt(m[4], 10)
      stats.byDumpSource[srcId] = (stats.byDumpSource[srcId] ?? 0) + 1
      const value = unescapeSql(m[2])
      if (rtype === TYPE_DOMAIN) {
        const domain = normalizeDomain(value)
        if (!DOMAIN_RE.test(domain)) { stats.invalidDomains++; continue }
        domainRows.set(parseInt(m[1], 10), { domain, sourceId: srcId })
        stats.domains++
        continue
      }
      if (rtype === TYPE_URL) {
        stats.urlCount++
        const parsed = normalizeDumpUrl(value)
        if (!parsed) { stats.otherTypes++; continue }
        urlRows.set(parseInt(m[1], 10), { host: parsed.host, sourceId: srcId })
        pushIndicator('url', parsed.url)
        continue
      }
      if (rtype === TYPE_IP) {
        stats.ipCount++
        const v = value.trim()
        if (isValidDumpIp(v)) pushIndicator('ip', v)
        continue
      }
      if (rtype === TYPE_CIDR) {
        stats.cidrCount++
        const v = value.trim()
        if (isValidDumpCidr(v)) pushIndicator('cidr', v)
        continue
      }
      if (rtype === TYPE_REGEX) {
        stats.regexCount++
        const v = value.trim()
        if (isValidDumpRegex(v)) pushIndicator('regex', v)
        continue
      }
      if (rtype === TYPE_PHRASE) {
        stats.phraseCount++
        const v = value.trim()
        if (isValidDumpPhrase(v)) pushIndicator('phrase', v)
        continue
      }
      stats.otherTypes++
      continue
    }
    // батч индикаторов заполнился — отдаём синхронно по порядку (await в цикле)
    if (indBatch.length >= 2000) await flushIndicators()

    if (mode === 'rhc') {
      const m = RE_RHC.exec(line)
      if (!m) continue
      const approved = parseInt(m[2], 10)
      const catId = parseInt(m[3], 10)
      const resId = parseInt(m[4], 10)
      if (approved !== 1) continue
      if (!domainRows.has(resId) && !urlRows.has(resId)) { stats.linksWithoutDomain++; continue }
      stats.categoryLinks++
      const arr = catByResource.get(resId)
      if (arr) { if (!arr.includes(catId)) arr.push(catId) }
      else catByResource.set(resId, [catId])
      continue
    }
  }
  if (catBatch.length) await events.onCategories?.(catBatch)
  await flushIndicators()

  // финальный батч: домены + хосты URL с категориями — потоково в колбэк
  const onDomains = events.onDomains
  if (onDomains) {
    const BATCH = 5000
    let batch: DumpDomain[] = []
    const emit = (rid: number, domain: string, sourceId: number, fromUrl: boolean): Promise<void> | null => {
      const rec: DumpDomain = { id: rid, domain, sourceId, categoryIds: catByResource.get(rid) ?? [] }
      if (fromUrl) rec.fromUrl = true
      batch.push(rec)
      if (batch.length >= BATCH) {
        const chunk = batch
        batch = []
        return Promise.resolve(onDomains(chunk))
      }
      return null
    }
    for (const [rid, row] of domainRows) await emit(rid, row.domain, row.sourceId, false)
    for (const [rid, row] of urlRows) await emit(rid, row.host, row.sourceId, true)
    if (batch.length) await onDomains(batch)
  }
  events.onProgress?.(stats)
  return stats
}

/** Имя категории DNS-модуля для категории дампа (стабильное, уникальное) */
export function dumpCategoryName(cat: { number: number; nameEng: string }): string {
  const eng = cat.nameEng.replace(/[^\w&+ -]/g, '').trim() || `cat${cat.number}`
  return `ifaro:${cat.number}:${eng}`.slice(0, 120)
}
