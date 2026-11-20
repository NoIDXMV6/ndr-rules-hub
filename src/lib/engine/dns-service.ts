// ─────────────────────────────────────────────────────────────────────────────
// Сервисный слой DNS-фильтрации: источники доменных списков, импорт SQL-базы,
// сборка списка заблокированных доменов, отдача по токену.
// Идеология аналогична service.ts (правила NDR), но записи — домены.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { DATA_DIR, EXPORTS_DIR } from './fetcher'
import { log, getSettings } from './service'
import {
  parseDomainList, mergeDomainSources, renderDomainFile,
  type DomainExportFormat, type DomainSourceInput,
} from './dns'
import { parseDumpFile, dumpCategoryName } from './dns-import'
import {
  startDnsBuildProgress, setDnsBuildStage, addDnsBuildLog,
  finishDnsBuildProgress, failDnsBuildProgress, isDnsBuildActive, getDnsBuildProgress,
} from './dns-progress'

export const DNS_EXPORT_DIR = path.join(EXPORTS_DIR, 'domains')
export const DNS_UPLOAD_DIR = path.join(DATA_DIR, 'domains')

/** Дефолтные настройки DNS-модуля (seed кладёт в Setting при первом старте) */
export const DNS_SETTING_DEFAULTS: Record<string, string> = {
  dnsBuildFormat: 'plain', // plain | hosts | dnsmasq | adblock — формат итогового файла
  dnsFileName: 'blocked-domains.txt',
  dnsCronEnabled: 'true', // полный цикл (cron) обновляет и DNS-источники, и пересобирает список
  dnsServeToken: '', // глобальный ключ отдачи списка доменов (PULL); пусто — открытая отдача
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

async function httpGet(url: string, extra: { userAgent?: string; basicUser?: string; basicPassword?: string; authKey?: string }): Promise<{ status: number; body: Buffer }> {
  const headers: Record<string, string> = {
    'User-Agent': extra.userAgent || 'clearndr-rules-hub/1.0 (domains updater)',
  }
  if (extra.basicUser && extra.basicPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${extra.basicUser}:${extra.basicPassword}`).toString('base64')}`
  } else if (extra.authKey) {
    headers.Authorization = extra.authKey.trim()
  }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000), headers })
  const body = Buffer.from(await res.arrayBuffer())
  return { status: res.status, body }
}

interface ExtraCfg {
  userAgent?: string
  basicUser?: string
  basicPassword?: string
  authKey?: string
}

/** Загрузить и разобрать один доменный источник: { blocked, allowed, tld } + текст */
async function fetchDomainText(src: { id: string; name: string; kind: string; url: string | null; format: string; authType: string; extraJson: string | null }): Promise<{ ok: boolean; error?: string; text: string; sizeBytes: number }> {
  let extra: ExtraCfg = {}
  try {
    extra = src.extraJson ? (JSON.parse(src.extraJson) as ExtraCfg) : {}
  } catch { /* ignore */ }
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
    const text = res.body.toString('utf8')
    if (/^\s*<(!doctype|html)/i.test(text)) {
      return { ok: false, error: `сервер вернул HTML-страницу вместо списка (${src.url})`, text: '', sizeBytes: res.body.length }
    }
    return { ok: true, text, sizeBytes: res.body.length }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } }
    return { ok: false, error: err.message || 'ошибка загрузки', text: '', sizeBytes: 0 }
  }
}

/** Обновить записи источника: диф по доменам (новые/удалённые), пересчёт счётчиков */
export async function replaceDomainRecords(sourceId: string, records: Array<{ domain: string; mode: 'block' | 'allow'; categories?: string }>): Promise<{ added: number; removed: number; total: number }> {
  const prev = await db.domainRecord.findMany({ where: { sourceId }, select: { id: true, domain: true, mode: true, categories: true } })
  const prevMap = new Map(prev.map((r) => [r.domain, r]))
  const nextMap = new Map(records.map((r) => [r.domain, r]))
  const toCreate = records.filter((r) => {
    const p = prevMap.get(r.domain)
    return !p || p.mode !== r.mode || p.categories !== (r.categories ?? '')
  })
  const toDelete = prev.filter((r) => !nextMap.has(r.domain)).map((r) => r.id)
  const CHUNK = 5000
  for (let i = 0; i < toCreate.length; i += CHUNK) {
    await db.domainRecord.createMany({
      data: toCreate.slice(i, i + CHUNK).map((r) => ({
        sourceId, domain: r.domain, mode: r.mode, categories: r.categories ?? '',
      })),
    })
  }
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    await db.domainRecord.deleteMany({ where: { id: { in: toDelete.slice(i, i + CHUNK) } } })
  }
  // изменившиеся mode/categories — точечные апдейты (обычно их немного)
  const changed = records.filter((r) => {
    const p = prevMap.get(r.domain)
    return p && (p.mode !== r.mode || p.categories !== (r.categories ?? ''))
  })
  for (const r of changed) {
    await db.domainRecord.updateMany({
      where: { sourceId, domain: r.domain },
      data: { mode: r.mode, categories: r.categories ?? '' },
    })
  }
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

  const t0 = Date.now()
  const res = await fetchDomainText(src)
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
  }
}

