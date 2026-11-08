// ─────────────────────────────────────────────────────────────────────────────
// Сервисный слой: сид каталога, загрузка источников, сборка, экспорт, cron
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { SEED_SOURCES, DEFAULT_SETTINGS } from './seed'
import { fetchSource, FetchSourceCfg, CACHE_DIR, EXPORTS_DIR, DATA_DIR } from './fetcher'
import { mergeSources, renderFinalFile, hashRule, conflictKey, findConflictingDuplicates, dedupeConflicting, SourceRules, DedupPolicy } from './build'
import { saveExportFile, pushToClearndr, ClearndrExportCfg } from './exporter'
import { SidMapper, remapToClearndrBlock } from './sidmap'
import { promises as fs } from 'fs'
import path from 'path'
import cron from 'node-cron'

export async function log(level: string, scope: string, message: string, detail?: unknown) {
  try {
    await db.logEntry.create({
      data: {
        level,
        scope,
        message: message.slice(0, 2000),
        detailJson: detail ? JSON.stringify(detail).slice(0, 4000) : null,
      },
    })
  } catch {
    /* ignore */
  }
}

export async function getSetting(key: string): Promise<string> {
  const s = await db.setting.findUnique({ where: { key } })
  return s?.value ?? DEFAULT_SETTINGS[key] ?? ''
}

export async function setSetting(key: string, value: string) {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany()
  const out: Record<string, string> = { ...DEFAULT_SETTINGS }
  for (const r of rows) out[r.key] = r.value
  return out
}

/** Первичная инициализация каталога источников и настроек */
export async function ensureSeed(): Promise<{ seeded: boolean }> {
  const count = await db.source.count()
  if (count === 0) {
    for (const s of SEED_SOURCES) {
      await db.source.create({
        data: {
          name: s.name,
          category: s.category,
          kind: s.kind,
          url: s.url ?? null,
          authType: s.authType ?? 'none',
          extraJson: s.extraJson ?? null,
          enabled: s.enabled ?? false,
          priority: s.priority ?? 100,
          badge: s.badge ?? null,
          notes: s.notes ?? null,
          builtin: true,
        },
      })
    }
    await log('info', 'system', `Каталог инициализирован: ${SEED_SOURCES.length} источников`)
  }
  const sc = await db.setting.count()
  if (sc === 0) {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await setSetting(k, v)
    if (DEFAULT_SETTINGS.oinkcode) await log('info', 'system', 'Oinkcode загружен из переменной окружения OINKCODE')
  }
  return { seeded: count === 0 }
}

/** Загрузка одного источника и сохранение правил в БД */
export async function fetchSourceById(sourceId: string): Promise<{ ok: boolean; error?: string; count: number; note?: string }> {
  const src = await db.source.findUnique({ where: { id: sourceId } })
  if (!src) return { ok: false, error: 'источник не найден', count: 0 }

  const settings = await getSettings()
  const cfg: FetchSourceCfg = {
    id: src.id,
    name: src.name,
    category: src.category,
    kind: src.kind,
    url: src.url,
    authType: src.authType,
    extraJson: src.extraJson,
    format: src.format,
  }
  // подстановка глобального oinkcode
  if (src.authType === 'oinkcode') {
    let extra: Record<string, unknown> = {}
    try {
      extra = src.extraJson ? JSON.parse(src.extraJson) : {}
    } catch { /* ignore */ }
    if (!extra.oinkcode && settings.oinkcode) extra.oinkcode = settings.oinkcode
    cfg.extraJson = JSON.stringify(extra)
  }

  const t0 = Date.now()
  const res = await fetchSource(cfg)
  const dt = ((Date.now() - t0) / 1000).toFixed(1)

  if (!res.ok) {
    await db.source.update({
      where: { id: src.id },
      data: { status: 'error', lastError: res.error ?? 'ошибка', lastFetchAt: new Date() },
    })
    await log('error', 'fetch', `Ошибка загрузки «${src.name}»: ${res.error}`)
    return { ok: false, error: res.error, count: 0 }
  }
  // загрузка не удалась, но отработали от кэша — это предупреждение, а не успех молча
  if (res.cacheNote) {
    await log('warn', 'fetch', `«${src.name}»: ${res.cacheNote}`)
  }

  // дедуп внутри источника по sid (оставляем максимальный rev)
  const bySid = new Map<number, (typeof res.rules)[number]>()
  for (const r of res.rules) {
    if (r.sid === null) continue
    const prev = bySid.get(r.sid)
    if (!prev || r.rev > prev.rev) bySid.set(r.sid, r)
  }

  await db.rule.deleteMany({ where: { sourceId: src.id } })
  const rows = [...bySid.values()].map((r) => ({
    sourceId: src.id,
    sid: r.sid,
    rev: r.rev,
    action: r.action,
    proto: r.proto,
    msg: r.msg?.slice(0, 300) ?? null,
    clsType: r.classtype?.slice(0, 100) ?? null,
    raw: r.raw, // без обрезки: правило Spamhaus DROP 7.7 КБ обрезалось лимитом 8000 и становилось невалидным
    contentHash: hashRule(r.raw),
    suricataOk: r.suricataOk,
    compatNotes: r.compatNotes?.slice(0, 500) ?? null,
  }))
  for (let i = 0; i < rows.length; i += 500) {
    await db.rule.createMany({ data: rows.slice(i, i + 500) })
  }

  await db.source.update({
    where: { id: src.id },
    data: {
      status: 'ok',
      lastError: null,
      lastFetchAt: new Date(),
      ruleCount: rows.length,
      sizeBytes: res.sizeBytes,
    },
  })
  await log('success', 'fetch', `Загружено «${src.name}»: ${rows.length} правил (${dt} с)${res.cacheNote ? ' — ВНИМАНИЕ: работали от кэша' : ''}`)
  return { ok: true, count: rows.length, note: res.cacheNote }
}

