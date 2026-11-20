// ─────────────────────────────────────────────────────────────────────────────
// Сервисный слой DNS-фильтрации: источники доменных списков, импорт SQL-базы,
// сборка списка заблокированных доменов, отдача по токену.
// Идеология аналогична service.ts (правила NDR), но записи — домены.
// ─────────────────────────────────────────────────────────────────────────────
import { db, dbHeavy } from '@/lib/db'
import { createHash } from 'crypto'
import { promises as fs, createWriteStream } from 'fs'
import path from 'path'
import { DATA_DIR, EXPORTS_DIR } from './fetcher'
import { log, getSettings, fetchSourceById } from './service'
import {
  parseDomainList, mergeDomainSources,
  domainExportHeaderLines, domainExportLine,
  type DomainExportFormat, type DomainSourceInput, type DomainFileMeta,
} from './dns'
import { maybeGunzip, parseRstFeedCsv } from './rst'
import {
  parseDumpFile, dumpCategoryName,
  generateDumpIpRules, generateDumpUrlRules, generateDumpRegexRules, generateDumpPhraseRules,
  dumpRulesHeader,
} from './dns-import'
import {
  startDnsBuildProgress, setDnsBuildStage, addDnsBuildLog, touchDnsBuild,
  finishDnsBuildProgress, failDnsBuildProgress, isDnsBuildActive, getDnsBuildProgress,
} from './dns-progress'
import { yieldToLoop } from './loop'
import { domainRecordsCountCached, invalidateCounts } from './count-cache'

export const DNS_EXPORT_DIR = path.join(EXPORTS_DIR, 'domains')
export const DNS_UPLOAD_DIR = path.join(DATA_DIR, 'domains')

/** Дефолтные настройки DNS-модуля (seed кладёт в Setting при первом старте) */
export const DNS_SETTING_DEFAULTS: Record<string, string> = {
  dnsBuildFormat: 'plain', // plain | hosts | dnsmasq | adblock — формат итогового файла
  dnsFileName: 'blocked-domains.txt',
  dnsCronEnabled: 'true', // полный цикл (cron) обновляет и DNS-источники, и пересобирает список
  dnsCronSchedule: '', // отдельное расписание DNS-цикла: разнос по времени с основным циклом; пусто — сразу за основным
  // Ключ отдачи dnsServeToken удалён (v1.34.0): отдача списка — только по
  // персональному токену со scope «домены»/«оба списка» (раздел «Аккаунт»)
  // или из кабинета (сессия); без токена отдача запрещена.
}

/** Файл в каталоге экспорта DNS (карточка «Файлы» на вкладке сборки) */
export interface DnsExportFile {
  name: string
  size: number
  mtime: string
}

/** Список файлов в каталоге экспорта DNS (data/exports/domains) — зеркально PUT /api/export */
export async function listDnsExportFiles(dir: string = DNS_EXPORT_DIR): Promise<DnsExportFile[]> {
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return [] // каталога ещё нет — сборка не выполнялась
  }
  const out: DnsExportFile[] = []
  for (const f of names) {
    try {
      const st = await fs.stat(path.join(dir, f))
      if (st.isFile()) out.push({ name: f, size: st.size, mtime: st.mtime.toISOString() })
    } catch {
      /* файл исчез между readdir и stat — пропускаем */
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

export interface DomainSourceItem {
  id: string
  name: string
  url: string | null
  kind: string
  format: string
  authType: string
  extraJson: string | null
  category: string
  purpose: string
  enabled: boolean
  priority: number
  status: string
  lastFetchAt: Date | null
  lastError: string | null
  domainCount: number
  sizeBytes: number
  diffAdded: number
  diffChanged: number
  diffRemoved: number
  notes: string | null
  notesEn: string | null
  builtin: boolean
}

async function httpGet(url: string, extra: { userAgent?: string; basicUser?: string; basicPassword?: string; authKey?: string; rstApiKey?: string }): Promise<{ status: number; body: Buffer }> {
  const headers: Record<string, string> = {
    'User-Agent': extra.userAgent || 'clearndr-rules-hub/1.0 (domains updater)',
  }
  if (extra.basicUser && extra.basicPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${extra.basicUser}:${extra.basicPassword}`).toString('base64')}`
  } else if (extra.authKey) {
    headers.Authorization = extra.authKey.trim()
  }
  // RST Cloud: ключ API — заголовком X-Api-Key (у редиректа на хранилище фидов
  // заголовок снимается — pre-signed URL самодостаточен)
  if (extra.rstApiKey) headers['X-Api-Key'] = extra.rstApiKey.trim()
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000), headers })
  const body = Buffer.from(await res.arrayBuffer())
  return { status: res.status, body }
}

interface ExtraCfg {
  userAgent?: string
  basicUser?: string
  basicPassword?: string
  authKey?: string
  rstApiKey?: string
  // RST Threat Feed: пропускать записи с fp_alarm=true (сикхоул исследователей)
  skipFpAlarm?: boolean
  // RST Threat Feed: минимальный балл score_total (0..100); 0 — без фильтра
  minScore?: number
}