/**
 * Импорт SQL-дампа базы фильтрации (MariaDB/HeidiSQL export.sql):
 * категории дампа → DomainCategory (name = ifaro:<номер>:<Eng>), домены
 * (тип Domain name) → DomainRecord с категориями через запятую.
 * Импорт идёт потоково (батчи по 5000), дамп 500 МБ обрабатывается без
 * загрузки в память.
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
        notes: 'Импортированный SQL-дамп базы фильтрации нежелательных ресурсов. Записи — домены с категориями дампа; категории импортируются в раздел «Категории».',
        notesEn: 'Imported SQL dump of the unwanted-resource filtering database. Records are domains with dump categories; categories are imported into the Categories section.',
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
    await db.domainRecord.deleteMany({ where: { sourceId: src.id } })
    let created = 0
    let categoryCount = 0
    const catCounter = new Map<number, number>()
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
      onDomains: async (batch) => {
        await db.domainRecord.createMany({
          data: batch.map((d) => ({
            sourceId: src!.id,
            domain: d.domain,
            mode: 'block',
            categories: d.categoryIds.length ? d.categoryIds.join(',') : '',
          })),
        })
        created += batch.length
        for (const d of batch) {
          for (const cid of d.categoryIds) catCounter.set(cid, (catCounter.get(cid) ?? 0) + 1)
        }
      },
      onProgress: (st) => {
        void log('info', 'fetch', `Импорт базы: строк ${st.lines.toLocaleString('ru-RU')}, доменов ${st.domains.toLocaleString('ru-RU')}`, undefined,
          `Dump import: ${st.lines} lines, ${st.domains} domains`)
      },
    })
    // счётчики категорий дампа кэшируются (2,2 млн записей не считаем на каждый запрос UI)
    const countsJson = JSON.stringify(Object.fromEntries([...catCounter.entries()].map(([k, v]) => [String(k), v])))
    await db.setting.upsert({
      where: { key: 'dnsIfaroCategoryCounts' },
      create: { key: 'dnsIfaroCategoryCounts', value: countsJson },
      update: { value: countsJson },
    })
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    await db.domainSource.update({
      where: { id: src.id },
      data: { status: 'ok', lastError: null, lastFetchAt: new Date(), domainCount: created, sizeBytes: 0 },
    })
    await log('success', 'fetch',
      `Импорт базы завершён: доменов ${created.toLocaleString('ru-RU')}, категорий ${categoryCount}, прочих типов ${stats.otherTypes.toLocaleString('ru-RU')}, некорректных доменов ${stats.invalidDomains.toLocaleString('ru-RU')}, ${dt} с`,
      undefined,
      `Dump import finished: ${created} domains, ${categoryCount} categories, ${stats.otherTypes} other types, ${stats.invalidDomains} invalid, ${dt} s`)
    return {
      ok: true,
      sourceId: src.id,
      stats: {
        domains: created,
        categories: categoryCount,
        otherTypes: stats.otherTypes,
        invalidDomains: stats.invalidDomains,
        categoryLinks: stats.categoryLinks,
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
 * Сборка итогового списка доменов: включённые источники по приоритету,
 * белый список, дубликаты, категории, ручные решения; файл + запись DomainBuild.
 */
