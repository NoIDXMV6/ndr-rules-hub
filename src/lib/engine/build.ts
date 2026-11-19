// ─────────────────────────────────────────────────────────────────────────────
// Дедупликация, устранение конфликтов SID, сборка итогового файла
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'crypto'

export interface SourceRules {
  sourceId: string
  sourceName: string
  priority: number
  rules: Array<{
    sid: number
    rev: number
    raw: string
    action: string
    proto: string
    contentHash: string
    suricataOk: boolean
    compatNotes: string | null
    clsType?: string | null
  }>
}

export interface DedupPolicy {
  sidStrategy: 'highest-rev' | 'source-priority' | 'renumber-private'
  dropIncompatible: boolean
  dropDisabledMsg: boolean      // удалять правила с msg "DELETED"/"DISABLED"
  contentDedup: boolean         // удалять правила с одинаковым содержимым (hash), оставляя первое
  privateSidStart: number       // для стратегии renumber-private (стандарт: 1000000..1999999)
}

export interface BuildStats {
  totalInputRules: number
  uniqueSids: number
  duplicateBySid: number
  duplicateByContent: number
  incompatibleDropped: number
  renumbered: number
  conflictingRemoved?: number
  /** правил переписано под наивный парсер scirius (перенос sid в начало опций) */
  sanitizedForScirius?: number
  /** исключено выключенными категориями (раздел «Категории») */
  excludedByCategory?: number
  /** исключено пользовательскими выключателями отдельных правил (RuleOverride) */
  excludedByRule?: number
  /** архив tgz с файлами по источникам (если включён формат сборки file+tgz) */
  archive?: ArchiveInfo
  /** диф итогового набора vs предыдущей сборки: добавлено/изменено/удалено (null/нет — не с чем сравнивать) */
  changes?: { added: number; changed: number; removed: number }
  /** персональная сборка: подпись рабочего пространства — cron сравнивает с прошлой
   *  персональной сборкой и пропускает пересборку без изменений */
  workspaceSignature?: string
  /** персональная сборка: рабочее пространство (userId) и число источников */
  workspace?: { userId: string; sources: number }
  perSource: Record<string, { total: number; kept: number; droppedSid: number; droppedContent: number; droppedCompat: number }>
  sidsReplaced: Array<{ sid: number; newSid: number; source: string; keptRev: number; droppedRev: number; keptSource: string }>
}

export interface ArchiveInfo {
  fileName: string
  filePath: string
  sizeBytes: number
  files: Array<{ name: string; rules: number; sha256: string }>
}

export interface BuiltRule {
  sid: number
  rev: number
  raw: string
  sourceName: string
}

const DEFAULTS: DedupPolicy = {
  sidStrategy: 'highest-rev',
  dropIncompatible: false,
  dropDisabledMsg: true,
  contentDedup: true,
  // свободный clearndr-блок (Snort резервирует <1M, ET — 1..2.2M, Suricata — 2.2..2.3M)
  privateSidStart: 1_000_000_000,
}