/** Загрузить и разобрать один доменный источник: { blocked, allowed, tld } + текст */
async function fetchDomainText(src: { id: string; name: string; kind: string; url: string | null; format: string; authType: string; extraJson: string | null }): Promise<{ ok: boolean; error?: string; text: string; sizeBytes: number }> {
  let extra: ExtraCfg = {}
  try {
    extra = src.extraJson ? (JSON.parse(src.extraJson) as ExtraCfg) : {}
  } catch { /* ignore */ }
  if (src.authType === 'rstkey' && !extra.rstApiKey) {
    // глобальный ключ подставляется в fetchDomainSourceById до вызова
    return { ok: false, error: 'не задан API-ключ RST Cloud (Настройки → Токены источников → RST Cloud)', text: '', sizeBytes: 0 }
  }
  try {
    if (src.kind === 'local' || src.kind === 'upload') {
      const p = src.url ?? ''
      const st = await fs.stat(p).catch(() => null)
      if (!st) return { ok: false, error: `локальный файл не найден: ${p}`, text: '', sizeBytes: 0 }
      const text = await fs.readFile(p, 'utf8')
      return { ok: true, text, sizeBytes: Buffer.byteLength(text) }
    }
    if (!src.url) return { ok: false, error: 'не задан URL', text: '', sizeBytes: 0 }
    const res = await httpGet(src.url, extra)
    if (res.status !== 200) {
      return { ok: false, error: `HTTP ${res.status} при загрузке ${src.url}`, text: '', sizeBytes: 0 }
    }
    // RST Threat Feed (и прочие gzip-фиды): тело — gzip-файл, распаковываем;
    // CSV-фид RST — в колонку доменов до разбора формата
    let text = maybeGunzip(res.body).toString('utf8')
    if (src.format === 'rst-csv') {
      const parsed = parseRstFeedCsv(text, 'domain', { skipFpAlarm: extra.skipFpAlarm, minScore: extra.minScore })
      text = parsed.values.join('\n')
    }
    if (/^\s*<(!doctype|html)/i.test(text)) {
      return { ok: false, error: `сервер вернул HTML-страницу вместо списка (${src.url})`, text: '', sizeBytes: res.body.length }
    }
    return { ok: true, text, sizeBytes: res.body.length }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } }
    return { ok: false, error: err.message || 'ошибка загрузки', text: '', sizeBytes: 0 }
  }
}

/** Обновить записи источника: диф по доменам (новые/удалённые), пересчёт счётчиков.
 *  dbHeavy (v1.35.0): чтение ВСЕХ прежних записей источника и массовые
 *  createMany/deleteMany идут через отдельную коннекцию — UI не блокируется. */
export async function replaceDomainRecords(sourceId: string, records: Array<{ domain: string; mode: 'block' | 'allow'; categories?: string }>): Promise<{ added: number; removed: number; total: number }> {
  const prev = await dbHeavy.domainRecord.findMany({ where: { sourceId }, select: { id: true, domain: true, mode: true, categories: true } })
  const prevMap = new Map(prev.map((r) => [r.domain, r]))
  const nextMap = new Map(records.map((r) => [r.domain, r]))
  const toCreate = records.filter((r) => {
    const p = prevMap.get(r.domain)
    return !p || p.mode !== r.mode || p.categories !== (r.categories ?? '')
  })
  const toDelete = prev.filter((r) => !nextMap.has(r.domain)).map((r) => r.id)
  const CHUNK = 5000
  for (let i = 0; i < toCreate.length; i += CHUNK) {
    await dbHeavy.domainRecord.createMany({
      data: toCreate.slice(i, i + CHUNK).map((r) => ({
        sourceId, domain: r.domain, mode: r.mode, categories: r.categories ?? '',
      })),
    })
    await yieldToLoop() // разрядка event loop: UI обслуживается между чанками
  }
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    await dbHeavy.domainRecord.deleteMany({ where: { id: { in: toDelete.slice(i, i + CHUNK) } } })
    await yieldToLoop()
  }
  // изменившиеся mode/categories — точечные апдейты (обычно их немного)
  const changed = records.filter((r) => {
    const p = prevMap.get(r.domain)
    return p && (p.mode !== r.mode || p.categories !== (r.categories ?? ''))
  })
  for (const r of changed) {
    await dbHeavy.domainRecord.updateMany({
      where: { sourceId, domain: r.domain },
      data: { mode: r.mode, categories: r.categories ?? '' },
    })
  }
  invalidateCounts() // счётчик доменных записей изменился — кэш дашборда обновится
  return { added: toCreate.length, removed: toDelete.length, total: nextMap.size }
}