export async function buildDomainList(origin = 'manual'): Promise<DomainBuildResult> {
  if (isDnsBuildActive()) return { ok: false, error: 'DNS-сборка уже выполняется' }
  startDnsBuildProgress(origin)
  addDnsBuildLog('DNS-сборка: чтение источников…')
  try {
    const settings = await getSettings()
    const format = (['plain', 'hosts', 'dnsmasq', 'adblock'].includes(settings.dnsBuildFormat) ? settings.dnsBuildFormat : 'plain') as DomainExportFormat
    const fileName = (settings.dnsFileName || 'blocked-domains.txt').replace(/[^\w.\-а-яё]+/gi, '-')

    const sources = await db.domainSource.findMany({ where: { enabled: true, deletedAt: null }, orderBy: { priority: 'asc' } })
    if (sources.length === 0) {
      addDnsBuildLog('Нет включённых DNS-источников — сборка невозможна')
      failDnsBuildProgress('нет включённых DNS-источников')
      return { ok: false, error: 'нет включённых DNS-источников' }
    }
    const cats = await db.domainCategory.findMany()
    const disabledCategories = new Set(cats.filter((c) => !c.enabled).map((c) => c.name))
    // категории дампа (ifaro:<номер>:<Eng>): выключенные — фильтруются на чтении батчей
    const disabledDumpIds = new Set<number>()
    for (const c of cats) {
      if (!c.enabled && c.name.startsWith('ifaro:')) {
        const n = parseInt(c.name.split(':')[1] ?? '', 10)
        if (Number.isFinite(n)) disabledDumpIds.add(n)
      }
    }
    const overrides = await db.domainOverride.findMany()
    const disabledDomains = new Set(overrides.filter((o) => !o.enabled).map((o) => o.domain))
    const forcedDomains = new Set(overrides.filter((o) => o.enabled && o.note === 'force').map((o) => o.domain))

    setDnsBuildStage('db-read', 5)
    addDnsBuildLog(`Источников: ${sources.length}, категорий: ${cats.length}${disabledCategories.size ? ` (выключено ${disabledCategories.size})` : ''}`)

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
    const { domains, tld, stats } = await mergeDomainSources(inputs, {
      disabledCategories,
      disabledDomains,
      forcedDomains,
    })

    // по-источниковая сводка в журнал
    for (const s of sources) {
      const per = stats.perSource[s.name]
      if (!per) continue
      addDnsBuildLog(`«${s.name}»: всего ${per.total.toLocaleString('ru-RU')}, в сборке ${per.kept.toLocaleString('ru-RU')}, дубликатов ${per.droppedDuplicate.toLocaleString('ru-RU')}, белым списком ${per.droppedAllowed.toLocaleString('ru-RU')}`)
    }

    setDnsBuildStage('render', 70)
    addDnsBuildLog(`Итог: ${domains.length.toLocaleString('ru-RU')} доменов + ${tld.length} TLD; дубликатов ${stats.duplicateByDomain.toLocaleString('ru-RU')}, исключено белым списком ${stats.allowedRemoved.toLocaleString('ru-RU')}, категориями ${stats.categoryRemoved.toLocaleString('ru-RU')}, вручную ${stats.overrideRemoved.toLocaleString('ru-RU')}`)
    const content = renderDomainFile(domains, tld, format, {
      generatedAt: new Date(),
      sources: sources.map((s) => s.name),
      stats: { ...stats, fileName },
    })

    setDnsBuildStage('save', 85)
    await fs.mkdir(DNS_EXPORT_DIR, { recursive: true })
    const filePath = path.join(DNS_EXPORT_DIR, fileName)
    await fs.writeFile(filePath, content, 'utf8')
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    const sizeBytes = Buffer.byteLength(content, 'utf8')

    await db.domainBuild.create({
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
    setDnsBuildStage('done', 100)
    addDnsBuildLog(`Файл сохранён: ${fileName} (${(sizeBytes / 1024 / 1024).toFixed(1)} МБ, sha256 ${sha256.slice(0, 12)}…), формат ${format}`)
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

/** Асинхронный поток записей источника из БД (батчи по 10000, категории дампа фильтруются на лету) */
async function * domainEntries(sourceId: string, disabledDumpIds: Set<number>): AsyncIterable<[string, 'block' | 'allow']> {
  const BATCH = 10_000
  let cursor: number | undefined = undefined
  for (;;) {
    const rows = await db.domainRecord.findMany({
      where: { sourceId },
      select: { id: true, domain: true, mode: true, categories: true },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: BATCH,
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id
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
  const [sources, agg, build, cats] = await Promise.all([
    db.domainSource.findMany({ where: { deletedAt: null }, select: { enabled: true, status: true, purpose: true } }),
    db.domainRecord.aggregate({ _count: { _all: true } }),
    lastDomainBuild(),
    db.domainCategory.count(),
  ])
  const enabled = sources.filter((s) => s.enabled)
  return {
    sources: { total: sources.length, enabled: enabled.length, ok: enabled.filter((s) => s.status === 'ok').length, error: enabled.filter((s) => s.status === 'error').length },
    domains: agg._count._all,
    categories: cats,
    lastBuild: build ? { createdAt: build.createdAt, totalDomains: build.totalDomains, fileName: build.fileName, sha256: build.sha256, sizeBytes: build.sizeBytes, source: build.source } : null,
  }
}
