// ─────────────────────────────────────────────────────────────────────────────
// Сервисный слой: сид каталога, загрузка источников, сборка, экспорт, cron
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { SEED_SOURCES, DEFAULT_SETTINGS } from './seed'
import { fetchSource, FetchSourceCfg, CACHE_DIR, EXPORTS_DIR, DATA_DIR } from './fetcher'
import {
  mergeSources, renderFinalFile, hashRule, conflictKey, findConflictingDuplicates, dedupeConflicting,
  sanitizeSciriusCompat, findSciriusSidConflicts, renderPerSourceFiles, SourceRules, DedupPolicy, BuildStats, BuiltRule,
} from './build'
import { saveExportFile, pushToClearndr, ClearndrExportCfg } from './exporter'
import { SidMapper, remapToClearndrBlock } from './sidmap'
import { ruleCategory, applyCategoryAndRuleFilter } from './categories'
import { notifyEvent } from './notify'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import cron from 'node-cron'

const execFileP = promisify(execFile)

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

/** Заметки источника, который снова работает (ранее был с бейджем «недоступен») */
function availableNotes(authType: string): string {
  const auth = authType === 'authkey'
    ? ' Авторизация: abuse.ch Auth-Key («Настройки → abuse.ch Auth-Key»).'
    : authType === 'oinkcode'
      ? ' Авторизация: oinkcode (поле «Настройки»).'
      : ''
  return `Выгрузка работает: успешная загрузка с текущего URL (ранее источник числился недоступным).${auth}`
}

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany()
  const out: Record<string, string> = { ...DEFAULT_SETTINGS }
  for (const r of rows) out[r.key] = r.value
  return out
}

/** Первичная инициализация каталога источников и настроек.
 *  Начиная с текущей версии работает и «докатка»: на уже инициализированной БД
 *  новые builtin-источники каталога добавляются, а у существующих builtin
 *  синхронизируются url/category/kind/badge/notes (enabled и priority —
 *  пользовательские, их не трогаем). Пользовательские источники не затрагиваются.
 *  Источники в корзине (deletedAt) не синхронизируются и не пересоздаются;
 *  имена удалённых навсегда builtin запоминаются в настройке purgedBuiltinSources.
 *  У источников, чья последняя загрузка прошла успешно (status=ok), каталог не
 *  «оживляет» устаревшие пометки: бейдж «недоступен» снимается (работающий
 *  источник не может быть недоступным), шаблонные заметки о сломанном
 *  состоянии заменяются на актуальные; url/kind/category тоже не трогаются —
 *  рабочий источник не должен ломаться докаткой каталога. */