/** Загрузить один доменный источник (кнопка «Обновить») */
export async function fetchDomainSourceById(sourceId: string): Promise<{ ok: boolean; count: number; error?: string; diff?: { added: number; removed: number } }> {
  const src = await db.domainSource.findUnique({ where: { id: sourceId } })
  if (!src) return { ok: false, count: 0, error: 'источник не найден' }
  if (src.deletedAt) return { ok: false, count: 0, error: 'источник в корзине' }
  if (src.kind === 'upload' && src.format === 'sql') {
    return { ok: false, count: src.domainCount, error: 'SQL-база импортируется через «Импорт базы» — повторная загрузка не требуется' }
  }
  // подстановка API-ключа RST Cloud (заголовок X-Api-Key) из «Токенов источников»:
  // ключ добавляется в extra ТОЛЬКО в памяти (в БД секрет не пишется)
  let srcForFetch = src
  if (src.authType === 'rstkey') {
    let extra: Record<string, unknown> = {}
    try {
      extra = src.extraJson ? JSON.parse(src.extraJson) : {}
    } catch { /* ignore */ }
    if (!extra.rstApiKey && (await getSettings()).rstApiKey) extra.rstApiKey = (await getSettings()).rstApiKey
    srcForFetch = { ...src, extraJson: JSON.stringify(extra) }
    if (!(extra.rstApiKey ?? '').toString().trim()) {
      await db.domainSource.update({
        where: { id: src.id },
        data: { status: 'error', lastError: 'не задан API-ключ RST Cloud', lastFetchAt: new Date() },
      })
      await log('error', 'fetch', `DNS-источник «${src.name}»: не задан API-ключ RST Cloud — введите его в «Настройки → Токены источников → RST Cloud»`, undefined, `DNS source "${src.name}": RST Cloud API key is not set — enter it under "Settings → Source tokens → RST Cloud"`)
      return { ok: false, count: 0, error: 'У источника RST Cloud не задан API-ключ — введите его в «Настройки → Токены источников → RST Cloud», либо в extra источника {"rstApiKey":"…"}' }
    }
  }

  const t0 = Date.now()
  const res = await fetchDomainText(srcForFetch)
  if (!res.ok) {
    await db.domainSource.update({
      where: { id: src.id },
      data: { status: 'error', lastError: res.error ?? 'ошибка', lastFetchAt: new Date(), sizeBytes: res.sizeBytes },
    })
    await log('error', 'fetch', `Ошибка загрузки DNS-источника «${src.name}»: ${res.error}`, undefined, `Failed to fetch DNS source "${src.name}": ${res.error}`)
    return { ok: false, count: 0, error: res.error }
  }
  const parsed = parseDomainList(res.text, src.format as never)
  const records: Array<{ domain: string; mode: 'block' | 'allow' }> = [
    ...parsed.blocked.map((d) => ({ domain: d, mode: 'block' as const })),
    ...parsed.allowed.map((d) => ({ domain: d, mode: 'allow' as const })),
    ...parsed.tld.map((d) => ({ domain: d, mode: 'block' as const })),
  ]
  const diff = await replaceDomainRecords(src.id, records)
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  await db.domainSource.update({
    where: { id: src.id },
    data: {
      status: 'ok', lastError: null, lastFetchAt: new Date(),
      domainCount: diff.total, sizeBytes: res.sizeBytes,
      diffAdded: diff.added, diffRemoved: diff.removed, diffChanged: 0,
    },
  })
  await log('ok', 'fetch', `DNS-источник «${src.name}»: ${diff.total.toLocaleString('ru-RU')} доменов (+${diff.added.toLocaleString('ru-RU')} / −${diff.removed.toLocaleString('ru-RU')}, формат ${parsed.format}, пропущено ${parsed.skipped}), ${dt} с`,
    undefined,
    `DNS source "${src.name}": ${diff.total} domains (+${diff.added} / −${diff.removed}, format ${parsed.format}, skipped ${parsed.skipped}), ${dt} s`)
  return { ok: true, count: diff.total, diff: { added: diff.added, removed: diff.removed } }
}

/** Загрузить все включённые доменные источники (cron/кнопка) */
export async function fetchAllDomainSources(origin = 'manual'): Promise<{ ok: number; failed: number; total: number }> {
  const sources = await db.domainSource.findMany({ where: { enabled: true, deletedAt: null }, orderBy: { priority: 'asc' } })
  let ok = 0
  let failed = 0
  for (const s of sources) {
    if (s.kind === 'upload' && s.format === 'sql') { ok++; continue } // импортированная база не перекачивается
    const r = await fetchDomainSourceById(s.id)
    if (r.ok) ok++
    else failed++
  }
  await log(ok && failed === 0 ? 'success' : 'warn', 'fetch',
    `Обновление DNS-источников (${origin}): успешно ${ok}, с ошибками ${failed}`,
    undefined, `DNS sources update (${origin}): ${ok} ok, ${failed} failed`)
  return { ok, failed, total: sources.length }
}

// ── Импорт SQL-базы (дамп ifaro) ─────────────────────────────────────────────

export interface ImportDumpResult {
  ok: boolean
  error?: string
  sourceId?: string
  stats?: {
    domains: number
    categories: number
    otherTypes: number
    invalidDomains: number
    categoryLinks: number
    /** типы дампа: URL/IP/CIDR/Regex/Phrase */
    urlCount: number
    ipCount: number
    cidrCount: number
    regexCount: number
    phraseCount: number
    /** хосты URL, добавленные в DNS-список */
    urlHosts: number
    /** сгенерированные правила NDR по типам */
    ndrIpRules: number
    ndrUrlRules: number
    ndrRegexRules: number
    ndrPhraseRules: number
  }
}

