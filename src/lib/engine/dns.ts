// ─────────────────────────────────────────────────────────────────────────────
// Ядро DNS-фильтрации: разбор хостлистов, слияние источников, рендер файла.
// Идеология аналогична build.ts (правила NDR), но записи — домены:
//   parseDomainList   — разбор форматов adguard / hosts / plain (auto);
//   mergeDomainSources — слияние включённых источников: блок-источники по
//                        приоритету, allow-источники исключают домены,
//                        дубликаты учитываются в статистике;
//   renderDomainFile   — итоговый файл: plain | hosts | dnsmasq | adblock.
// Чистые функции без БД — покрываются unit-тестами (tests/dns.test.ts).
// ─────────────────────────────────────────────────────────────────────────────
import { yieldToLoop } from './loop'

export type DomainListFormat = 'adguard' | 'hosts' | 'plain' | 'auto'
export type DomainExportFormat = 'plain' | 'hosts' | 'dnsmasq' | 'adblock'

export interface ParsedDomainList {
  /** домены на блокирование (как в списке, нижний регистр) */
  blocked: string[]
  /** домены-исключения (@@||d^ — allowlist строки adguard) */
  allowed: string[]
  /** одно-меточные записи ||tld^ — блокировка целого TLD */
  tld: string[]
  /** строк, не похожих на домен (кроме комментариев) */
  skipped: number
  /** определённый формат */
  format: Exclude<DomainListFormat, 'auto'>
  /** строк всего (без комментариев/пустых) */
  total: number
  /** строки-не-домены (IP/CIDR/URL/regex) — при opts.collectOthers (конвертация в правила NDR) */
  others: string[]
  /** всего строк-не-доменов (включая те, что не поместились в others из-за cap) */
  othersTotal: number
}

export interface ParseDomainListOptions {
  /** собирать строки-не-домены (IP/CIDR/URL/regex) в result.others — для конвертации в правила Suricata */
  collectOthers?: boolean
  /** предохранитель памяти: максимум собранных строк (остальные только считаются) */
  maxOthers?: number
}