export function hashRule(raw: string): string {
  // канонизируем: убираем sid/rev/msg/metadata/reference, схлопываем пробелы.
  // reference:* обязателен к снятию: Clear NDR считает «конфликтными» правила,
  // совпадающие после удаления sid и reference (Talos публикует один детект
  // дважды под разными sid и с разными ссылками) — без этого близнецы
  // переживают content-дедупликацию и роняют импорт «conflicting SID in same source».
  const canon = raw
    .replace(/\bsid\s*:\s*\d+\s*;/gi, '')
    .replace(/\brev\s*:\s*\d+\s*;/gi, '')
    .replace(/\bmsg\s*:\s*"[^"]*"\s*;/gi, '')
    .replace(/\bmetadata\s*:[^;]*(?:;|$)/gi, '')
    .replace(/\breference\s*:[^;]*(?:;|$)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return createHash('sha1').update(canon).digest('hex')
}

// ── Гейт «conflicting SID in same source» (Clear NDR) ───────────────────────
// Ключ конфликта установлен эмпирически на реальных импортах: конфликтуют
// правила, совпадающие после удаления опций sid и reference:*; различия
// rev/msg/metadata конфликт НЕ вызывают. Ключ СТРОЖЕ hashRule (msg/rev
// сохраняются) — это независимая страховка перед записью файла экспорта.
export function conflictKey(raw: string): string {
  return raw
    .replace(/\bsid\s*:\s*\d+\s*;/gi, '')
    .replace(/\breference\s*:[^;]*(?:;|$)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Найти пары правил, конфликтные для Clear NDR (совпадают без sid/reference) */
export function findConflictingDuplicates(rules: BuiltRule[]): Array<[BuiltRule, BuiltRule]> {
  const seen = new Map<string, BuiltRule>()
  const out: Array<[BuiltRule, BuiltRule]> = []
  for (const r of rules) {
    const k = conflictKey(r.raw)
    const first = seen.get(k)
    if (first) out.push([first, r])
    else seen.set(k, r)
  }
  return out
}

/** Финальная дедупликация конфликтных пар (сохраняется первое вхождение) */
export function dedupeConflicting(rules: BuiltRule[]): { rules: BuiltRule[]; removed: number } {
  const seen = new Set<string>()
  const out: BuiltRule[] = []
  for (const r of rules) {
    const k = conflictKey(r.raw)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return { rules: out, removed: rules.length - out.length }
}

// ── Совместимость с наивным парсером scirius (Clear NDR) ────────────────────
// Scirius (rules/models.py, get_rules) извлекает SID регэкспом r"sid *: *(\\d+)"
// и берёт ПЕРВОЕ совпадение в строке. Правила вида content:"clsid:33D9A761-…"
// дают ложное совпадение "sid:33" раньше настоящего sid:NNNN в конце правила —
// scirius считает два разных правила дубликатами и роняет импорт:
//   ValidationError: The source contains conflicting SID (33) in same source …
// Лечение: переносим настоящий sid:NNN; в начало списка опций правила — байты
// содержимого (content/msg) не трогаем, порядок опций Suricata свободный.
const SCIRIUS_GETSID_RE = /sid *: *(\d+)/

/** SID, который scirius «увидит» (первое совпадение регэкспа в строке) */
export function sciriusFirstSid(raw: string): number | null {
  const m = SCIRIUS_GETSID_RE.exec(raw)
  return m ? parseInt(m[1], 10) : null
}

/** Перенести опцию sid:NNN; в начало списка опций правила */
export function moveSidToFront(raw: string, sid: number): string {
  const open = raw.indexOf('(')
  const close = raw.lastIndexOf(')')
  if (open < 0 || close <= open + 1) return raw
  const head = raw.slice(0, open + 1)
  const opts = raw.slice(open + 1, close)
  const tail = raw.slice(close)
  const re = new RegExp(`(^|;)\\s*sid\\s*:\\s*${sid}\\s*;`)
  const m = re.exec(opts)
  if (!m) return raw
  const optStart = m.index + (m[1] ? 1 : 0) // срезаем ведущий ';'
  const optEnd = m.index + m[0].length
  const sidOpt = opts.slice(optStart, optEnd).trim()
  const rest = (opts.slice(0, m.index + (m[1] ? 1 : 0)) + ' ' + opts.slice(optEnd)).trim()
  const joined = rest ? `${sidOpt} ${rest}` : sidOpt
  return `${head}${joined}${tail}`
}

export interface SanitizeResult {
  rules: BuiltRule[]
  rewritten: number
  failed: Array<{ sid: number; raw: string }>
}

/**
 * Гарантировать, что первое совпадение регэкспа scirius — настоящий SID правила.
 * Переписываются только проблемные правила; результат повторно проверяется.
 */
export function sanitizeSciriusCompat(rules: BuiltRule[]): SanitizeResult {
  const out: BuiltRule[] = []
  let rewritten = 0
  const failed: Array<{ sid: number; raw: string }> = []
  for (const r of rules) {
    let raw = r.raw
    const first = sciriusFirstSid(raw)
    if (first !== null && first !== r.sid) {
      raw = moveSidToFront(raw, r.sid)
      rewritten++
    }
    const check = sciriusFirstSid(raw)
    if (check === null || check !== r.sid) {
      failed.push({ sid: r.sid, raw: raw.slice(0, 300) })
    }
    out.push({ ...r, raw })
  }
  return { rules: out, rewritten, failed }
}

/** Проверка итогового набора глазами scirius: уникальность «видимых» SID */
export function findSciriusSidConflicts(rules: BuiltRule[]): Map<number, number> {
  const seen = new Map<number, number>()
  for (const r of rules) {
    const sid = sciriusFirstSid(r.raw)
    if (sid === null) continue
    seen.set(sid, (seen.get(sid) ?? 0) + 1)
  }
  const dupes = new Map<number, number>()
  for (const [sid, n] of seen) if (n > 1) dupes.set(sid, n)
  return dupes
}

// ── Разбивка итогового набора по файлам-источникам (для tgz-архива) ─────────
const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

export function slugifySourceName(name: string): string {
  const translit = name.toLowerCase().split('').map((ch) => CYRILLIC_MAP[ch] ?? ch).join('')
  const slug = translit
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug || 'source'
}

export interface PerSourceFile {
  name: string
  sourceName: string
  content: string
  rules: number
}

/** Один .rules-файл на источник: при импорте tar в Clear NDR (datatype sigs)
 *  каждый файл становится отдельной категорией источника. */
export function renderPerSourceFiles(rules: BuiltRule[], meta: { generatedAt?: Date } = {}): PerSourceFile[] {
  const groups = new Map<string, BuiltRule[]>()
  for (const r of rules) {
    const arr = groups.get(r.sourceName)
    if (arr) arr.push(r)
    else groups.set(r.sourceName, [r])
  }
  const used = new Set<string>()
  const gen = (meta.generatedAt ?? new Date()).toISOString()
  const files: PerSourceFile[] = []
  for (const [sourceName, list] of groups) {
    let base = slugifySourceName(sourceName)
    let name = `${base}.rules`
    let i = 2
    while (used.has(name)) name = `${base}-${i++}.rules`
    used.add(name)
    list.sort((a, b) => a.sid - b.sid)
    const lines = [
      '# ─────────────────────────────────────────────────────────────',
      `# Источник: ${sourceName}`,
      `# Правил: ${list.length}`,
      `# Сгенерировано: ${gen}`,
      '# ─────────────────────────────────────────────────────────────',
      '',
      ...list.map((r) => r.raw),
    ]
    files.push({ name, sourceName, content: lines.join('\n') + '\n', rules: list.length })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return files
}

/** Ядро: слияние правил источников с дедупликацией и разрешением конфликтов SID */
export function mergeSources(
  sources: SourceRules[],
  policy: Partial<DedupPolicy> = {}
): { rules: BuiltRule[]; stats: BuildStats } {
  const p: DedupPolicy = { ...DEFAULTS, ...policy }
  const stats: BuildStats = {
    totalInputRules: 0,
    uniqueSids: 0,
    duplicateBySid: 0,
    duplicateByContent: 0,
    incompatibleDropped: 0,
    renumbered: 0,
    perSource: {},
    sidsReplaced: [],
  }

  // кандидаты по SID
  const bySid = new Map<number, { src: SourceRules; rule: SourceRules['rules'][number]; kept: boolean }>()
  const contentSeen = new Map<string, number>() // hash -> sid первого правила

  for (const src of sources) {
    const per = { total: 0, kept: 0, droppedSid: 0, droppedContent: 0, droppedCompat: 0 }
    for (const rule of src.rules) {
      per.total++
      stats.totalInputRules++

      if (p.dropIncompatible && !rule.suricataOk) {
        per.droppedCompat++
        stats.incompatibleDropped++
        continue
      }
      const msg = rule.raw.match(/\bmsg\s*:\s*"([^"]*)"/i)?.[1] ?? ''
      if (p.dropDisabledMsg && /^(DELETED|DISABLED|GPL DELETED)/i.test(msg)) {
        per.droppedSid++
        stats.duplicateBySid++
        continue
      }

      const existing = bySid.get(rule.sid)
      if (!existing) {
        bySid.set(rule.sid, { src, rule, kept: true })
        per.kept++
        continue
      }
      // конфликт SID — выбираем победителя
      const winner = pickWinner(existing, { src, rule }, p)
      stats.duplicateBySid++
      if (winner !== existing) {
        existing.kept = false
        bySid.set(rule.sid, { src, rule, kept: true })
        per.kept++
        const loserSrc = stats.perSource[existing.src.sourceName]
        if (loserSrc) {
          loserSrc.kept--
          loserSrc.droppedSid++
        }
        if (winner.rule.sid !== undefined) {
          stats.sidsReplaced.push({
            sid: rule.sid,
            newSid: rule.sid,
            source: src.sourceName,
            keptRev: rule.rev,
            droppedRev: existing.rule.rev,
            keptSource: src.sourceName,
          })
        }
      } else {
        per.droppedSid++
      }
    }
    stats.perSource[src.sourceName] = per
  }

  // дедупликация по содержимому
  const result: BuiltRule[] = []
  for (const [sid, entry] of bySid) {
    if (!entry.kept) continue
    if (p.contentDedup) {
      const first = contentSeen.get(entry.rule.contentHash)
      if (first !== undefined) {
        stats.duplicateByContent++
        const per = stats.perSource[entry.src.sourceName]
        if (per) {
          per.kept--
          per.droppedContent++
        }
        continue
      }
      contentSeen.set(entry.rule.contentHash, sid)
    }
    result.push({ sid, rev: entry.rule.rev, raw: entry.rule.raw, sourceName: entry.src.sourceName })
  }

  // перенумерация приватных SID при стратегии renumber-private
  let nextPrivate = p.privateSidStart
  const usedPrivate = new Set<number>()
  if (p.sidStrategy === 'renumber-private') {
    for (const r of result) {
      if (r.sid >= p.privateSidStart && r.sid < p.privateSidStart + 1000000) usedPrivate.add(r.sid)
    }
  }
  if (p.sidStrategy === 'renumber-private') {
    for (const r of result) {
      if (r.sid < p.privateSidStart || r.sid >= p.privateSidStart + 1000000) {
        while (usedPrivate.has(nextPrivate)) nextPrivate++
        usedPrivate.add(nextPrivate)
        r.raw = replaceSid(r.raw, nextPrivate)
        r.sid = nextPrivate
        stats.renumbered++
        nextPrivate++
      }
    }
  }

  result.sort((a, b) => a.sid - b.sid)
  stats.uniqueSids = result.length
  return { rules: result, stats }
}

function pickWinner(
  a: { src: SourceRules; rule: SourceRules['rules'][number] },
  b: { src: SourceRules; rule: SourceRules['rules'][number] },
  p: DedupPolicy
): { src: SourceRules; rule: SourceRules['rules'][number] } {
  if (p.sidStrategy === 'source-priority') {
    if (a.src.priority !== b.src.priority) return a.src.priority <= b.src.priority ? a : b
    return a.rule.rev >= b.rule.rev ? a : b
  }
  // highest-rev (по умолчанию), при равенстве — приоритет источника
  if (a.rule.rev !== b.rule.rev) return a.rule.rev > b.rule.rev ? a : b
  return a.src.priority <= b.src.priority ? a : b
}

export function replaceSid(raw: string, newSid: number): string {
  return raw.replace(/\bsid\s*:\s*\d+\s*;/, `sid:${newSid};`)
}

/** Собрать текст итогового файла suricata.rules с заголовком */
export function renderFinalFile(
  rules: BuiltRule[],
  meta: { generatedAt?: Date; sources?: string[]; stats?: BuildStats }
): string {
  const gen = (meta.generatedAt ?? new Date()).toISOString()
  const lines: string[] = []
  lines.push('# ─────────────────────────────────────────────────────────────')
  lines.push('# Объединённый набор правил для Clear NDR / Suricata')
  lines.push(`# Сгенерировано: ${gen}`)
  lines.push(`# Источники: ${(meta.sources ?? []).join(', ') || '-'}`)
  if (meta.stats) {
    // фактическое число правил в файле (после всех дедупликаций), а не счётчик слияния
    lines.push(`# Всего правил: ${rules.length}`)
    lines.push(`# Дубликатов по SID устранено: ${meta.stats.duplicateBySid}`)
    lines.push(`# Дубликатов по содержимому устранено: ${meta.stats.duplicateByContent}`)
    lines.push(`# Отброшено несовместимых с Suricata: ${meta.stats.incompatibleDropped}`)
    if (meta.stats.conflictingRemoved) lines.push(`# Конфликтных близнецов Clear NDR удалено: ${meta.stats.conflictingRemoved}`)
    if (meta.stats.sanitizedForScirius) lines.push(`# Адаптировано под парсер Clear NDR (sid перенесён в начало опций): ${meta.stats.sanitizedForScirius}`)
    if (meta.stats.excludedByCategory) lines.push(`# Исключено выключенными категориями: ${meta.stats.excludedByCategory}`)
    if (meta.stats.excludedByRule) lines.push(`# Исключено вручную отключёнными правилами: ${meta.stats.excludedByRule}`)
    if (meta.stats.archive) lines.push(`# Архив по источникам: ${meta.stats.archive.fileName}`)
  }
  lines.push('# ─────────────────────────────────────────────────────────────')
  lines.push('')
  for (const r of rules) {
    lines.push(`# [${r.sourceName}]`)
    lines.push(r.raw)
  }
  return lines.join('\n') + '\n'
}