export async function ensureSeed(): Promise<{ seeded: boolean; catalogAdded: string[]; catalogUpdated: string[] }> {
  const count = await db.source.count()
  const added: string[] = []
  const updated: string[] = []
  const purged = new Set<string>(JSON.parse((await getSetting('purgedBuiltinSources')) || '[]') as string[])
  if (count === 0) {
    for (const s of SEED_SOURCES) {
      if (purged.has(s.name)) continue
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
  } else {
    const rows = await db.source.findMany({
      select: { id: true, name: true, builtin: true, deletedAt: true, category: true, kind: true, url: true, badge: true, notes: true, status: true, authType: true, extraJson: true },
    })
    const byName = new Map(rows.map((r) => [r.name, r]))
    for (const s of SEED_SOURCES) {
      if (purged.has(s.name)) continue
      const cur = byName.get(s.name)
      if (!cur) {
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
        added.push(s.name)
        continue
      }
      if (cur.builtin && !cur.deletedAt) {
        // источник в корзине не синхронизируем — восстановит пользователь
        if (cur.status === 'ok') {
          // Источник работает — каталог не должен «оживлять» устаревшие пометки:
          // снимаем бейдж «недоступен» (после удачной загрузки он лжёт) и,
          // если заметки не редактировались пользователем, заменяем шаблон
          // «источник сломан» на актуальный текст. URL/kind/category рабочего
          // источника не трогаем — докатка не должна ломать то, что работает.
          if (cur.badge !== 'unavailable') continue
          const fix: { badge?: string | null; notes?: string } = { badge: null }
          if (s.notes && cur.notes === s.notes) fix.notes = availableNotes(cur.authType)
          await db.source.update({ where: { id: cur.id }, data: fix })
          updated.push(s.name)
          continue
        }
        const patch: { category?: string; kind?: string; url?: string; badge?: string | null; notes?: string; authType?: string; extraJson?: string } = {}
        if (cur.category !== s.category) patch.category = s.category
        if (cur.kind !== s.kind) patch.kind = s.kind
        if (s.url && cur.url !== s.url) patch.url = s.url
        if ((s.badge ?? null) !== cur.badge) patch.badge = s.badge ?? null
        if (s.notes && cur.notes !== s.notes) patch.notes = s.notes
        if ((s.authType ?? 'none') !== cur.authType) patch.authType = s.authType ?? 'none'
        // extraJson докатывается, только если у источника его ещё нет —
        // пользовательские настройки конвертеров/авторизации не перезаписываются
        const curExtra = (cur.extraJson ?? '').trim()
        if (s.extraJson && (curExtra === '' || curExtra === '{}')) patch.extraJson = s.extraJson
        if (Object.keys(patch).length) {
          await db.source.update({ where: { id: cur.id }, data: patch })
          updated.push(s.name)
        }
      }
    }
    if (added.length) await log('info', 'system', `Каталог дополнен новыми источниками (${added.length}): ${added.join(', ')}`)
    if (updated.length) await log('info', 'system', `Синхронизированы описания builtin-источников (${updated.length}): ${updated.join(', ')}`)
  }
  const sc = await db.setting.count()
  if (sc === 0) {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await setSetting(k, v)
    if (DEFAULT_SETTINGS.oinkcode) await log('info', 'system', 'Oinkcode загружен из переменной окружения OINKCODE')
  }
  return { seeded: count === 0, catalogAdded: added, catalogUpdated: updated }
}

/** Загрузка одного источника и сохранение правил в БД */
export async function fetchSourceById(sourceId: string): Promise<{ ok: boolean; error?: string; count: number; note?: string }> {
  const src = await db.source.findUnique({ where: { id: sourceId } })
  if (!src) return { ok: false, error: 'источник не найден', count: 0 }
  if (src.deletedAt) return { ok: false, error: 'источник в корзине — сначала восстановите его', count: 0 }

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
  // подстановка глобального Auth-Key abuse.ch (ThreatFox/URLhaus и др.)
  if (src.authType === 'authkey') {
    let extra: Record<string, unknown> = {}
    try {
      extra = src.extraJson ? JSON.parse(src.extraJson) : {}
    } catch { /* ignore */ }
    if (!extra.authKey && settings.abusechAuthKey) extra.authKey = settings.abusechAuthKey
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

  const patch: {
    status: string
    lastError: null
    lastFetchAt: Date
    ruleCount: number
    sizeBytes: number
    badge?: string | null
    notes?: string
  } = {
    status: 'ok',
    lastError: null,
    lastFetchAt: new Date(),
    ruleCount: rows.length,
    sizeBytes: res.sizeBytes,
  }
  // бейдж «недоступен» — свойство каталога на момент добавления; после удачной
  // загрузки он лжёт: снимаем, а шаблонные заметки о сломанном состоянии
  // (не редактировавшиеся пользователем) заменяем на актуальный текст
  if (src.badge === 'unavailable') {
    patch.badge = null
    const seedEntry = SEED_SOURCES.find((s) => s.name === src.name)
    if (seedEntry?.notes && src.notes === seedEntry.notes) patch.notes = availableNotes(src.authType)
  }
  await db.source.update({ where: { id: src.id }, data: patch })
  await log('success', 'fetch', `Загружено «${src.name}»: ${rows.length} правил (${dt} с)${res.cacheNote ? ' — ВНИМАНИЕ: работали от кэша' : ''}`)
  return { ok: true, count: rows.length, note: res.cacheNote }
}

/** Загрузить все включённые источники (источники в корзине не участвуют) */
export async function fetchAllSources(origin = 'manual'): Promise<{ ok: number; failed: number; errors: string[] }> {
  const sources = await db.source.findMany({ where: { enabled: true, deletedAt: null }, orderBy: { priority: 'asc' } })
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
    where: { enabled: true, deletedAt: null },
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
      clsType: r.clsType,
    })),
  }))

  // Фильтр категорий и пользовательских исключений правил (раздел «Категории»):
  // правила включённых источников дополнительно проходят через выключенные
  // категории и персональные выключатели (RuleOverride, sid → enabled).
  const catPrefs = await db.category.findMany()
  const overrides = await db.ruleOverride.findMany()
  const catEnabled = new Map(catPrefs.map((c) => [c.name, c.enabled]))
  const ruleEnabled = new Map(overrides.map((o) => [o.sid, o.enabled]))
  let excludedByCategory = 0
  let excludedByRule = 0
  if (catPrefs.some((c) => !c.enabled) || overrides.some((o) => !o.enabled)) {
    let total = 0
    for (const s of srcRules) {
      const { kept, excludedByCategory: byCat, excludedByRule: byRule } = applyCategoryAndRuleFilter(
        s.rules.map((r) => ({ ...r, sourceName: s.sourceName })),
        catEnabled,
        ruleEnabled,
      )
      s.rules = kept.map(({ sourceName: _sn, ...r }) => r)
      excludedByCategory += byCat
      excludedByRule += byRule
      total += s.rules.length
    }
    await log('info', 'build', `Фильтр категорий/правил: исключено по категориям ${excludedByCategory}, по правилам ${excludedByRule}; осталось ${total} правил на входе слияния`)
  }

  const policy: Partial<DedupPolicy> = {
    sidStrategy: settings.dedupSidStrategy as DedupPolicy['sidStrategy'],
    contentDedup: settings.dedupContent === 'true',
    dropIncompatible: settings.dropIncompatible === 'true',
    dropDisabledMsg: settings.dropDisabledMsg === 'true',
    privateSidStart: parseInt(settings.privateSidStart || '1000000000', 10),
  }

  const { rules: merged, stats } = mergeSources(srcRules, policy)
  stats.excludedByCategory = excludedByCategory
  stats.excludedByRule = excludedByRule

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
  stats.uniqueSids = rules.length

  // Гейт Clear NDR №2: наивный парсер scirius берёт ПЕРВОЕ совпадение
  // "sid *: *(\d+)" в строке — контент вида content:"clsid:33…" роняет импорт
  // с «conflicting SID (33) in same source». Переносим настоящий sid в начало
  // опций проблемных правил (ДО перенумерации: remap тоже заменяет первое
  // вхождение sid — после санитайза это гарантированно настоящий sid).
  const sanitized = sanitizeSciriusCompat(rules)
  if (sanitized.failed.length > 0) {
    const sample = sanitized.failed.slice(0, 3).map((f) => `sid ${f.sid}`).join(', ')
    await log('error', 'build', `Сборка прервана: ${sanitized.failed.length} правил не удалось привести к формату парсера Clear NDR (${sample}); файл не записан`, sanitized.failed[0])
    return { ok: false, error: `правила, несовместимые с парсером Clear NDR: ${sanitized.failed.length}` }
  }
  stats.sanitizedForScirius = sanitized.rewritten

  // Политика SID: всё, что вне свободного clearndr-блока 1e9..1.1e9, переносится
  // детерминированно (карта общая с python-конвейером, data/sidmap.json).
  // Гейт: при дубликатах или выходе за блок сборка падает — плохой файл не пишется.
  const mapper = new SidMapper()
  await mapper.load()
  const remap = remapToClearndrBlock(sanitized.rules, mapper)
  await mapper.save()
  stats.renumbered = remap.renumbered

  // Финальная проверка глазами scirius: уникальность «видимых» SID всего набора
  const sidConflicts = findSciriusSidConflicts(sanitized.rules)
  if (sidConflicts.size > 0) {
    const sample = [...sidConflicts.entries()].slice(0, 5).map(([sid, n]) => `sid ${sid} ×${n}`).join(', ')
    await log('error', 'build', `Сборка прервана: парсер Clear NDR увидит дубликаты SID (${sample}); файл не записан`)
    return { ok: false, error: `видимые парсеру Clear NDR дубликаты SID: ${sidConflicts.size}` }
  }

  const content = renderFinalFile(sanitized.rules, {
    sources: sources.map((s) => s.name),
    stats,
  })
  const fileName = settings.buildFileName || 'clearndr-import.rules'
  const { filePath, sizeBytes } = await saveExportFile(fileName, content)
  const sha256 = (await import('crypto')).createHash('sha256').update(content).digest('hex')

  // Вариант сохранения: tgz-архив, правила разбиты по файлам-источникам.
  // Такой архив импортируется в Clear NDR как источник с datatype "sigs":
  // каждый <источник>.rules становится отдельной категорией.
  if (settings.buildFormat === 'file+tgz') {
    try {
      stats.archive = await buildPerSourceArchive(sanitized.rules, fileName, stats)
    } catch (e) {
      await log('warn', 'build', `Архив по источникам не создан: ${(e as Error).message}`)
    }
  }

  const build = await db.build.create({
    data: {
      totalRules: sanitized.rules.length,
      statsJson: JSON.stringify(stats),
      policyJson: JSON.stringify(policy),
      fileName,
      filePath,
      sha256,
      sizeBytes,
      source: origin,
    },
  })
  const archiveNote = stats.archive ? `; архив по источникам: ${stats.archive.fileName} (${stats.archive.files.length} файл(ов), ${(stats.archive.sizeBytes / 1e6).toFixed(1)} МБ)` : ''
  const catNote = stats.excludedByCategory || stats.excludedByRule ? `; исключено: по категориям ${stats.excludedByCategory ?? 0}, по правилам ${stats.excludedByRule ?? 0}` : ''
  await log('success', 'build', `Собран итоговый набор: ${sanitized.rules.length} правил → ${fileName} (${(sizeBytes / 1e6).toFixed(1)} МБ); SID перенесены в clearndr-блок 1e9+ (remap: ${remap.renumbered}, диапазон ${remap.minSid}..${remap.maxSid}); конфликтных близнецов удалено: ${dedup.removed}; адаптировано под парсер Clear NDR: ${sanitized.rewritten}${catNote}${archiveNote}`)
  return { ok: true, buildId: build.id, total: sanitized.rules.length, fileName }
}