const DOMAIN_LINE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\.[a-z]{2,24}$/
/** одно-меточные записи (TLD): ||top^, ||zip^ — только буквы, 2..24 символа */
const TLD_LINE = /^[a-z]{2,24}$/
const AG_BLOCK = /^\|\|([a-z0-9._-]+?)\^(?:\$[^]*)?$/
const AG_EXCEPTION = /^@@\|\|([a-z0-9._-]+?)\^(?:\$[^]*)?$/
const HOSTS_BLOCK = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1|fe80::1%lo0)\s+([a-z0-9._-]+)/
/** строчный комментарий: #, !, [заголовок], // ; hosts: # в середине строки срезается */
const LINE_COMMENT = /^(?:!|\[|\/\/|#)/

/** Канонизация домена: нижний регистр, без завершающей точки, punycode-ASCII не трогаем */
export function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase()
  // hosts-строки иногда содержат пути/порты — отсекаем по первому пробелу (уже срезано) и '/'
  const slash = d.indexOf('/')
  if (slash > 0) d = d.slice(0, slash)
  while (d.endsWith('.')) d = d.slice(0, -1)
  return d
}

/** Похожа ли строка на домен (после канонизации) — домен ИЛИ одно-метка TLD */
export function isDomainLike(d: string): boolean {
  if (!d || d.length > 253) return false
  return DOMAIN_LINE.test(d) || (TLD_LINE.test(d) && !['localhost', 'local', 'localhost.localdomain'].includes(d))
}

/**
 * Разобрать текст хостлиста. Форматы:
 *  • adguard — `||domain^`, исключения `@@||domain^`, TLD `||top^`, `! комментарий`;
 *  • hosts   — `0.0.0.0 domain`, `127.0.0.1 domain`, `# комментарий`;
 *  • plain   — домен в строке (остальное — пропуск с счётчиком skipped).
 * auto: adguard, если есть ||…^; hosts, если есть 0.0.0.0/127.0.0.1; иначе plain.
 */
export function parseDomainList(text: string, format: DomainListFormat = 'auto', opts: ParseDomainListOptions = {}): ParsedDomainList {
  const blocked: string[] = []
  const allowed: string[] = []
  const tld: string[] = []
  const seen = new Set<string>()
  const others: string[] = []
  const maxOthers = opts.maxOthers ?? 100_000
  let othersTotal = 0
  let skipped = 0
  let total = 0
  let agHits = 0
  let hostsHits = 0
  /** строка не похожа на домен — в others (конвертация) или в skipped */
  const notDomain = (raw: string): void => {
    skipped++
    if (opts.collectOthers) {
      othersTotal++
      if (others.length < maxOthers) others.push(raw)
    }
  }

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line) continue
    // hosts: «0.0.0.0 d # comment» — срезаем хвостовой комментарий, agguard: «||d^ $important» уже в regex
    const hash = line.indexOf(' #')
    if (hash > 0) line = line.slice(0, hash).trim()
    if (LINE_COMMENT.test(line)) continue
    total++

    if (format === 'auto' || format === 'adguard') {
      const ex = AG_EXCEPTION.exec(line)
      if (ex) {
        const d = normalizeDomain(ex[1])
        if (isDomainLike(d) && !seen.has(d)) { seen.add(d); allowed.push(d) }
        continue
      }
      const m = AG_BLOCK.exec(line)
      if (m) {
        agHits++
        const d = normalizeDomain(m[1])
        if (isDomainLike(d) && !seen.has(d)) {
          seen.add(d)
          if (d.includes('.')) blocked.push(d)
          else tld.push(d)
        }
        continue
      }
      if (format === 'adguard') { notDomain(line); continue }
    }

    if (format === 'auto' || format === 'hosts') {
      const h = HOSTS_BLOCK.exec(line)
      if (h) {
        hostsHits++
        const d = normalizeDomain(h[1])
        if (isDomainLike(d) && !seen.has(d)) { seen.add(d); blocked.push(d) }
        continue
      }
      if (format === 'hosts') { notDomain(line); continue }
    }

    // plain: домен в строке (первое слово; хвосты вида «,5» и порты уже срезаны)
    const first = line.split(/[\s,;]+/)[0] ?? ''
    const d = normalizeDomain(first)
    if (isDomainLike(d) && !seen.has(d)) {
      seen.add(d)
      if (d.includes('.')) blocked.push(d)
      else tld.push(d)
    } else {
      // в others идёт ВСЯ строка (regex/URL могут содержать пробелы), не только первое слово
      notDomain(line)
    }
  }

  const fmt: Exclude<DomainListFormat, 'auto'> =
    format !== 'auto' ? format : agHits >= hostsHits && agHits > 0 ? 'adguard' : hostsHits > 0 ? 'hosts' : 'plain'
  return { blocked, allowed, tld, skipped, format: fmt, total, others, othersTotal }
}

// ── Слияние источников ───────────────────────────────────────────────────────

export interface DomainSourceInput {
  id: string
  name: string
  purpose: 'block' | 'allow'
  priority: number
  /** категория источника (для записей без собственной категории) */
  category: string
  /** выключенный источник не участвует в слиянии */
  enabled: boolean
  /**
   * записи источника: [домен, mode] — синхронный или асинхронный итератор
   * (поток из курсора БД или готовый массив); mode 'allow' — исключение
   */
  entries: Iterable<[string, 'block' | 'allow']> | AsyncIterable<[string, 'block' | 'allow']>
}

export interface DomainMergeStats {
  totalInput: number
  uniqueSids: number
  duplicateByDomain: number
  allowedRemoved: number
  categoryRemoved: number
  overrideRemoved: number
  /** исключено проверкой живости (неделегированные домены, dnsAliveCheckEnabled) */
  deadRemoved: number
  forcedBlock: number
  tldCount: number
  perSource: Record<string, { total: number; kept: number; droppedDuplicate: number; droppedAllowed: number; droppedCategory: number; droppedOverride: number; droppedDead: number }>
  /** топ дублирующихся доменов (ограничен duplicateAuditCap; полный разбор — поиск по записям в UI) */
  duplicateDomains: Array<{ domain: string; count: number }>
}