/** Загрузить все включённые источники */
export async function fetchAllSources(origin = 'manual'): Promise<{ ok: number; failed: number; errors: string[] }> {
  const sources = await db.source.findMany({ where: { enabled: true }, orderBy: { priority: 'asc' } })
  let ok = 0
  let failed = 0
  const errors: string[] = []
  for (const s of sources) {
    const r = await fetchSourceById(s.id)
    if (r.ok) ok++
    else {
      failed++
      errors.push(`${s.name}: ${r.error}`)
    }
  }
  await log(ok && !failed ? 'success' : failed ? 'error' : 'warn', 'fetch', `Обновление завершено (${origin}): успешно ${ok}, с ошибками ${failed}`)
  return { ok, failed, errors }
}

/** Сборка итогового файла правил */
export async function buildFinal(origin = 'manual'): Promise<{
  ok: boolean
  error?: string
  buildId?: string
  total?: number
  fileName?: string
}> {
  const settings = await getSettings()
  const sources = await db.source.findMany({
    where: { enabled: true },
    orderBy: { priority: 'asc' },
    include: { rules: true },
  })
  if (sources.length === 0) return { ok: false, error: 'Нет включённых источников — сначала загрузите правила' }

  const srcRules: SourceRules[] = sources.map((s) => ({
    sourceId: s.id,
    sourceName: s.name,
    priority: s.priority,
    rules: s.rules.map((r) => ({
      sid: r.sid,
      rev: r.rev,
      raw: r.raw,
      action: r.action,
      proto: r.proto,
      contentHash: r.contentHash,
      suricataOk: r.suricataOk,
      compatNotes: r.compatNotes,
    })),
  }))

  const policy: Partial<DedupPolicy> = {
    sidStrategy: settings.dedupSidStrategy as DedupPolicy['sidStrategy'],
    contentDedup: settings.dedupContent === 'true',
    dropIncompatible: settings.dropIncompatible === 'true',
    dropDisabledMsg: settings.dropDisabledMsg === 'true',
    privateSidStart: parseInt(settings.privateSidStart || '1000000000', 10),
  }

  const { rules: merged, stats } = mergeSources(srcRules, policy)

  // Политика SID: всё, что вне свободного clearndr-блока 1e9..1.1e9, переносится
  // детерминированно (карта общая с python-конвейером, data/sidmap.json).
  // Гейт: при дубликатах или выходе за блок сборка падает — плохой файл не пишется.
  const mapper = new SidMapper()
  await mapper.load()
  const remap = remapToClearndrBlock(merged, mapper)
  await mapper.save()
  stats.renumbered = remap.renumbered

  // Гейт Clear NDR: правила-близнецы (совпадают после снятия sid/reference:*)
  // роняют импорт с «conflicting SID in same source». Убираем их ВСЕГДА,
  // независимо от настроек, и не пишем файл, если конфликтные пары остались.
  const dedup = dedupeConflicting(merged)
  const rules = dedup.rules
  stats.conflictingRemoved = dedup.removed
  const conflicting = findConflictingDuplicates(rules)
  if (conflicting.length > 0) {
    const sample = conflicting.slice(0, 5).map(([a, b]) => `sid ${a.sid}/${b.sid}`).join(', ')
    await log('error', 'build', `Сборка прервана: ${conflicting.length} конфликтных дубликатов (${sample}); файл не записан`)
    return { ok: false, error: `конфликтные дубликаты содержимого: ${conflicting.length}` }
  }

  const content = renderFinalFile(rules, {
    sources: sources.map((s) => s.name),
    stats,
  })
  const fileName = settings.buildFileName || 'clearndr-import.rules'
  const { filePath, sizeBytes } = await saveExportFile(fileName, content)
  const sha256 = (await import('crypto')).createHash('sha256').update(content).digest('hex')

  const build = await db.build.create({
    data: {
      totalRules: rules.length,
      statsJson: JSON.stringify(stats),
      policyJson: JSON.stringify(policy),
      fileName,
      filePath,
      sha256,
      sizeBytes,
      source: origin,
    },
  })
  await log('success', 'build', `Собран итоговый набор: ${rules.length} правил → ${fileName} (${(sizeBytes / 1e6).toFixed(1)} МБ); SID перенесены в clearndr-блок 1e9+ (remap: ${remap.renumbered}, диапазон ${remap.minSid}..${remap.maxSid}); конфликтных близнецов удалено: ${dedup.removed}`)
  return { ok: true, buildId: build.id, total: rules.length, fileName }
}