/** Собрать tgz-архив: один .rules-файл на каждый источник + README.txt */
async function buildPerSourceArchive(
  rules: BuiltRule[],
  baseFileName: string,
  stats: BuildStats
): Promise<BuildStats['archive']> {
  const perSource = renderPerSourceFiles(rules)
  if (perSource.length === 0) throw new Error('нет правил для архива')
  const base = baseFileName.replace(/\.rules$/i, '')
  const archiveName = `${base}.tgz`
  const archivePath = path.join(EXPORTS_DIR, archiveName)

  const tmpDir = await fs.mkdtemp(path.join(EXPORTS_DIR, '.pack-'))
  try {
    const files: Array<{ name: string; rules: number; sha256: string }> = []
    for (const f of perSource) {
      await fs.writeFile(path.join(tmpDir, f.name), f.content)
      files.push({ name: f.name, rules: f.rules, sha256: createHash('sha256').update(f.content).digest('hex') })
    }
    const readme = [
      '# NDR Rules Hub — итоговый набор, разбитый по источникам',
      `# Сгенерировано: ${new Date().toISOString()}`,
      `# Всего правил: ${rules.length}; файлов: ${perSource.length}`,
      `# Импорт в Clear NDR: Sources → ваш источник (datatype "sigs") → Upload → этот архив;`,
      '# каждый <имя-источника>.rules станет отдельной категорией.',
      '#',
      ...files.map((f) => `# ${f.name}: ${f.rules} правил, sha256=${f.sha256}`),
    ].join('\n') + '\n'
    await fs.writeFile(path.join(tmpDir, 'README.txt'), readme)
    await fs.mkdir(EXPORTS_DIR, { recursive: true })
    await execFileP('tar', ['-czf', archivePath, '-C', tmpDir, ...files.map((f) => f.name), 'README.txt'], { timeout: 300_000 })
    const st = await fs.stat(archivePath)
    return { fileName: archiveName, filePath: archivePath, sizeBytes: st.size, files }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
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
  // уведомление о цикле (Telegram/Gotify; шлётся, только если каналы включены)
  try {
    const title = buildRes.ok
      ? `Полный цикл (${origin}): собрано ${buildRes.total ?? 0} правил${buildRes.fileName ? ` → ${buildRes.fileName}` : ''}`
      : `Ошибка сборки: ${buildRes.error ?? '—'}`
    const parts = [`загрузка: успешно ${fetchRes.ok}, ошибок ${fetchRes.failed}`, buildRes.ok ? `сборка: ${buildRes.total ?? 0} правил` : `сборка: ОШИБКА — ${buildRes.error}`]
    if (exportRes) parts.push(exportRes.ok ? 'экспорт: выполнен' : `экспорт: ${exportRes.error}`)
    if (fetchRes.errors.length) parts.push(`ошибки загрузки: ${fetchRes.errors.slice(0, 5).join('; ')}`)
    await notifyEvent('pipeline', buildRes.ok && fetchRes.failed === 0 ? 'success' : fetchRes.failed || !buildRes.ok ? 'error' : 'warn', title, parts.join('\n'))
  } catch { /* уведомления не роняют цикл */ }
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