export interface DomainMergeOptions {
  /** выключенные категории (name) — домены источников этих категорий не попадают в сборку */
  disabledCategories?: Set<string>
  /** домены, принудительно выключенные пользователем (DomainOverride.enabled=false) */
  disabledDomains?: Set<string>
  /** домены, принудительно ВКЛЮЧЕННЫЕ поверх белого списка (DomainOverride.enabled=true) */
  forcedDomains?: Set<string>
  /** верхняя граница аудита дубликатов */
  duplicateAuditCap?: number
  /**
   * признак жизни долгой операции (watchdog сборки): вызывается периодически
   * по мере обработки записей — сборка из миллионов доменов не считается зависшей
   */
  onHeartbeat?: (processed: number) => void
  /**
   * мёртвые (неделегированные) домены из проверки живости (DomainAlive.status='dead'):
   * блок-запись такого домена не попадает в сборку (учёт — deadRemoved/droppedDead)
   */
  deadDomains?: Set<string>
  /** начало обработки источника (лог сборки: «Слияние 3/46: «источник»…») */
  onSourceStart?: (info: { index: number; total: number; name: string; expected?: number }) => void
  /** конец обработки источника — по-источниковая строка журнала с временем и долями */
  onSourceEnd?: (info: {
    name: string
    elapsedMs: number
    total: number
    kept: number
    droppedDuplicate: number
    droppedAllowed: number
    droppedCategory: number
    droppedOverride: number
    droppedDead: number
  }) => void
}

/**
 * Слияние источников доменов (ленивое: записи поступают итератором, миллионы
 * строк не держатся в памяти):
 *  1) источники обрабатываются по возрастанию priority; записи mode='allow'
 *     (и ВСЕ записи allow-источников) пополняют белый список;
 *  2) блок-запись достаётся первому источнику — у остальных это дубликат;
 *  3) выключенная категория источника убирает его блок-записи (категории
 *     SQL-базы фильтруются ДО подачи — в dns-service, при чтении батчей);
 *  4) DomainOverride: enabled=false — исключить; enabled=true — принудительный
 *     блок поверх белого списка;
 *  5) финальный проход убирает из результата домены белого списка (исключения
 *     могут идти ПОСЛЕ блока в порядке источников).
 */
