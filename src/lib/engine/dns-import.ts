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
// В DNS-модуль попадают только ресурсы типа «Domain name»; их категории —
// списком id через запятую в DomainRecord.categories.
// ─────────────────────────────────────────────────────────────────────────────
import { createReadStream } from 'fs'
import { createInterface } from 'readline'

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
}

export interface DumpParseStats {
  lines: number
  categories: number
  resources: number
  domains: number
  otherTypes: number
  categoryLinks: number
  linksWithoutDomain: number
  invalidDomains: number
  byDumpSource: Record<number, number>
}

export interface DumpParseEvents {
  onCategories?: (cats: DumpCategory[]) => Promise<void> | void
  /** батч доменов (категории уже присоединены после полного прогона rhc) */
  onDomains?: (batch: DumpDomain[]) => Promise<void> | void
  onProgress?: (stats: DumpParseStats) => void
  /** каждые N строк — колбэк прогресса (по умолчанию 200_000) */
  progressEvery?: number
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\.[a-z]{2,24}$/
const TYPE_DOMAIN = 1

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

type Mode = null | 'category' | 'resource' | 'rhc'

/**
 * Разобрать файл дампа. Ресурс-строки и rhc-строки идут в файле РАЗДЕЛЬНО
 * (сначала все resource, потом resource_has_category), поэтому категории
 * присоединяются вторым накопителем: парсер держит в памяти только
 * domain-ids (Set<number>) и их категории — ~2,2 млн int-ключей.
 */
export async function parseDumpFile(filePath: string, events: DumpParseEvents): Promise<DumpParseStats> {
  const stats: DumpParseStats = {
    lines: 0, categories: 0, resources: 0, domains: 0, otherTypes: 0,
    categoryLinks: 0, linksWithoutDomain: 0, invalidDomains: 0, byDumpSource: {},
  }
  const progressEvery = events.progressEvery ?? 200_000

  // id категории дампa → DomainCategory name (формируется из onCategories)
  const categoryRows: DumpCategory[] = []
  // id ресурса → [домен, sourceId] — только тип Domain name
  const domainRows = new Map<number, { domain: string; sourceId: number }>()
  // id ресурса → ids категорий
  const catByResource = new Map<number, number[]>()

  let mode: Mode = null
  let catBatch: DumpCategory[] = []
  let lastProgress = 0

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
        categoryRows.push(row)
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
      if (rtype !== TYPE_DOMAIN) { stats.otherTypes++; continue }
      const domain = normalizeDomain(unescapeSql(m[2]))
      if (!DOMAIN_RE.test(domain)) { stats.invalidDomains++; continue }
      const rid = parseInt(m[1], 10)
      domainRows.set(rid, { domain, sourceId: srcId })
      stats.domains++
      continue
    }

    if (mode === 'rhc') {
      const m = RE_RHC.exec(line)
      if (!m) continue
      const approved = parseInt(m[2], 10)
      const catId = parseInt(m[3], 10)
      const resId = parseInt(m[4], 10)
      if (approved !== 1) continue
      if (!domainRows.has(resId)) { stats.linksWithoutDomain++; continue }
      stats.categoryLinks++
      const arr = catByResource.get(resId)
      if (arr) { if (!arr.includes(catId)) arr.push(catId) }
      else catByResource.set(resId, [catId])
      continue
    }
  }
  if (catBatch.length) await events.onCategories?.(catBatch)

  // финальный батч: домены с категориями — потоково в колбэк
  if (events.onDomains) {
    const BATCH = 5000
    let batch: DumpDomain[] = []
    for (const [rid, row] of domainRows) {
      batch.push({ id: rid, domain: row.domain, sourceId: row.sourceId, categoryIds: catByResource.get(rid) ?? [] })
      if (batch.length >= BATCH) {
        await events.onDomains(batch)
        batch = []
      }
    }
    if (batch.length) await events.onDomains(batch)
  }
  events.onProgress?.(stats)
  return stats
}

/** Имя категории DNS-модуля для категории дампа (стабильное, уникальное) */
export function dumpCategoryName(cat: { number: number; nameEng: string }): string {
  const eng = cat.nameEng.replace(/[^\w&+ -]/g, '').trim() || `cat${cat.number}`
  return `ifaro:${cat.number}:${eng}`.slice(0, 120)
}
