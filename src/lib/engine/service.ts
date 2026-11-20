// ─────────────────────────────────────────────────────────────────────────────
// Сервисный слой: сид каталога, загрузка источников, сборка, экспорт, cron
// ─────────────────────────────────────────────────────────────────────────────
import { db, dbHeavy } from '@/lib/db'
import { multiUserEnabled } from '@/lib/edition'
import { SEED_SOURCES, DEFAULT_SETTINGS } from './seed'
import { isSourceVisible, effectiveEnabled, personalFileName, workspaceSignature } from './workspace'
import { fetchSource, FetchSourceCfg, CACHE_DIR, EXPORTS_DIR, DATA_DIR, isEtProUrl, isSnortOrgUrl, snortRateGate } from './fetcher'
import {
  mergeSources, renderFinalFile, hashRule, conflictKey, findConflictingDuplicates, dedupeConflicting,
  sanitizeSciriusCompat, findSciriusSidConflicts, renderPerSourceFiles, SourceRules, DedupPolicy, BuildStats, BuiltRule, ArchiveInfo,
} from './build'
import { saveExportFile, pushToClearndr, ClearndrExportCfg } from './exporter'
import { SidMapper, remapToClearndrBlock } from './sidmap'
import { ruleCategory, applyCategoryAndRuleFilter } from './categories'
import { notifyEvent } from './notify'
import { startBuildProgress, isBuildActive, setBuildStage, addBuildLog, touchBuild, finishBuildProgress, failBuildProgress } from './build-progress'
import { yieldToLoop } from './loop'
import { invalidateCounts } from './count-cache'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import cron from 'node-cron'

const execFileP = promisify(execFile)

/** Запись в журнал событий. en — английский текст (i18n событий: интерфейс
 *  показывает message или messageEn по языку); userId — рабочее пространство:
 *  null/undefined — системное событие (видит только админ), иначе — событие
 *  пользователя (он видит только свои). */
export async function log(level: string, scope: string, message: string, detail?: unknown, en?: string, userId?: string | null) {
  try {
    await db.logEntry.create({
      data: {
        level,
        scope,
        message: message.slice(0, 2000),
        messageEn: en ? en.slice(0, 2000) : null,
        userId: userId ?? null,
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

/** Английский вариант availableNotes — пишется в notesEn (для EN-интерфейса) */
function availableNotesEn(authType: string): string {
  const auth = authType === 'authkey'
    ? ' Authentication: abuse.ch Auth-Key ("Settings → abuse.ch Auth-Key").'
    : authType === 'oinkcode'
      ? ' Authentication: oinkcode (the "Settings" field).'
      : ''
  return `The feed works: a successful download from the current URL (the source was previously marked unavailable).${auth}`
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
          notesEn: s.notesEn ?? null,
          builtin: true,
          adminOnly: s.adminOnly ?? false,
        },
      })
    }
    await log('info', 'system', `Каталог инициализирован: ${SEED_SOURCES.length} источников`, undefined, `Catalog initialized: ${SEED_SOURCES.length} sources`)
  } else {
    const rows = await db.source.findMany({
      select: { id: true, name: true, builtin: true, deletedAt: true, category: true, kind: true, url: true, badge: true, notes: true, notesEn: true, status: true, authType: true, extraJson: true, adminOnly: true },
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
            notesEn: s.notesEn ?? null,
            builtin: true,
            adminOnly: s.adminOnly ?? false,
          },
        })
        added.push(s.name)
        continue
      }
      if (cur.builtin && !cur.deletedAt) {
        // источник в корзине не синхронизируем — восстановит пользователь
        if (cur.status === 'ok') {
          const fix: { badge?: string | null; notes?: string; notesEn?: string; adminOnly?: boolean } = {}
          if ((cur.badge as string | null) === 'new') {
            // миграция бейджа «новый» (v1.27.0): не отражает суть источника и
            // устаревает («сегодня новый, а завтра не новый») — заменяем на
            // суть из каталога (recommended/traffic/hunting/… или снять)
            fix.badge = s.badge ?? null
          }
          if (cur.badge === 'unavailable') {
            // Источник работает — каталог не должен «оживлять» устаревшие пометки:
            // снимаем бейдж «недоступен» (после удачной загрузки он лжёт) и,
            // если заметки не редактировались пользователем, заменяем шаблон
            // «источник сломан» на актуальный текст. URL/kind/category рабочего
            // источника не трогаем — докатка не должна ломать то, что работает.
            fix.badge = null
            if (s.notes && cur.notes === s.notes) fix.notes = availableNotes(cur.authType)
            if (s.notesEn && cur.notesEn === s.notesEn) fix.notesEn = availableNotesEn(cur.authType)
          }
          // Английское примечание — новое поле каталога: докатываем в ПУСТОЕ
          // (непустое пользовательское не трогаем), рабочие источники не ломаем.
          if (s.notesEn && !cur.notesEn) fix.notesEn = s.notesEn
          if ((s.adminOnly ?? false) !== cur.adminOnly) fix.adminOnly = s.adminOnly ?? false
          if (Object.keys(fix).length) {
            await db.source.update({ where: { id: cur.id }, data: fix })
            updated.push(s.name)
          }
          continue
        }
        const patch: { category?: string; kind?: string; url?: string; badge?: string | null; notes?: string; notesEn?: string; authType?: string; extraJson?: string; adminOnly?: boolean } = {}
        if (cur.category !== s.category) patch.category = s.category
        if (cur.kind !== s.kind) patch.kind = s.kind
        if (s.url && cur.url !== s.url) patch.url = s.url
        // миграция «новый» → суть из каталога; дальше обычная синхронизация бейджа
        if ((cur.badge as string | null) === 'new' && ((s.badge as string | null) ?? null) !== 'new') patch.badge = s.badge ?? null
        else if ((s.badge ?? null) !== cur.badge) patch.badge = s.badge ?? null
        if (s.notes && cur.notes !== s.notes) patch.notes = s.notes
        // английское примечание синхронизируем как текст каталога: в пустое
        // докатываем всегда, отличающееся пользовательское не затираем
        if (s.notesEn && !cur.notesEn) patch.notesEn = s.notesEn
        if ((s.authType ?? 'none') !== cur.authType) patch.authType = s.authType ?? 'none'
        // extraJson докатывается, только если у источника его ещё нет —
        // пользовательские настройки конвертеров/авторизации не перезаписываются
        const curExtra = (cur.extraJson ?? '').trim()
        if (s.extraJson && (curExtra === '' || curExtra === '{}')) patch.extraJson = s.extraJson
        if ((s.adminOnly ?? false) !== cur.adminOnly) patch.adminOnly = s.adminOnly ?? false
        if (Object.keys(patch).length) {
          await db.source.update({ where: { id: cur.id }, data: patch })
          updated.push(s.name)
        }
      }
    }
    if (added.length) await log('info', 'system', `Каталог дополнен новыми источниками (${added.length}): ${added.join(', ')}`, undefined, `Catalog updated with new sources (${added.length}): ${added.join(', ')}`)
    if (updated.length) await log('info', 'system', `Синхронизированы описания builtin-источников (${updated.length}): ${updated.join(', ')}`, undefined, `Built-in source descriptions synchronized (${updated.length}): ${updated.join(', ')}`)
  }
  const sc = await db.setting.count()
  if (sc === 0) {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await setSetting(k, v)
    if (DEFAULT_SETTINGS.oinkcode) await log('info', 'system', 'Oinkcode загружен из переменной окружения OINKCODE')
  } else {
    // v1.34.0: сущность «глобальный ключ отдачи списка доменов» удалена —
    // токены управляются только в разделе «Аккаунт»; историческая настройка
    // (и её значение) вычищаются при старте
    await db.setting.deleteMany({ where: { key: 'dnsServeToken' } })
  }
  return { seeded: count === 0, catalogAdded: added, catalogUpdated: updated }
}