export async function mergeDomainSources(sources: DomainSourceInput[], opts: DomainMergeOptions = {}): Promise<{ domains: string[]; tld: string[]; stats: DomainMergeStats }> {
  const cap = opts.duplicateAuditCap ?? 1000
  const stats: DomainMergeStats = {
    totalInput: 0,
    uniqueSids: 0,
    duplicateByDomain: 0,
    allowedRemoved: 0,
    categoryRemoved: 0,
    overrideRemoved: 0,
    deadRemoved: 0,
    forcedBlock: 0,
    tldCount: 0,
    perSource: {},
    duplicateDomains: [],
  }
  for (const s of sources) {
    stats.perSource[s.name] = { total: 0, kept: 0, droppedDuplicate: 0, droppedAllowed: 0, droppedCategory: 0, droppedOverride: 0, droppedDead: 0 }
  }

  const allowSet = new Set<string>()
  const taken = new Set<string>()
  const takenTld = new Set<string>()
  const dupIndex = new Map<string, number>()
  const result: string[] = []
  const resultTld: string[] = []

  const ordered = sources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))

  let processedSinceYield = 0
  let sourceIndex = 0
  for (const s of ordered) {
    const per = stats.perSource[s.name]
    const disabledSrc = s.purpose === 'block' && (opts.disabledCategories?.has(s.category) ?? false)
    opts.onSourceStart?.({ index: ++sourceIndex, total: ordered.length, name: s.name })
    const tSource = Date.now()
    for await (const [d, mode] of s.entries) {
      per.total++
      stats.totalInput++
      // разрядка event loop: между батчами чтения из БД интерактивные запросы
      // (опрос прогресса, дашборд) должны обслуживаться; плюс признак жизни
      // для watchdog — сборка миллионов записей не считается зависшей
      if (++processedSinceYield >= 200_000) {
        processedSinceYield = 0
        await yieldToLoop()
      }
      // каждые 65 536 записей — обновление процента (крупный шаг 262 144
      // на медленном чтении выглядел «висящим» прогрессом на 20%)
      if ((stats.totalInput & 0xffff) === 0) opts.onHeartbeat?.(stats.totalInput)
      if (mode === 'allow' || s.purpose === 'allow') {
        allowSet.add(d)
        continue
      }
      if (allowSet.has(d) && !opts.forcedDomains?.has(d)) { per.droppedAllowed++; stats.allowedRemoved++; continue }
      if (disabledSrc) { per.droppedCategory++; stats.categoryRemoved++; continue }
      if (opts.disabledDomains?.has(d)) { per.droppedOverride++; stats.overrideRemoved++; continue }
      if (opts.deadDomains?.has(d)) { per.droppedDead++; stats.deadRemoved++; continue }
      if (d.includes('.')) {
        if (taken.has(d)) {
          per.droppedDuplicate++
          stats.duplicateByDomain++
          if (dupIndex.size < cap) dupIndex.set(d, (dupIndex.get(d) ?? 1) + 1)
          continue
        }
        taken.add(d)
        result.push(d)
      } else {
        if (takenTld.has(d)) { per.droppedDuplicate++; stats.duplicateByDomain++; continue }
        takenTld.add(d)
        resultTld.push(d)
      }
      per.kept++
    }
    opts.onSourceEnd?.({
      name: s.name,
      elapsedMs: Date.now() - tSource,
      total: per.total,
      kept: per.kept,
      droppedDuplicate: per.droppedDuplicate,
      droppedAllowed: per.droppedAllowed,
      droppedCategory: per.droppedCategory,
      droppedOverride: per.droppedOverride,
      droppedDead: per.droppedDead,
    })
  }

  // финальный проход: белый список + принудительные блоки
  const final: string[] = []
  for (const d of result) {
    if (allowSet.has(d) && !opts.forcedDomains?.has(d)) { stats.allowedRemoved++; continue }
    if (allowSet.has(d)) stats.forcedBlock++
    final.push(d)
  }
  const finalTld: string[] = []
  for (const d of resultTld) {
    if (allowSet.has(d) && !opts.forcedDomains?.has(d)) { stats.allowedRemoved++; continue }
    if (allowSet.has(d)) stats.forcedBlock++
    finalTld.push(d)
  }

  // аудит дубликатов: домены с наибольшим числом лишних вхождений
  const dupList = [...dupIndex.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, cap)

  stats.uniqueSids = final.length + finalTld.length
  stats.tldCount = finalTld.length
  stats.duplicateDomains = dupList
  // сортировка с паузами: arr.sort() на 6 млн доменов блокирует event loop
  // на секунды (опрос прогресса «зависает») — см. sortStringsYielded
  const [sortedDomains, sortedTld] = await Promise.all([sortStringsYielded(final, opts.onHeartbeat), sortStringsYielded(finalTld, opts.onHeartbeat)])
  return { domains: sortedDomains, tld: sortedTld, stats }
}

// ── Сортировка миллионов строк без блокировки event loop ────────────────────

/**
 * Сортировка больших массивов строк с паузами event loop.
 * Обычный Array.sort() на 6 млн доменов — несколько СЕКУНД полного блока:
 * Node не обслуживает запросы, опрос GET /api/dns/build/progress «зависает»,
 * UI показывает непонятный статус. Чанковая схема:
 *  1) массив режется на чанки (SORT_CHUNK), каждый сортируется отдельно —
 *     короткие синхронные куски ~десятки мс;
 *  2) чанки сливаются k-way слиянием через min-кучу (тот же порядок,
 *     что у дефолтного sort — по кодовым единицам UTF-16);
 *  3) между чанками и порциями слияния — yieldToLoop(): интерактивные
 *     запросы пробиваются между порциями работы.
 * Возвращает НОВЫЙ отсортированный массив; вход не мутируется.
 */
export const SORT_CHUNK = 100_000