/** Экспорт последней сборки в Clear NDR */
export async function exportLatestBuild(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const build = await db.build.findFirst({ orderBy: { createdAt: 'desc' } })
  if (!build) return { ok: false, error: 'нет сборок — сначала выполните сборку' }
  const settings = await getSettings()
  const cfg: ClearndrExportCfg = {
    mode: settings.clearndrExportMode as ClearndrExportCfg['mode'],
    url: settings.clearndrExportUrl || undefined,
    token: settings.clearndrExportToken || undefined,
    authType: (settings.clearndrExportAuth as ClearndrExportCfg['authType']) || 'token',
    sourceName: settings.clearndrExportSource || undefined,
    apply: settings.clearndrExportApply !== 'false',
    localPath: settings.clearndrExportLocalPath || undefined,
  }
  const res = await pushToClearndr(build.filePath, cfg)
  if (res.ok) await log('success', 'export', `Экспорт в Clear NDR выполнен: ${res.pushedTo ?? res.detail ?? 'ok'}`)
  else await log('error', 'export', `Ошибка экспорта: ${res.error}`)
  return res
}

/** Полный цикл по расписанию */
export async function runPipeline(origin = 'cron'): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const fetchRes = await fetchAllSources(origin)
  const buildRes = await buildFinal(origin)
  let exportRes: { ok: boolean; error?: string; detail?: string } | null = null
  const settings = await getSettings()
  if (buildRes.ok && origin === 'cron' && settings.cronExport === 'true') {
    exportRes = await exportLatestBuild()
  }
  return {
    ok: buildRes.ok && fetchRes.failed === 0,
    detail: { fetch: fetchRes, build: buildRes, export: exportRes },
  }
}

// ── Планировщик ──────────────────────────────────────────────────────────────
let cronTask: cron.ScheduledTask | null = null

export async function reinitScheduler() {
  if (cronTask) {
    cronTask.stop()
    cronTask = null
  }
  const settings = await getSettings()
  if (settings.cronEnabled === 'true' && cron.validate(settings.cronSchedule)) {
    cronTask = cron.schedule(settings.cronSchedule, () => {
      void runPipeline('cron').catch((e) => log('error', 'scheduler', `Ошибка планировщика: ${e.message}`))
    })
    await log('info', 'scheduler', `Планировщик запущен: «${settings.cronSchedule}»`)
  } else {
    await log('info', 'scheduler', 'Планировщик остановлен' + (settings.cronEnabled !== 'true' ? ' (выключен)' : ` (неверное выражение: ${settings.cronSchedule})`))
  }
}

export function schedulerState(): { running: boolean; schedule?: string } {
  const s = cronTask
  return { running: !!s }
}

export { DATA_DIR, CACHE_DIR, EXPORTS_DIR }
export const repoPath = (p: string) => path.resolve(p)
export const fsApi = fs