/** Загрузка одного источника и сохранение правил в БД.
 *  userId — рабочее пространство, запустившее загрузку (события журнала
 *  атрибуцируются ему); null/undefined — системное обновление.
 *  rateLimited/retryAfterSec — срабатывал гейт частоты snort.org (15 минут между
 *  загрузками): API отвечает 429 с заголовком Retry-After. */
export interface SourceFetchDiff { added: number; changed: number; removed: number; unchanged: boolean }
export async function fetchSourceById(sourceId: string, userId?: string | null): Promise<{ ok: boolean; error?: string; count: number; note?: string; diff?: SourceFetchDiff; rateLimited?: boolean; retryAfterSec?: number }> {
  const src = await db.source.findUnique({ where: { id: sourceId } })
  if (!src) return { ok: false, error: 'источник не найден', count: 0 }
  if (src.deletedAt) return { ok: false, error: 'источник в корзине — сначала восстановите его', count: 0 }

  // Лимит snort.org: официальное ограничение частоты загрузок — не чаще 1 раза
  // в 15 минут (suricata-update проверяет то же). Без гейта пользователь мог
  // «Обновить» источник сколько угодно раз: snort.org отвечает 403 и может
  // заблокировать oinkcode. lastFetchAt обновляется и при ошибке (запрос к
  // snort.org уже ушёл и учтён их лимитом), поэтому гейт считает попытки.
  // Действует и на cron/«Обновить все» — там источник просто пропускается.
  if (isSnortOrgUrl(src.url)) {
    const gate = snortRateGate(src.lastFetchAt)
    if (gate.blocked) {
      const msg = `snort.org: между загрузками должно пройти 15 минут (последняя попытка ${gate.elapsedMin} мин назад). Повторите через ~${Math.max(1, Math.ceil(gate.retryAfterSec / 60))} мин — лимит защищает ваш oinkcode от блокировки на стороне snort.org.`
      await log('warn', 'fetch', `«${src.name}»: обновление отложено — ${msg}`, undefined, `"${src.name}": update postponed — snort.org: 15 minutes must pass between downloads (last attempt ${gate.elapsedMin} min ago). Retry in ~${Math.max(1, Math.ceil(gate.retryAfterSec / 60))} min.`, userId)
      return { ok: false, error: msg, count: 0, rateLimited: true, retryAfterSec: gate.retryAfterSec }
    }
  }

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
  // подстановка oinkcode. ET Pro (rules.emergingthreatspro.com) имеет СВОЙ код
  // Proofpoint: глобальный oinkcode snort.org к нему НЕ подставляется (раньше
  // ET Pro «молча» ходил со снортовским кодом и получал отказ сервера).
  if (src.authType === 'oinkcode') {
    let extra: Record<string, unknown> = {}
    try {
      extra = src.extraJson ? JSON.parse(src.extraJson) : {}
    } catch { /* ignore */ }
    if (isEtProUrl(src.url)) {
      if (!extra.oinkcode && settings.etProOinkcode) extra.oinkcode = settings.etProOinkcode
      // без кода URL с %%OINKCODE%% уйдёт как есть и ответит непонятной ошибкой —
      // сразу говорим, где ввести код ET Pro
      if (!(extra.oinkcode ?? '').toString().trim() && (src.url ?? '').includes('%%OINKCODE%%')) {
        return {
          ok: false,
          error: 'У источника ET Pro не задан oinkcode — укажите код Proofpoint в «Настройки» → «Oinkcode ET Pro» (он НЕ совпадает с oinkcode snort.org) или в extra источника {"oinkcode":"…"}',
          count: 0,
        }
      }
    } else if (!extra.oinkcode && settings.oinkcode) {
      extra.oinkcode = settings.oinkcode
    }
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
  // подстановка глобального ключа MISP REST API (заголовок Authorization)
  if (src.authType === 'misp') {
    let extra: Record<string, unknown> = {}
    try {
      extra = src.extraJson ? JSON.parse(src.extraJson) : {}
    } catch { /* ignore */ }
    if (!extra.mispAuthKey && settings.mispAuthKey) extra.mispAuthKey = settings.mispAuthKey
    cfg.extraJson = JSON.stringify(extra)
  }
  // подстановка кода лицензии Open NRD (Stamus Networks) — сегмент пути:
  //   https://ti.stamus-networks.io/%%OPENNRD%%/sti-domains-nrd-30.tar.gz
  if (src.authType === 'opennrd') {
    let extra: Record<string, unknown> = {}
    try {
      extra = src.extraJson ? JSON.parse(src.extraJson) : {}
    } catch { /* ignore */ }
    if (!extra.openNrdCode && settings.openNrdLicense) extra.openNrdCode = settings.openNrdLicense
    cfg.extraJson = JSON.stringify(extra)
    if (!(extra.openNrdCode ?? '').toString().trim() && (src.url ?? '').includes('%%OPENNRD%%')) {
      return {
        ok: false,
        error: 'У источника Open NRD не задан код лицензии — получите бесплатный код (форма stamus-networks.com/stamus-labs/subscribe-to-threat-intel-feed, приходит письмом) и введите его в «Настройки → Токены источников → Open NRD», либо в extra источника {"openNrdCode":"…"}',
        count: 0,
      }
    }
  }
  // подстановка API-ключа RST Cloud (api.rstcloud.net) — заголовок X-Api-Key:
  // ключ общий для фидов Threat Feed и IoC Lookup, задаётся в «Настройки»
  if (src.authType === 'rstkey') {
    let extra: Record<string, unknown> = {}
    try {
      extra = src.extraJson ? JSON.parse(src.extraJson) : {}
    } catch { /* ignore */ }
    if (!extra.rstApiKey && settings.rstApiKey) extra.rstApiKey = settings.rstApiKey
    cfg.extraJson = JSON.stringify(extra)
    if (!(extra.rstApiKey ?? '').toString().trim()) {
      return {
        ok: false,
        error: 'У источника RST Cloud не задан API-ключ — получите ключ (rstcloud.com, кнопка Free Trial / личный кабинет) и введите его в «Настройки → Токены источников → RST Cloud», либо в extra источника {"rstApiKey":"…"}',
        count: 0,
      }
    }
  }

  const t0 = Date.now()
  const res = await fetchSource(cfg)
  const dt = ((Date.now() - t0) / 1000).toFixed(1)

  if (!res.ok) {
    await db.source.update({
      where: { id: src.id },
      data: { status: 'error', lastError: res.error ?? 'ошибка', lastFetchAt: new Date() },
    })
    await log('error', 'fetch', `Ошибка загрузки «${src.name}»: ${res.error}`, undefined, `Failed to fetch "${src.name}": ${res.error}`, userId)
    return { ok: false, error: res.error, count: 0 }
  }
  // загрузка не удалась, но отработали от кэша — это предупреждение, а не успех молча
  if (res.cacheNote) {
    await log('warn', 'fetch', `«${src.name}»: ${res.cacheNote}`, undefined, `"${src.name}": ${res.cacheNote}`, userId)
  }

  // дедуп внутри источника по sid (оставляем максимальный rev)
  const bySid = new Map<number, (typeof res.rules)[number]>()
  for (const r of res.rules) {
    if (r.sid === null) continue
    const prev = bySid.get(r.sid)
    if (!prev || r.rev > prev.rev) bySid.set(r.sid, r)
  }

  const rows = [...bySid.values()].map((r) => ({
    sourceId: src.id,
    sid: r.sid!, // bySid наполняется только правилами с sid !== null (фильтр выше)
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

  // Диф загрузки: что изменилось vs предыдущей версии источника. Считается ДО
  // удаления старых строк: sid есть только в новом наборе — добавлено; sid в обоих,
  // но строка правила изменилась — изменено; sid исчез — удалено. Если изменений
  // нет — пересборка/переимпорт правил для Suricata не требуется.
  const prevRows = await dbHeavy.rule.findMany({ where: { sourceId: src.id }, select: { sid: true, raw: true } })
  const prevRaw = new Map(prevRows.map((r) => [r.sid, r.raw]))
  const nextRaw = new Map(rows.map((r) => [r.sid, r.raw]))
  let diffAdded = 0
  let diffChanged = 0
  for (const [sid, raw] of nextRaw) {
    const prev = prevRaw.get(sid)
    if (prev === undefined) diffAdded++
    else if (prev !== raw) diffChanged++
  }
  let diffRemoved = 0
  for (const sid of prevRaw.keys()) if (!nextRaw.has(sid)) diffRemoved++
  const hasDiff = diffAdded + diffChanged + diffRemoved > 0
  // «первая загрузка» — источник ещё ни разу не загружался успешно (нет отметки
  // времени и старых правил): сравнивать не с чем, диф не показываем как изменения
  const firstFetch = !src.lastFetchAt && prevRows.length === 0

  // v1.35.0: массовая замена правил источника — через dbHeavy (отдельная
  // коннекция): загрузка Snort (~53k правил) больше не блокирует UI
  await dbHeavy.rule.deleteMany({ where: { sourceId: src.id } })
  for (let i = 0; i < rows.length; i += 500) {
    await dbHeavy.rule.createMany({ data: rows.slice(i, i + 500) })
    await yieldToLoop() // разрядка event loop: UI обслуживается между чанками
  }
  invalidateCounts() // счётчик правил изменился — кэш дашборда обновится

  const patch: {
    status: string
    lastError: null
    lastFetchAt: Date
    ruleCount: number
    sizeBytes: number
    badge?: string | null
    notes?: string
    notesEn?: string
    diffAdded?: number
    diffChanged?: number
    diffRemoved?: number
  } = {
    status: 'ok',
    lastError: null,
    lastFetchAt: new Date(),
    ruleCount: rows.length,
    sizeBytes: res.sizeBytes,
    diffAdded,
    diffChanged,
    diffRemoved,
  }
  // бейдж «недоступен» — свойство каталога на момент добавления; после удачной
  // загрузки он лжёт: снимаем, а шаблонные заметки о сломанном состоянии
  // (не редактировавшиеся пользователем) заменяем на актуальный текст
  if (src.badge === 'unavailable') {
    patch.badge = null
    const seedEntry = SEED_SOURCES.find((s) => s.name === src.name)
    if (seedEntry?.notes && src.notes === seedEntry.notes) patch.notes = availableNotes(src.authType)
    if (seedEntry?.notesEn && (src.notesEn ?? null) === seedEntry.notesEn) patch.notesEn = availableNotesEn(src.authType)
  }
  await db.source.update({ where: { id: src.id }, data: patch })
  // в журнале — вердикт «нужно ли обновлять правила в Suricata»:
  // первая загрузка (не с чем сравнивать) / изменений нет / перечень изменений
  const diffNote = firstFetch
    ? ' — первая загрузка (сравнение не с чем)'
    : hasDiff
      ? `; изменения: +${diffAdded} добавлено, ~${diffChanged} изменено, −${diffRemoved} удалено`
      : ' — изменений нет (обновлять правила в Suricata не требуется)'
  const enDiffNote = firstFetch
    ? ' — first download (nothing to compare with)'
    : hasDiff
      ? `; changes: +${diffAdded} added, ~${diffChanged} changed, −${diffRemoved} removed`
      : ' — no changes (no need to update Suricata rules)'
  await log('success', 'fetch', `Загружено «${src.name}»: ${rows.length} правил (${dt} с)${diffNote}${res.cacheNote ? ' — ВНИМАНИЕ: работали от кэша' : ''}`, undefined, `Fetched "${src.name}": ${rows.length} rules (${dt} s)${enDiffNote}${res.cacheNote ? ' — WARNING: served from cache' : ''}`, userId)
  return {
    ok: true,
    count: rows.length,
    note: res.cacheNote,
    diff: { added: diffAdded, changed: diffChanged, removed: diffRemoved, unchanged: !firstFetch && !hasDiff },
  }
}

/** Загрузить все включённые источники (источники в корзине не участвуют).
 *  Рабочие пространства (v1.27.0): без userId — СИСТЕМНОЕ обновление: только
 *  источники каталога (ownerId = null) — пользовательские обновляют их владельцы;
 *  с userId — пользователь обновляет только СВОИ включённые источники.
 *  Возвращает агрегированный диф: сколько правил добавлено/изменено/удалено
 *  суммарно по всем источникам и сколько источников без изменений —
 *  по этому вердикту видно, нужно ли пересобрать/переимпортировать правила. */
export async function fetchAllSources(origin = 'manual', userId?: string | null): Promise<{
  ok: number
  failed: number
  errors: string[]
  diff: { added: number; changed: number; removed: number }
  unchangedSources: number
  changesTotal: number
  /** источников пропущено по лимиту snort.org (15 минут между загрузками) —
   *  не ошибка: Talos обновляет наборы раз в сутки, повторная загрузка чуть позже */
  skippedSnortLimit: number
}> {
  // выбор источников рабочего пространства (см. комментарий выше)
  let sources: Array<{ id: string; name: string; priority: number }>
  if (userId) {
    const [own, states] = await Promise.all([
      db.source.findMany({ where: { ownerId: userId, deletedAt: null }, orderBy: { priority: 'asc' } }),
      db.sourceState.findMany({ where: { userId } }),
    ])
    const stMap = new Map(states.map((st) => [st.sourceId, st]))
    sources = own.filter((s) => effectiveEnabled(s, stMap.get(s.id)))
  } else {
    sources = await db.source.findMany({ where: { ownerId: null, enabled: true, deletedAt: null }, orderBy: { priority: 'asc' } })
  }
  let ok = 0
  let failed = 0
  let skippedSnortLimit = 0
  const errors: string[] = []
  const diff = { added: 0, changed: 0, removed: 0 }
  let unchangedSources = 0
  for (const s of sources) {
    const r = await fetchSourceById(s.id, userId ?? null)
    if (r.rateLimited) {
      // гейт snort.org (15 мин) — ожидаемый пропуск, а не сбой загрузки
      skippedSnortLimit++
      continue
    }
    if (r.ok) {
      ok++
      if (r.diff) {
        diff.added += r.diff.added
        diff.changed += r.diff.changed
        diff.removed += r.diff.removed
        if (r.diff.unchanged) unchangedSources++
      }
    } else {
      failed++
      errors.push(`${s.name}: ${r.error}`)
    }
  }
  const changesTotal = diff.added + diff.changed + diff.removed
  const skippedNote = skippedSnortLimit > 0 ? `, пропущено по лимиту snort.org: ${skippedSnortLimit}` : ''
  // «изменений нет» честно только если ни один источник не был пропущен по лимиту
  const verdict = failed > 0
    ? ''
    : changesTotal === 0 && skippedSnortLimit === 0
      ? '; изменений нет — обновление правил в Suricata не требуется'
      : `; изменения: +${diff.added} добавлено, ~${diff.changed} изменено, −${diff.removed} удалено (без изменений: ${unchangedSources})`
  const enVerdict = failed > 0
    ? ''
    : changesTotal === 0 && skippedSnortLimit === 0
      ? '; no changes — no need to update Suricata rules'
      : `; changes: +${diff.added} added, ~${diff.changed} changed, −${diff.removed} removed (unchanged: ${unchangedSources})`
  const enSkipped = skippedSnortLimit > 0 ? `, skipped by snort.org rate limit: ${skippedSnortLimit}` : ''
  await log(ok && !failed ? (changesTotal === 0 && skippedSnortLimit === 0 ? 'info' : 'success') : failed ? 'error' : 'warn', 'fetch', `Обновление завершено (${origin}): успешно ${ok}, с ошибками ${failed}${skippedNote}${verdict}`, undefined, `Update finished (${origin}): ok ${ok}, failed ${failed}${enSkipped}${enVerdict}`, userId ?? null)
  return { ok, failed, errors, diff, unchangedSources, changesTotal, skippedSnortLimit }
}

/** Источники персонального рабочего пространства: видимые пользователю
 *  (системные кроме adminOnly, свои, опубликованные другими) и эффективно
 *  включённые (SourceState, без строки — наследуется Source.enabled).
 *  Возвращает метаданные строк Source БЕЗ правил — правила грузятся пакетно
 *  в buildFinal (v1.35.0: include:{rules:true} одним запросом держал единственную
 *  коннекцию и сотни МБ памяти — UI/дашборд при этом стояли в очереди). */
async function userWorkspaceSources(userId: string) {
  const [sources, states] = await Promise.all([
    dbHeavy.source.findMany({ where: { deletedAt: null }, orderBy: { priority: 'asc' } }),
    db.sourceState.findMany({ where: { userId } }),
  ])
  const stMap = new Map(states.map((st) => [st.sourceId, st]))
  return sources
    .filter((s) => isSourceVisible(s, 'user', userId) && effectiveEnabled(s, stMap.get(s.id)))
    .map((s) => ({ ...s, effectiveEnabled: true }))
}

/** Размер пакета чтения правил одного источника */
const RULES_BATCH = 20_000

/**
 * Пакетное чтение правил одного источника (cursor по id).
 * На батче — touchBuild() (признак жизни для watchdog) и yieldToLoop():
 * event loop обслуживает интерактивные запросы между пакетами, коннекция
 * dbHeavy не «монополизируется» одним гигантским запросом.
 */
async function loadSourceRulesBatched(sourceId: string, sourceName: string, priority: number): Promise<SourceRules> {
  const rules: SourceRules['rules'] = []
  let cursor: number | undefined = undefined
  for (;;) {
    touchBuild()
    const rows = await dbHeavy.rule.findMany({
      where: { sourceId },
      // id обязателен в select: по нему идёт cursor-пагинация (без id курсор
      // всегда undefined — вечный цикл)
      select: { id: true, sid: true, rev: true, raw: true, action: true, proto: true, contentHash: true, suricataOk: true, compatNotes: true, clsType: true },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: RULES_BATCH,
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id
    rules.push(...rows)
    await yieldToLoop()
  }
  return { sourceId, sourceName, priority, rules }
}

/** Сборка итогового файла правил. userId = null — системная сборка (админ,
 *  PULL-набор Clear NDR); cuid пользователя — его ПЕРСОНАЛЬНАЯ сборка:
 *  только его источники, файл personal-<…>.rules, строка Build с userId. */
export async function buildFinal(origin = 'manual', userId: string | null = null): Promise<{
  ok: boolean
  error?: string
  buildId?: string
  total?: number
  fileName?: string
  /** диф итогового набора vs предыдущей сборки (null — не с чем сравнить: первой сборки не было) */
  changes?: { added: number; changed: number; removed: number } | null
  /** состав правил не изменился — переимпортировать файл в Clear NDR/Suricata не требуется */
  unchanged?: boolean
}> {
  // Прогресс сборки: для ручного запуска задание создаёт POST /api/build,
  // для cron/пайплайна — создаём здесь, если активного задания ещё нет
  // (состояние в памяти процесса, UI опрашивает GET /api/build/progress)
  if (!isBuildActive()) startBuildProgress(origin)
  const settings = await getSettings()

  const user = userId ? await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true } }) : null
  // v1.35.0: метаданные источников — через dbHeavy; правила каждого источника
  // читаются ПАКЕТНО (cursor-батчи по RULES_BATCH с разрядкой event loop):
  // раньше include:{rules:true} грузил все правила одним запросом через
  // единственную коннекцию — UI/дашборд/опрос прогресса стояли в очереди
  // (чтение из БД «замедлилось до неприемлемых показателей»), а последующие
  // синхронные фазы делали прогресс непонятным.
  setBuildStage('db-read', 3)
  const sources = userId
    ? await userWorkspaceSources(userId)
    : await dbHeavy.source.findMany({
        where: { enabled: true, deletedAt: null },
        orderBy: { priority: 'asc' },
      })
  if (sources.length === 0) {
    const emptyMsg = userId
      ? 'В вашем рабочем пространстве нет включённых источников — включите системные или добавьте свои на вкладке «Источники»'
      : 'Нет включённых источников — сначала загрузите правила'
    failBuildProgress(emptyMsg)
    return { ok: false, error: emptyMsg }
  }
  addBuildLog(`Чтение правил из базы пакетно (батчи по ${RULES_BATCH.toLocaleString('ru-RU')})…`)
  const srcRules: SourceRules[] = []
  let totalInRules = 0
  for (const meta of sources) {
    const loaded = await loadSourceRulesBatched(meta.id, meta.name, meta.priority)
    srcRules.push(loaded)
    totalInRules += loaded.rules.length
    addBuildLog(`Источник «${meta.name}»: ${loaded.rules.length.toLocaleString('ru-RU')} правил`)
  }
  addBuildLog(`Чтение завершено: источников ${sources.length} шт., правил на входе ${totalInRules.toLocaleString('ru-RU')}`)

  // Фильтр категорий и пользовательских исключений правил (раздел «Категории»):
  // правила включённых источников дополнительно проходят через выключенные
  // категории и персональные выключатели (RuleOverride, sid → enabled).
  setBuildStage('filter', 10)
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
    addBuildLog(`Фильтр категорий/правил: исключено ${excludedByCategory + excludedByRule}, осталось ${total.toLocaleString('ru-RU')} правил`)
  }

  // Стратегия выбирает ТОЛЬКО победителя (чья копия сохранит исходный SID);
  // судьба проигравшего — dedupSidConflict. Легаси-значение 'renumber-private'
  // выведено в v1.28.1 (проход перенумерации всего набора всё равно затирался
  // безусловным remap в clearndr-блок; его роль выполняет sidConflict='reassign').
  const legacyRenumber = settings.dedupSidStrategy === 'renumber-private'
  const policy: Partial<DedupPolicy> = {
    sidStrategy: settings.dedupSidStrategy === 'source-priority' ? 'source-priority' : 'highest-rev',
    // проигравший при конфликте SID с другим детектом: 'reassign' — оставить
    // оба правила, проигравшему временный SID (финальный remap даст свой слот)
    sidConflict: settings.dedupSidConflict === 'reassign' ? 'reassign' : 'drop',
    contentDedup: settings.dedupContent === 'true',
    dropIncompatible: settings.dropIncompatible === 'true',
    dropDisabledMsg: settings.dropDisabledMsg === 'true',
  }
  if (legacyRenumber) {
    const note =
      'Стратегия «перенумерация в приватный диапазон» выведена: её роль выполняет «Проигравший при конфликте SID → оставлять и назначить новый SID»; применяется highest-rev.'
    await log('info', 'build', note)
    addBuildLog(note)
  }

  setBuildStage('merge', 15)
  addBuildLog(`Слияние ${sources.length} источников с дедупликацией…`)
  const { rules: merged, stats } = mergeSources(srcRules, policy)
  stats.excludedByCategory = excludedByCategory
  stats.excludedByRule = excludedByRule
  // подпись рабочего пространства (персональные сборки): cron сравнивает её
  // с прошлой персональной сборкой и пропускает пересборку без изменений
  if (userId) {
    stats.workspaceSignature = workspaceSignature(srcRules.map((sr) => ({
      id: sr.sourceId,
      enabled: sources.find((s) => s.id === sr.sourceId)?.enabled ?? true,
      eff: true,
      priority: sr.priority,
      ruleCount: sr.rules.length,
      updatedAt: sources.find((s) => s.id === sr.sourceId)?.updatedAt,
    })))
    stats.workspace = { userId, sources: sources.length }
  }
  setBuildStage('conflict-dedup', 45)
  addBuildLog(`Слияние завершено: дубликатов по SID ${stats.duplicateBySid}, по содержимому ${stats.duplicateByContent}, несовместимых ${stats.incompatibleDropped}, переназначено SID ${stats.reassigned ?? 0}`)

  // Гейт Clear NDR: правила-близнецы (совпадают после снятия sid/reference:*)
  // роняют импорт с «conflicting SID in same source». Убираем их ВСЕГДА,
  // независимо от настроек, и не пишем файл, если конфликтные пары остались.
  const dedup = dedupeConflicting(merged)
  const rules = dedup.rules
  stats.conflictingRemoved = dedup.removed
  addBuildLog(`Конфликтных близнецов Clear NDR удалено: ${dedup.removed}`)
  const conflicting = findConflictingDuplicates(rules)
  if (conflicting.length > 0) {
    const sample = conflicting.slice(0, 5).map(([a, b]) => `sid ${a.sid}/${b.sid}`).join(', ')
    await log('error', 'build', `Сборка прервана: ${conflicting.length} конфликтных дубликатов (${sample}); файл не записан`)
    failBuildProgress(`конфликтные дубликаты содержимого: ${conflicting.length}`)
    return { ok: false, error: `конфликтные дубликаты содержимого: ${conflicting.length}` }
  }
  stats.uniqueSids = rules.length

  // Гейт Clear NDR №2: наивный парсер scirius берёт ПЕРВОЕ совпадение
  // "sid *: *(\d+)" в строке — контент вида content:"clsid:33…" роняет импорт
  // с «conflicting SID (33) in same source». Переносим настоящий sid в начало
  // опций проблемных правил (ДО перенумерации: remap тоже заменяет первое
  // вхождение sid — после санитайза это гарантированно настоящий sid).
  setBuildStage('sanitize', 55)
  const sanitized = sanitizeSciriusCompat(rules)
  if (sanitized.failed.length > 0) {
    const sample = sanitized.failed.slice(0, 3).map((f) => `sid ${f.sid}`).join(', ')
    await log('error', 'build', `Сборка прервана: ${sanitized.failed.length} правил не удалось привести к формату парсера Clear NDR (${sample}); файл не записан`, sanitized.failed[0])
    failBuildProgress(`правила, несовместимые с парсером Clear NDR: ${sanitized.failed.length}`)
    return { ok: false, error: `правила, несовместимые с парсером Clear NDR: ${sanitized.failed.length}` }
  }
  stats.sanitizedForScirius = sanitized.rewritten
  addBuildLog(`Адаптировано под парсер Clear NDR: ${sanitized.rewritten}`)

  // Политика SID: всё, что вне свободного clearndr-блока 1e9..1.1e9, переносится
  // детерминированно (карта общая с python-конвейером, data/sidmap.json).
  // Гейт: при дубликатах или выходе за блок сборка падает — плохой файл не пишется.
  setBuildStage('remap', 62)
  const mapper = new SidMapper()
  await mapper.load()
  const remap = remapToClearndrBlock(sanitized.rules, mapper)
  await mapper.save()
  stats.renumbered = remap.renumbered
  addBuildLog(`Remap SID в clearndr-блок: перенесено ${remap.renumbered} (диапазон ${remap.minSid}..${remap.maxSid})`)

  // Финальная проверка глазами scirius: уникальность «видимых» SID всего набора
  setBuildStage('sid-check', 68)
  const sidConflicts = findSciriusSidConflicts(sanitized.rules)
  if (sidConflicts.size > 0) {
    const sample = [...sidConflicts.entries()].slice(0, 5).map(([sid, n]) => `sid ${sid} ×${n}`).join(', ')
    await log('error', 'build', `Сборка прервана: парсер Clear NDR увидит дубликаты SID (${sample}); файл не записан`)
    failBuildProgress(`видимые парсеру Clear NDR дубликаты SID: ${sidConflicts.size}`)
    return { ok: false, error: `видимые парсеру Clear NDR дубликаты SID: ${sidConflicts.size}` }
  }

  setBuildStage('render', 72)
  addBuildLog(`Рендер итогового файла: ${sanitized.rules.length.toLocaleString('ru-RU')} правил…`)
  const content = renderFinalFile(sanitized.rules, {
    sources: sources.map((s) => s.name),
    stats,
  })
  const fileName = userId
    ? personalFileName(userId, user?.email)
    : (settings.buildFileName || 'clearndr-import.rules')

  // Диф набора vs предыдущей сборки: читаем ПРЕДЫДУЩИЙ файл экспорта (ДО перезаписи
  // новым файлом — путь тот же) и сравниваем по sid + строке правила: что добавилось,
  // изменилось, удалилось в итоговом наборе. Если состав не изменился — переимпортировать
  // файл в Clear NDR/Suricata не требуется (заголовок «Сгенерировано» не в счёт).
  setBuildStage('diff', 82)
  const prevBuild = await db.build.findFirst({ where: { userId: userId ?? null }, orderBy: { createdAt: 'desc' } })
  let prevMap: Map<number, string> | null = null
  if (prevBuild) {
    try {
      prevMap = parseExportRules(await fs.readFile(prevBuild.filePath, 'utf8'))
    } catch {
      prevMap = null // файла предыдущей сборки нет (очищен/другой том) — сравнить не с чем
    }
  }
  const newMap = new Map(sanitized.rules.map((r) => [r.sid, r.raw]))
  let changes: { added: number; changed: number; removed: number } | null = null
  if (prevMap) {
    let added = 0
    let changed = 0
    for (const [sid, raw] of newMap) {
      const prev = prevMap.get(sid)
      if (prev === undefined) added++
      else if (prev !== raw) changed++
    }
    let removed = 0
    for (const sid of prevMap.keys()) if (!newMap.has(sid)) removed++
    changes = { added, changed, removed }
    stats.changes = changes
  }
  const unchanged = changes !== null && changes.added + changes.changed + changes.removed === 0
  addBuildLog(changes === null
    ? 'Диф: первая сборка — сравнивать не с чем'
    : unchanged
      ? 'Диф vs предыдущей сборки: изменений нет'
      : `Диф vs предыдущей сборки: +${changes.added} добавлено, ~${changes.changed} изменено, −${changes.removed} удалено`)

  setBuildStage('save', 88)
  const { filePath, sizeBytes } = await saveExportFile(fileName, content)
  const sha256 = (await import('crypto')).createHash('sha256').update(content).digest('hex')
  addBuildLog(`Файл записан: ${fileName} (${(sizeBytes / 1e6).toFixed(1)} МБ)`)

  // Вариант сохранения: tgz-архив, правила разбиты по файлам-источникам.
  // Такой архив импортируется в Clear NDR как источник с datatype "sigs":
  // каждый <источник>.rules становится отдельной категорией.
  if (settings.buildFormat === 'file+tgz') {
    setBuildStage('archive', 91)
    try {
      const arch: ArchiveInfo = await buildPerSourceArchive(sanitized.rules, fileName, stats)
      stats.archive = arch
      addBuildLog(`Архив по источникам: ${arch.fileName} (${arch.files.length} файл(ов))`)
    } catch (e) {
      await log('warn', 'build', `Архив по источникам не создан: ${(e as Error).message}`)
      addBuildLog(`Архив по источникам не создан: ${(e as Error).message}`)
    }
  }

  setBuildStage('db-write', 96)
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
      userId: userId ?? null,
    },
  })
  const archiveNote = stats.archive ? `; архив по источникам: ${stats.archive.fileName} (${stats.archive.files.length} файл(ов), ${(stats.archive.sizeBytes / 1e6).toFixed(1)} МБ)` : ''
  const catNote = stats.excludedByCategory || stats.excludedByRule ? `; исключено: по категориям ${stats.excludedByCategory ?? 0}, по правилам ${stats.excludedByRule ?? 0}` : ''
  const changeNote = changes === null
    ? '; первая сборка (сравнение не с чем)'
    : unchanged
      ? '; состав правил не изменился — переимпортировать в Clear NDR/Suricata не требуется'
      : `; изменения набора vs предыдущей сборки: +${changes.added} добавлено, ~${changes.changed} изменено, −${changes.removed} удалено`
  await log(unchanged ? 'info' : 'success', 'build', `Собран итоговый набор${userId ? ` (рабочее пространство ${user?.email ?? userId})` : ''}: ${sanitized.rules.length} правил → ${fileName} (${(sizeBytes / 1e6).toFixed(1)} МБ); SID перенесены в clearndr-блок 1e9+ (remap: ${remap.renumbered}, диапазон ${remap.minSid}..${remap.maxSid}); конфликтных близнецов удалено: ${dedup.removed}; адаптировано под парсер Clear NDR: ${sanitized.rewritten}${catNote}${archiveNote}${changeNote}`, undefined, `Final ruleset built${userId ? ` (workspace ${user?.email ?? userId})` : ''}: ${sanitized.rules.length} rules → ${fileName} (${(sizeBytes / 1e6).toFixed(1)} MB); SID remapped to clearndr block 1e9+ (remap: ${remap.renumbered}, range ${remap.minSid}..${remap.maxSid}); conflicting twins removed: ${dedup.removed}; adapted for Clear NDR parser: ${sanitized.rewritten}${changeNote}`, userId ?? null)
  finishBuildProgress({ ok: true, total: sanitized.rules.length, fileName, changes, unchanged })
  return { ok: true, buildId: build.id, total: sanitized.rules.length, fileName, changes, unchanged }
}