export async function sortStringsYielded(input: string[], onHeartbeat?: (done: number) => void, chunkSize: number = SORT_CHUNK): Promise<string[]> {
  if (input.length <= chunkSize) {
    input.sort()
    onHeartbeat?.(input.length)
    return input
  }
  const chunks: string[][] = []
  for (let i = 0; i < input.length; i += chunkSize) {
    chunks.push(input.slice(i, i + chunkSize).sort())
    onHeartbeat?.(Math.min(input.length, i + chunkSize))
    await yieldToLoop()
  }
  // k-way слияние: min-куча пар [значение, номер чанка]
  interface HeapItem { v: string; c: number }
  const heap: HeapItem[] = []
  const push = (item: HeapItem): void => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p].v <= heap[i].v) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = (): HeapItem | undefined => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length > 0 && last) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l].v < heap[m].v) m = l
        if (r < heap.length && heap[r].v < heap[m].v) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  const pos = new Array<number>(chunks.length).fill(0)
  for (let c = 0; c < chunks.length; c++) {
    if (chunks[c].length > 0) push({ v: chunks[c][0], c })
  }
  const out: string[] = new Array(input.length)
  let n = 0
  while (heap.length > 0) {
    const min = pop()!
    out[n++] = min.v
    const next = pos[min.c] + 1
    pos[min.c] = next
    if (next < chunks[min.c].length) push({ v: chunks[min.c][next], c: min.c })
    if (n % chunkSize === 0) {
      onHeartbeat?.(n)
      await yieldToLoop()
    }
  }
  onHeartbeat?.(input.length)
  return out
}

// ── Рендер итогового файла ───────────────────────────────────────────────────

export interface DomainFileMeta {
  generatedAt?: Date
  sources?: string[]
  stats?: Partial<DomainMergeStats> & { allowedSources?: string[]; fileName?: string }
}

/**
 * Строка итогового файла для одного домена (формат отдачи).
 * Выделена отдельно: стриминговая запись сборки (dns-service) рендерит файл
 * порциями, не собирая гигантскую строку всего файла в памяти.
 */
export function domainExportLine(d: string, format: DomainExportFormat): string {
  switch (format) {
    case 'hosts': return `0.0.0.0 ${d}`
    case 'dnsmasq': return `address=/${d}/`
    case 'adblock': return `||${d}^`
    default: return d
  }
}

/** Шапка итогового файла (строки до пустой строки-разделителя) */
export function domainExportHeaderLines(format: DomainExportFormat, meta: DomainFileMeta, totalDomains: number): string[] {
  const gen = (meta.generatedAt ?? new Date()).toISOString()
  const lines: string[] = []
  lines.push('# ─────────────────────────────────────────────────────────────')
  const title = format === 'hosts' ? 'Blocked domains (hosts format)' : format === 'dnsmasq' ? 'Blocked domains (dnsmasq format)' : format === 'adblock' ? 'Blocked domains (AdGuard syntax)' : 'Blocked domains'
  lines.push(`# ${title} — NDR&DNS Rules HUB / DNS filtering`)
  lines.push(`# Сгенерировано: ${gen} / Generated: ${gen}`)
  if (meta.sources?.length) lines.push(`# Источники: ${meta.sources.join(', ')}`)
  if (meta.stats) {
    lines.push(`# Всего доменов: ${totalDomains}`)
    if (meta.stats.duplicateByDomain) lines.push(`# Дубликатов устранено: ${meta.stats.duplicateByDomain}`)
    if (meta.stats.allowedRemoved) lines.push(`# Исключено белым списком: ${meta.stats.allowedRemoved}`)
    if (meta.stats.categoryRemoved) lines.push(`# Исключено категориями: ${meta.stats.categoryRemoved}`)
    if (meta.stats.overrideRemoved) lines.push(`# Исключено вручную: ${meta.stats.overrideRemoved}`)
    if (meta.stats.tldCount) lines.push(`# TLD-записей: ${meta.stats.tldCount}`)
  }
  lines.push('# ─────────────────────────────────────────────────────────────')
  return lines
}

/** Строка-заголовок итогового файла (аналог renderFinalFile в build.ts) */
export function renderDomainFile(domains: string[], tld: string[], format: DomainExportFormat, meta: DomainFileMeta = {}): string {
  const lines = [...domainExportHeaderLines(format, meta, domains.length + tld.length), '']
  for (const d of domains) lines.push(domainExportLine(d, format))
  for (const d of tld) lines.push(domainExportLine(d, format))
  return lines.join('\n') + '\n'
}