/** NDR-конвертация дампа: вид → { файл, источник, SID-блок } */
const DUMP_NDR_KINDS = [
  { kind: 'ip', file: 'dump-ip.rules', sidStart: 1_200_000, name: 'Дамп фильтрации: IP/CIDR → NDR' },
  { kind: 'url', file: 'dump-url.rules', sidStart: 1_300_000, name: 'Дамп фильтрации: URL → NDR (HTTP)' },
  { kind: 'regex', file: 'dump-regex.rules', sidStart: 1_400_000, name: 'Дамп фильтрации: Regex → NDR (pcre)' },
  { kind: 'phrase', file: 'dump-phrase.rules', sidStart: 1_500_000, name: 'Дамп фильтрации: Phrase → NDR (тело ответа)' },
] as const

type DumpNdrKind = (typeof DUMP_NDR_KINDS)[number]['kind']

function dumpSourceNotes(): { notes: string; notesEn: string } {
  return {
    notes: 'Автогенерированный источник из SQL-дампа базы фильтрации нежелательных ресурсов (импорт: «DNS списки → Источники → Импорт базы»). Правила пересоздаются при каждом импорте дампа. Файл лежит в data/domains/ndr/, SID-блок указан в шапке файла.',
    notesEn: 'Auto-generated source from the unwanted-resource filtering SQL dump (imported via "DNS lists → Sources → Import database"). Rules are regenerated on every dump import. The file lives in data/domains/ndr/, the SID block is stated in the file header.',
  }
}

/**
 * Сгенерировать .rules-файл из индикаторов одного вида и вернуть число правил.
 * Файл перезаписывается при каждом импорте дампа.
 */
async function writeDumpRulesFile(kind: DumpNdrKind, entries: string[], fileName: string): Promise<number> {
  const rules = kind === 'ip' ? generateDumpIpRules(entries)
    : kind === 'url' ? generateDumpUrlRules(entries)
    : kind === 'regex' ? generateDumpRegexRules(entries)
    : generateDumpPhraseRules(entries)
  if (rules.length === 0) return 0
  const dir = path.join(DNS_UPLOAD_DIR, 'ndr')
  await fs.mkdir(dir, { recursive: true })
  const sidStart = rules[0].sid
  const body = rules.map((r) => r.raw).join('\n') + '\n'
  const content = dumpRulesHeader(kind, rules.length, entries.length, sidStart) + body
  await fs.writeFile(path.join(dir, fileName), content, 'utf8')
  return rules.length
}

/**
 * Зарегистрировать/обновить NDR-источник для сгенерированного файла
 * (выключен по умолчанию; правила загружаются сразу, чтобы счётчик был честным).
 */
async function upsertDumpNdrSource(name: string, filePath: string): Promise<string> {
  const notes = dumpSourceNotes()
  let src = await db.source.findUnique({ where: { name } })
  if (!src) {
    src = await db.source.create({
      data: {
        name, category: 'ruleset', kind: 'local', url: filePath, format: 'suricata',
        enabled: false, priority: 150, badge: 'converter', builtin: false,
        notes: notes.notes, notesEn: notes.notesEn,
      },
    })
  } else if (src.url !== filePath || src.deletedAt) {
    src = await db.source.update({ where: { id: src.id }, data: { url: filePath, deletedAt: null, notes: notes.notes, notesEn: notes.notesEn } })
  }
  return src.id
}

/**
 * Импорт SQL-дампа базы фильтрации (MariaDB/HeidiSQL export.sql):
 * категории дампа → DomainCategory (name = ifaro:<номер>:<Eng>), домены
 * (тип Domain name) и хосты URL → DomainRecord с категориями через запятую;
 * прочие типы конвертируются в правила NDR (выключенные источники
 * «Дамп фильтрации: …»). Импорт идёт потоково (батчи по 5000), дамп
 * 500 МБ обрабатывается без загрузки в память.
 */