/** Разобрать файл экспорта предыдущей сборки: sid → строка правила (комментарии пропускаются).
 *  Итоговый файл всегда содержит настоящий sid первым совпадением регэкспа (sanitizeSciriusCompat). */
function parseExportRules(content: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const m = /sid *: *(\d+)/.exec(line)
    if (m) out.set(parseInt(m[1], 10), line)
  }
  return out
}

/** Собрать tgz-архив: один .rules-файл на каждый источник + README.txt */
async function buildPerSourceArchive(
  rules: BuiltRule[],
  baseFileName: string,
  stats: BuildStats
): Promise<ArchiveInfo> {
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

/** Экспорт последней СИСТЕМНОЙ сборки в Clear NDR (персональные сборки
 *  пользователей экспортируются их владельцами как файл/PULL, а не пушем в
 *  Clear NDR администратора) */
export async function exportLatestBuild(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const build = await db.build.findFirst({ where: { userId: null }, orderBy: { createdAt: 'desc' } })
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

/** Подпись рабочего пространства пользователя: состав/состояния/данные источников.
 *  Меняется при переключении источников, их загрузке и правках. */
export async function computeWorkspaceSignature(userId: string): Promise<string> {
  const [sources, states] = await Promise.all([
    db.source.findMany({ where: { deletedAt: null } }),
    db.sourceState.findMany({ where: { userId } }),
  ])
  const stMap = new Map(states.map((st) => [st.sourceId, st]))
  return workspaceSignature(sources
    .filter((s) => isSourceVisible(s, 'user', userId))
    .map((s) => ({
      id: s.id, enabled: s.enabled, eff: effectiveEnabled(s, stMap.get(s.id)), priority: s.priority, ruleCount: s.ruleCount, updatedAt: s.updatedAt,
    })))
}

/** Персональные сборки всех активных пользователей: пересобираем только те
 *  рабочие пространства, чья подпись изменилась с прошлой персональной сборки. */
async function buildPersonalWorkspaces(origin: string): Promise<{ built: number; skipped: number; failed: number }> {
  let built = 0
  let skipped = 0
  let failed = 0
  const users = await db.user.findMany({ where: { status: 'active', role: 'user' }, select: { id: true, email: true } })
  for (const u of users) {
    try {
      const sig = await computeWorkspaceSignature(u.id)
      const last = await db.build.findFirst({ where: { userId: u.id }, orderBy: { createdAt: 'desc' } })
      const lastSig = last ? (JSON.parse(last.statsJson || '{}') as { workspaceSignature?: string }).workspaceSignature : undefined
      if (last && lastSig === sig) {
        skipped++
        continue
      }
      const r = await buildFinal(origin, u.id)
      if (r.ok) built++
      else failed++
    } catch (e) {
      failed++
      await log('warn', 'build', `Персональная сборка ${u.email}: ${(e as Error).message}`, undefined, `Personal build for ${u.email}: ${(e as Error).message}`)
    }
  }
  return { built, skipped, failed }
}

/** Режим DNS-цикла при основном полном цикле */
export type DnsCycleMode = 'off' | 'inline' | 'deferred'

/**
 * Как запускать DNS-цикл (обновление DNS-источников + сборка списка доменов):
 *  • 'off'      — выключен настройкой dnsCronEnabled=false;
 *  • 'deferred' — по отдельному расписанию dnsCronSchedule (разнос пиков:
 *    сначала правила и сборка набора, позже — домены);
 *  • 'inline'   — сразу за основным циклом (расписание не задано или неверно).
 */
export function dnsCycleMode(dnsCronEnabled?: string, dnsCronSchedule?: string): DnsCycleMode {
  if ((dnsCronEnabled ?? 'true') === 'false') return 'off'
  const s = (dnsCronSchedule ?? '').trim()
  return s && cron.validate(s) ? 'deferred' : 'inline'
}

/**
 * DNS-цикл по собственному расписанию (dnsCronSchedule): обновление доменных
 * источников, пересборка списка заблокированных доменов и СОБСТВЕННОЕ
 * уведомление Telegram/Gotify (переключатель notifyOnDns в «Интеграциях»;
 * в тексте — строка «DNS-списки»). Ошибки каналов не роняют цикл.
 */
export async function runDnsCycle(origin = 'cron'): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const dnsSvc = await import('./dns-service')
  const fetched = await dnsSvc.fetchAllDomainSources(origin)
  const built = await dnsSvc.buildDomainList(origin)
  try {
    const title = built.ok
      ? `DNS-цикл (${origin}): список доменов собран — ${(built.total ?? 0).toLocaleString('ru-RU')} доменов`
      : `Ошибка DNS-цикла: ${built.error ?? '—'}`
    const parts = [
      `источники: успешно ${fetched.ok}, ошибок ${fetched.failed} (всего ${fetched.total})`,
      built.ok
        ? `сборка списка: ${(built.total ?? 0).toLocaleString('ru-RU')} доменов → ${built.fileName ?? '—'}`
        : `сборка списка: ОШИБКА — ${built.error}`,
    ]
    await notifyEvent('dns', built.ok && fetched.failed === 0 ? 'success' : fetched.failed || !built.ok ? 'error' : 'warn', title, parts.join('\n'))
  } catch {
    /* уведомления не роняют цикл */
  }
  return { ok: built.ok && fetched.failed === 0, detail: { fetch: fetched, build: built } }
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
  // DNS-фильтрация: обновление доменных источников + пересборка списка доменов.
  // dnsCycleMode: 'inline' — сразу за основным циклом (по умолчанию), 'deferred' —
  // по отдельному расписанию dnsCronSchedule (разнос пиков: правила утром, домены позже),
  // 'off' — DNS-цикл выключен настройкой dnsCronEnabled.
  // (динамический импорт dns-service — без циклических связей модулей)
  let dns: { ok: number; failed: number; total: number; build: { ok: boolean; total?: number; error?: string } } | null = null
  const dnsMode = dnsCycleMode(settings.dnsCronEnabled, settings.dnsCronSchedule)
  if (dnsMode === 'inline') {
    try {
      const dnsSvc = await import('./dns-service')
      const fetched = await dnsSvc.fetchAllDomainSources(origin)
      const built = await dnsSvc.buildDomainList(origin)
      dns = { ...fetched, build: { ok: built.ok, total: built.total, error: built.error } }
    } catch (e) {
      await log('warn', 'scheduler', `DNS-цикл не выполнен: ${(e as Error).message}`, undefined, `DNS cycle failed: ${(e as Error).message}`)
    }
  }
  // уведомление о цикле (Telegram/Gotify; шлётся, только если каналы включены)
  try {
    const title = buildRes.ok
      ? `Полный цикл (${origin}): собрано ${buildRes.total ?? 0} правил${buildRes.fileName ? ` → ${buildRes.fileName}` : ''}`
      : `Ошибка сборки: ${buildRes.error ?? '—'}`
    const parts = [`загрузка: успешно ${fetchRes.ok}, ошибок ${fetchRes.failed}`, buildRes.ok ? `сборка: ${buildRes.total ?? 0} правил` : `сборка: ОШИБКА — ${buildRes.error}`]
    // диф обновления: видно сразу в push-уведомлении, нужно ли переимпортировать правила
    if (buildRes.ok) {
      if (fetchRes.changesTotal === 0) parts.push('изменения правил: нет — обновлять Suricata не требуется')
      else parts.push(`изменения правил: +${fetchRes.diff.added} добавлено, ~${fetchRes.diff.changed} изменено, −${fetchRes.diff.removed} удалено (без изменений: ${fetchRes.unchangedSources})`)
      if (buildRes.changes) {
        if (buildRes.unchanged) parts.push('состав итогового набора не изменился — переимпортировать файл не требуется')
        else parts.push(`итоговый набор vs предыдущей сборки: +${buildRes.changes.added} ~${buildRes.changes.changed} −${buildRes.changes.removed}`)
      }
    }
    if (exportRes) parts.push(exportRes.ok ? 'экспорт: выполнен' : `экспорт: ${exportRes.error}`)
    if (dns) {
      parts.push(`DNS: источники ${dns.ok}/${dns.total} успешно, список доменов: ${dns.build.ok ? `${(dns.build.total ?? 0).toLocaleString('ru-RU')} доменов` : `ошибка — ${dns.build.error}`}`)
    } else if (dnsMode === 'deferred') {
      parts.push(`DNS: отдельный цикл по расписанию «${(settings.dnsCronSchedule ?? '').trim()}» — обновление источников и сборка списка выполняются отдельно (разнос пиков)`)
    }
    if (fetchRes.errors.length) parts.push(`ошибки загрузки: ${fetchRes.errors.slice(0, 5).join('; ')}`)
    await notifyEvent('pipeline', buildRes.ok && fetchRes.failed === 0 ? 'success' : fetchRes.failed || !buildRes.ok ? 'error' : 'warn', title, parts.join('\n'))
  } catch { /* уведомления не роняют цикл */ }
  // персональные рабочие пространства (Enterprise): сборка наборов пользователей —
  // только те, чьё состояние изменилось (по подписи рабочего пространства)
  let personal: { built: number; skipped: number; failed: number } | null = null
  if (multiUserEnabled() && buildRes.ok) {
    try {
      personal = await buildPersonalWorkspaces(origin)
      if (personal.built || personal.failed) await log('info', 'build', `Персональные сборки (${origin}): собрано ${personal.built}, пропущено без изменений ${personal.skipped}, с ошибками ${personal.failed}`, undefined, `Personal builds (${origin}): built ${personal.built}, skipped unchanged ${personal.skipped}, failed ${personal.failed}`)
    } catch (e) {
      await log('warn', 'build', `Персональные сборки не выполнены: ${(e as Error).message}`)
    }
  }
  return {
    ok: buildRes.ok && fetchRes.failed === 0,
    detail: { fetch: fetchRes, build: buildRes, export: exportRes, personal, dns },
  }
}

// ── Планировщик ──────────────────────────────────────────────────────────────
let cronTask: { stop: () => void; destroy?: () => void } | null = null
// DNS-цикл по отдельному расписанию (dnsCronSchedule) — разнос пиков нагрузки:
// основной цикл собирает правила, DNS-источники обновляются и список доменов
// пересобирается в отведённое отдельно время.
let dnsCronTask: { stop: () => void; destroy?: () => void } | null = null

export async function reinitScheduler() {
  if (cronTask) {
    cronTask.stop()
    cronTask = null
  }
  if (dnsCronTask) {
    dnsCronTask.stop()
    dnsCronTask = null
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
  // DNS-цикл: отдельная cron-задача при заданном корректном расписании
  const dnsSchedule = (settings.dnsCronSchedule ?? '').trim()
  if (dnsCycleMode(settings.dnsCronEnabled, settings.dnsCronSchedule) === 'deferred') {
    dnsCronTask = cron.schedule(dnsSchedule, () => {
      void runDnsCycle('cron').catch((e) => log('error', 'scheduler', `Ошибка DNS-планировщика: ${e.message}`, undefined, `DNS scheduler error: ${e.message}`))
    })
    await log('info', 'scheduler', `DNS-цикл запущен по отдельному расписанию «${dnsSchedule}» (разнос с основным циклом)`, undefined, `DNS cycle scheduled separately: "${dnsSchedule}"`)
  } else if (dnsSchedule) {
    await log('warn', 'scheduler', `DNS-расписание «${dnsSchedule}» не применено: ${settings.dnsCronEnabled === 'false' ? 'DNS-цикл выключен (dnsCronEnabled)' : 'неверное cron-выражение'} — DNS выполняется вместе с основным циклом`, undefined, `DNS schedule "${dnsSchedule}" not applied: ${settings.dnsCronEnabled === 'false' ? 'dns cycle disabled' : 'invalid cron expression'} — DNS runs with the main cycle`)
  }
}

export function schedulerState(): { running: boolean; schedule?: string; dnsRunning: boolean } {
  const s = cronTask
  const d = dnsCronTask
  return { running: !!s, dnsRunning: !!d }
}

const gsched = globalThis as unknown as { __hubSchedulerStarted?: boolean }

/** Однократный автостарт планировщика на процесс (bootstrap дашборда): после
 *  рестарта контейнера конвейер (правила + DNS-цикл) восстанавливается по
 *  сохранённым настройкам без необходимости пересохранять «Настройки». */
export function maybeStartScheduler(): void {
  if (gsched.__hubSchedulerStarted) return
  gsched.__hubSchedulerStarted = true
  void reinitScheduler().catch(() => undefined)
}

export { DATA_DIR, CACHE_DIR, EXPORTS_DIR }
export const repoPath = (p: string) => path.resolve(p)
export const fsApi = fs