export async function importDomainDump(filePath: string, opts: { name?: string; replace?: boolean } = {}): Promise<ImportDumpResult> {
  const name = opts.name?.trim() || 'База фильтрации нежелательных ресурсов (импорт)'
  let src = await db.domainSource.findFirst({ where: { format: 'sql' } })
  if (src && !opts.replace) {
    // повторный импорт в ту же базу: записи источника заменяются
  } else if (!src) {
    src = await db.domainSource.create({
      data: {
        name, kind: 'upload', format: 'sql', category: 'rkn', purpose: 'block',
        priority: 10, // импортированная база главнее публичных списков
        url: filePath,
        notes: 'Импортированный SQL-дамп базы фильтрации нежелательных ресурсов. Записи — домены и хосты URL с категориями дампа; категории импортируются в раздел «Категории». IP/CIDR/Regex/Phrase дампа конвертируются в правила NDR (выключенные источники «Дамп фильтрации: …»).',
        notesEn: 'Imported SQL dump of the unwanted-resource filtering database. Records are domains and URL hosts with dump categories; categories are imported into the Categories section. IP/CIDR/Regex/Phrase dump entries are converted into NDR rules (the disabled "Filtering dump: …" sources).',
        builtin: false,
      },
    })
  }
  if (src.kind !== 'upload') {
    await db.domainSource.update({ where: { id: src.id }, data: { kind: 'upload', url: filePath } })
    src = { ...src, kind: 'upload', url: filePath }
  }

  const t0 = Date.now()
  try {
    await dbHeavy.domainRecord.deleteMany({ where: { sourceId: src.id } })
    let created = 0
    let urlHosts = 0
    let dumpDuplicates = 0
    let categoryCount = 0
    const catCounter = new Map<number, number>()
    // домены уникальны в рамках источника (unique [sourceId, domain]): один и тот же
    // домен может прийти из разных resource-строк и из URL-ресурсов — первый побеждает
    const seenDomains = new Set<string>()
    // индикаторы по видам (NDR-конвертация): множества — дубликаты дампа не нужны
    const indEntries: Record<DumpNdrKind, Set<string>> = { ip: new Set(), url: new Set(), regex: new Set(), phrase: new Set() }

    const stats = await parseDumpFile(filePath, {
      onCategories: async (cats) => {
        for (const c of cats) {
          const catName = dumpCategoryName(c)
          await db.domainCategory.upsert({
            where: { name: catName },
            create: { name: catName, label: c.name },
            update: { label: c.name },
          })
        }
        categoryCount += cats.length
      },
      onIndicators: async (batch) => {
        for (const it of batch) {
          // CIDR идёт в один файл/бакет с IP (convertIpList понимает префиксы)
          const bucket = (it.kind === 'cidr' ? 'ip' : it.kind) as DumpNdrKind
          indEntries[bucket].add(it.value)
        }
      },
      onDomains: async (batch) => {
        const fresh = batch.filter((d) => {
          if (seenDomains.has(d.domain)) return false
          seenDomains.add(d.domain)
          return true
        })
        dumpDuplicates += batch.length - fresh.length
        if (!fresh.length) return
        await dbHeavy.domainRecord.createMany({
          data: fresh.map((d) => ({
            sourceId: src!.id,
            domain: d.domain,
            mode: 'block',
            categories: d.categoryIds.length ? d.categoryIds.join(',') : '',
          })),
        })
        await yieldToLoop() // разрядка event loop: UI обслуживается между батчами импорта
        created += fresh.length
        for (const d of fresh) {
          if (d.fromUrl) urlHosts++
          for (const cid of d.categoryIds) catCounter.set(cid, (catCounter.get(cid) ?? 0) + 1)
        }
      },
      onProgress: (st) => {
        void log('info', 'fetch', `Импорт базы: строк ${st.lines.toLocaleString('ru-RU')}, доменов ${st.domains.toLocaleString('ru-RU')}, URL ${st.urlCount.toLocaleString('ru-RU')}, IP ${st.ipCount.toLocaleString('ru-RU')}, CIDR ${st.cidrCount.toLocaleString('ru-RU')}`, undefined,
          `Dump import: ${st.lines} lines, ${st.domains} domains, ${st.urlCount} URLs, ${st.ipCount} IPs, ${st.cidrCount} CIDRs`)
      },
    })

    // счётчики категорий дампа кэшируются (2,2 млн записей не считаем на каждый запрос UI)
    const countsJson = JSON.stringify(Object.fromEntries([...catCounter.entries()].map(([k, v]) => [String(k), v])))
    await db.setting.upsert({
      where: { key: 'dnsIfaroCategoryCounts' },
      create: { key: 'dnsIfaroCategoryCounts', value: countsJson },
      update: { value: countsJson },
    })

    // ── NDR-конвертация прочих типов: .rules-файлы + выключенные источники ──
    const ndrCounts: Record<DumpNdrKind, number> = { ip: 0, url: 0, regex: 0, phrase: 0 }
    for (const def of DUMP_NDR_KINDS) {
      const entries = [...indEntries[def.kind]]
      if (entries.length === 0) continue
      const filePathFull = path.join(DNS_UPLOAD_DIR, 'ndr', def.file)
      const ruleCount = await writeDumpRulesFile(def.kind, entries, def.file)
      if (ruleCount === 0) continue
      ndrCounts[def.kind] = ruleCount
      const sourceId = await upsertDumpNdrSource(def.name, filePathFull)
      // правила грузятся в БД сразу: счётчик источника честный, сборка их
      // не включает, пока источник выключен
      await fetchSourceById(sourceId).catch(() => undefined)
      await log('info', 'fetch', `Дамп → NDR «${def.name}»: ${ruleCount.toLocaleString('ru-RU')} правил из ${entries.length.toLocaleString('ru-RU')} индикаторов (SID ${def.sidStart.toLocaleString('ru-RU')}+)`, undefined,
        `Dump → NDR "${def.name}": ${ruleCount} rules from ${entries.length} indicators (SID ${def.sidStart}+)`)
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    invalidateCounts() // счётчик доменных записей изменился — кэш дашборда обновится
    await db.domainSource.update({
      where: { id: src.id },
      data: { status: 'ok', lastError: null, lastFetchAt: new Date(), domainCount: created, sizeBytes: 0 },
    })
    await log('success', 'fetch',
      `Импорт базы завершён: доменов ${created.toLocaleString('ru-RU')} (+${urlHosts.toLocaleString('ru-RU')} хостов URL), категорий ${categoryCount}, дубликатов дампа ${dumpDuplicates.toLocaleString('ru-RU')}, некорректных доменов ${stats.invalidDomains.toLocaleString('ru-RU')}, ${dt} с`,
      undefined,
      `Dump import finished: ${created} domains (+${urlHosts} URL hosts), ${categoryCount} categories, ${dumpDuplicates} dump duplicates, ${stats.invalidDomains} invalid, ${dt} s`)
    return {
      ok: true,
      sourceId: src.id,
      stats: {
        domains: created,
        categories: categoryCount,
        otherTypes: stats.otherTypes,
        invalidDomains: stats.invalidDomains,
        categoryLinks: stats.categoryLinks,
        urlCount: stats.urlCount,
        ipCount: stats.ipCount,
        cidrCount: stats.cidrCount,
        regexCount: stats.regexCount,
        phraseCount: stats.phraseCount,
        urlHosts,
        ndrIpRules: ndrCounts.ip,
        ndrUrlRules: ndrCounts.url,
        ndrRegexRules: ndrCounts.regex,
        ndrPhraseRules: ndrCounts.phrase,
      },
    }
  } catch (e) {
    const msg = (e as Error).message
    await db.domainSource.update({ where: { id: src.id }, data: { status: 'error', lastError: `импорт дампа: ${msg}` } })
    await log('error', 'fetch', `Ошибка импорта SQL-дампа: ${msg}`, undefined, `SQL dump import failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

// ── Сборка списка заблокированных доменов ────────────────────────────────────

export interface DomainBuildResult {
  ok: boolean
  error?: string
  total?: number
  fileName?: string
}

/**
 * Стриминговая запись итогового файла: порции строк → поток + инкрементальный
 * sha256. Раньше renderDomainFile собирал ВЕСЬ файл одной строкой (на 6 млн
 * доменов — массив из 6 млн строк + строка ~100 МБ в join) — пик памяти и
 * длинная блокировка event loop. Порции по 20k строк (~300 КБ) пишутся
 * с await drain, хэш считается на лету — память плоская, UI отвечает.
 */
async function writeDomainFileStreaming(
  domains: string[],
  tld: string[],
  format: DomainExportFormat,
  meta: DomainFileMeta,
  filePath: string,
  onHeartbeat?: () => void,
): Promise<{ sizeBytes: number; sha256: string }> {
  const header = domainExportHeaderLines(format, meta, domains.length + tld.length)
  const hash = createHash('sha256')
  let sizeBytes = 0
  const stream = createWriteStream(filePath, { encoding: 'utf8' })
  let finished = false
  const writeChunk = (chunk: string): Promise<void> =>
    new Promise((resolve, reject) => {
      hash.update(chunk, 'utf8')
      sizeBytes += Buffer.byteLength(chunk, 'utf8')
      if (!stream.write(chunk)) stream.once('drain', resolve)
      else resolve()
    })
  try {
    await writeChunk(header.join('\n') + '\n\n')
    const buf: string[] = []
    const flush = async (): Promise<void> => {
      if (buf.length) {
        await writeChunk(buf.join('\n') + '\n')
        buf.length = 0
      }
    }
    for (let i = 0; i < domains.length; i++) {
      buf.push(domainExportLine(domains[i], format))
      if (buf.length >= 20_000) {
        await flush()
        onHeartbeat?.()
        await yieldToLoop()
      }
    }
    for (let i = 0; i < tld.length; i++) {
      buf.push(domainExportLine(tld[i], format))
      if (buf.length >= 20_000) {
        await flush()
        onHeartbeat?.()
        await yieldToLoop()
      }
    }
    await flush()
    await new Promise<void>((resolve, reject) => {
      stream.end(() => { finished = true; resolve() })
      stream.on('error', reject)
    })
    return { sizeBytes, sha256: hash.digest('hex') }
  } finally {
    if (!finished) stream.destroy()
  }
}

/**
 * Сборка итогового списка доменов: включённые источники по приоритету,
 * белый список, дубликаты, категории, ручные решения; файл + запись DomainBuild.
 * v1.35.0 (снятие блокировки БД):
 *  • чтение записей и запись результата — через ОТДЕЛЬНУЮ коннекцию dbHeavy:
 *    в режиме WAL читатели не блокируют друг друга, UI/дашборд отвечают
 *    во время сборки (раньше всё шло через одну коннекцию — интерактивные
 *    запросы выстраивались в очередь и падали по таймауту);
 *  • признак жизни (touchDnsBuild) в каждом батче чтения — watchdog больше
 *    не позволит «вечной» сборке заблокировать очередь;
 *  • файл пишется стримингово (без гигантской строки), sha256 на лету;
 *  • timings каждой фазы — в журнал сборки и stdout (диагностика «куда
 *    уходит время» без доступа к БД).
 */
export async function buildDomainList(origin = 'manual'): Promise<DomainBuildResult> {
  if (isDnsBuildActive()) return { ok: false, error: 'DNS-сборка уже выполняется' }
  startDnsBuildProgress(origin)
  addDnsBuildLog('DNS-сборка: чтение источников…')
  const t0 = Date.now()
  try {
    const settings = await getSettings()
    const format = (['plain', 'hosts', 'dnsmasq', 'adblock'].includes(settings.dnsBuildFormat) ? settings.dnsBuildFormat : 'plain') as DomainExportFormat
    const fileName = (settings.dnsFileName || 'blocked-domains.txt').replace(/[^\w.\-а-яё]+/gi, '-')

    const sources = await dbHeavy.domainSource.findMany({ where: { enabled: true, deletedAt: null }, orderBy: { priority: 'asc' } })
    if (sources.length === 0) {
      addDnsBuildLog('Нет включённых DNS-источников — сборка невозможна')
      failDnsBuildProgress('нет включённых DNS-источников')
      return { ok: false, error: 'нет включённых DNS-источников' }
    }
    const cats = await dbHeavy.domainCategory.findMany()
    const disabledCategories = new Set(cats.filter((c) => !c.enabled).map((c) => c.name))
    // категории дампа (ifaro:<номер>:<Eng>): выключенные — фильтруются на чтении батчей
    const disabledDumpIds = new Set<number>()
    for (const c of cats) {
      if (!c.enabled && c.name.startsWith('ifaro:')) {
        const n = parseInt(c.name.split(':')[1] ?? '', 10)
        if (Number.isFinite(n)) disabledDumpIds.add(n)
      }
    }
    const overrides = await dbHeavy.domainOverride.findMany()
    const disabledDomains = new Set(overrides.filter((o) => !o.enabled).map((o) => o.domain))
    const forcedDomains = new Set(overrides.filter((o) => o.enabled && o.note === 'force').map((o) => o.domain))

    setDnsBuildStage('db-read', 5)
    addDnsBuildLog(`Источников: ${sources.length}, категорий: ${cats.length}${disabledCategories.size ? ` (выключено ${disabledCategories.size})` : ''}`)

    // оценка объёма входа — для процента прогресса слияния
    const estimated = Math.max(1, sources.reduce((n, s) => n + Math.max(0, s.domainCount), 0))

    const inputs: DomainSourceInput[] = sources.map((s) => ({
      id: s.id,
      name: s.name,
      purpose: s.purpose === 'allow' ? 'allow' : 'block',
      priority: s.priority,
      category: s.category,
      enabled: s.enabled,
      entries: domainEntries(s.id, disabledDumpIds),
    }))

    setDnsBuildStage('merge', 20)
    addDnsBuildLog('Слияние источников (приоритет → дубликаты → белый список)…')
    const tMerge = Date.now()
    const { domains, tld, stats } = await mergeDomainSources(inputs, {
      disabledCategories,
      disabledDomains,
      forcedDomains,
      // признак жизни + живой процент по мере обработки записей
      onHeartbeat: (processed) => {
        touchDnsBuild()
        const pct = 20 + Math.min(40, Math.round((40 * processed) / estimated))
        if (statePercent() < pct) setDnsBuildStage('merge', pct)
      },
    })
    const mergeSec = ((Date.now() - tMerge) / 1000).toFixed(1)

    // по-источниковая сводка в журнал
    for (const s of sources) {
      const per = stats.perSource[s.name]
      if (!per) continue
      addDnsBuildLog(`«${s.name}»: всего ${per.total.toLocaleString('ru-RU')}, в сборке ${per.kept.toLocaleString('ru-RU')}, дубликатов ${per.droppedDuplicate.toLocaleString('ru-RU')}, белым списком ${per.droppedAllowed.toLocaleString('ru-RU')}`)
    }

    setDnsBuildStage('render', 70)
    addDnsBuildLog(`Итог: ${domains.length.toLocaleString('ru-RU')} доменов + ${tld.length} TLD; дубликатов ${stats.duplicateByDomain.toLocaleString('ru-RU')}, исключено белым списком ${stats.allowedRemoved.toLocaleString('ru-RU')}, категориями ${stats.categoryRemoved.toLocaleString('ru-RU')}, вручную ${stats.overrideRemoved.toLocaleString('ru-RU')}; слияние ${mergeSec} с`)
    await fs.mkdir(DNS_EXPORT_DIR, { recursive: true })
    const filePath = path.join(DNS_EXPORT_DIR, fileName)
    const tWrite = Date.now()
    const written = await writeDomainFileStreaming(domains, tld, format, {
      generatedAt: new Date(),
      sources: sources.map((s) => s.name),
      stats: { ...stats, fileName },
    }, filePath, () => {
      touchDnsBuild()
    })
    const writeSec = ((Date.now() - tWrite) / 1000).toFixed(1)
    const { sha256, sizeBytes } = written

    setDnsBuildStage('save', 85)
    await dbHeavy.domainBuild.create({
      data: {
        totalDomains: domains.length + tld.length,
        statsJson: JSON.stringify(stats),
        fileName,
        filePath,
        sha256,
        sizeBytes,
        source: origin,
      },
    })
    invalidateCounts() // состав записей не изменился, но обновим счётчики дашборда фоново
    setDnsBuildStage('done', 100)
    addDnsBuildLog(`Файл сохранён: ${fileName} (${(sizeBytes / 1024 / 1024).toFixed(1)} МБ, sha256 ${sha256.slice(0, 12)}…), формат ${format}, запись ${writeSec} с`)
    addDnsBuildLog(`Всего: ${((Date.now() - t0) / 1000).toFixed(1)} с`)
    await log('success', 'build',
      `Сборка списка доменов: ${domains.length.toLocaleString('ru-RU')} доменов, дубликатов ${stats.duplicateByDomain.toLocaleString('ru-RU')}, файл ${fileName} (${(sizeBytes / 1024 / 1024).toFixed(1)} МБ)`,
      undefined,
      `Domain list build: ${domains.length} domains, ${stats.duplicateByDomain} duplicates, file ${fileName} (${sizeBytes} bytes)`)
    finishDnsBuildProgress({ ok: true, total: domains.length + tld.length, fileName })
    return { ok: true, total: domains.length + tld.length, fileName }
  } catch (e) {
    const msg = (e as Error).message
    addDnsBuildLog(`Ошибка: ${msg}`)
    failDnsBuildProgress(msg)
    await log('error', 'build', `Ошибка сборки списка доменов: ${msg}`, undefined, `Domain list build failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

/** Текущий процент прогресса (для плавного «merge» без лишних перезаписей) */
function statePercent(): number {
  return getDnsBuildProgress()?.percent ?? 0
}

/**
 * Асинхронный поток записей источника из БД (батчи по 10000, категории дампа
 * фильтруются на лету). v1.35.0: чтение через dbHeavy (отдельная коннекция —
 * UI не мешается), touchDnsBuild на каждом батче — сборка миллионов записей
 * не «зависает» по watchdog, event loop разряжается между батчами.
 */
async function * domainEntries(sourceId: string, disabledDumpIds: Set<number>): AsyncIterable<[string, 'block' | 'allow']> {
  const BATCH = 10_000
  let cursor: number | undefined = undefined
  for (;;) {
    touchDnsBuild()
    const rows = await dbHeavy.domainRecord.findMany({
      where: { sourceId },
      select: { id: true, domain: true, mode: true, categories: true },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: BATCH,
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id
    await yieldToLoop()
    for (const r of rows) {
      if (r.mode === 'allow') { yield [r.domain, 'allow' as const]; continue }
      if (disabledDumpIds.size > 0 && r.categories) {
        // домен с категориями дампа остаётся в сборке, пока включена
        // ХОТЯ БЫ одна его категория
        const ids = r.categories.split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite)
        if (ids.length > 0 && ids.every((id) => disabledDumpIds.has(id))) continue
      }
      yield [r.domain, 'block' as const]
    }
  }
}

/** Прогресс DNS-сборки (для GET /api/dns/build/progress) */
export function dnsBuildProgressState() {
  return getDnsBuildProgress()
}

/** Последняя сборка списка доменов */
export async function lastDomainBuild() {
  const b = await db.domainBuild.findFirst({ orderBy: { createdAt: 'desc' } })
  if (!b) return null
  return {
    id: b.id, createdAt: b.createdAt, totalDomains: b.totalDomains,
    fileName: b.fileName, filePath: b.filePath, sha256: b.sha256,
    sizeBytes: b.sizeBytes, source: b.source,
    stats: JSON.parse(b.statsJson || '{}'),
  }
}

/** Статистика для дашборда («Обзор») */
export async function domainDashboard() {
  const [sources, domains, build, cats] = await Promise.all([
    db.domainSource.findMany({ where: { deletedAt: null }, select: { enabled: true, status: true, purpose: true } }),
    // v1.35.0: COUNT(*) по 6 млн доменных записей на каждый опрос дашборда —
    // через TTL-кэш (фоновое обновление); дашборд больше не ждёт скан таблицы
    domainRecordsCountCached(),
    lastDomainBuild(),
    db.domainCategory.count(),
  ])
  const enabled = sources.filter((s) => s.enabled)
  return {
    sources: { total: sources.length, enabled: enabled.length, ok: enabled.filter((s) => s.status === 'ok').length, error: enabled.filter((s) => s.status === 'error').length },
    domains,
    categories: cats,
    lastBuild: build ? { createdAt: build.createdAt, totalDomains: build.totalDomains, fileName: build.fileName, sha256: build.sha256, sizeBytes: build.sizeBytes, source: build.source } : null,
  }
}
