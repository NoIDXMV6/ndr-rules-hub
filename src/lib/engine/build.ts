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
  perSource: Record<string, { total: number; kept: number; droppedSid: number; droppedContent: number; droppedCompat: number }>
  sidsReplaced: Array<{ sid: number; newSid: number; source: string; keptRev: number; droppedRev: number; keptSource: string }>
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
      const winner = pickWinner(existing, { src, rule, kept: false }, p)
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
    lines.push(`# Всего правил: ${meta.stats.uniqueSids}`)
    lines.push(`# Дубликатов по SID устранено: ${meta.stats.duplicateBySid}`)
    lines.push(`# Дубликатов по содержимому устранено: ${meta.stats.duplicateByContent}`)
    lines.push(`# Отброшено несовместимых с Suricata: ${meta.stats.incompatibleDropped}`)
  }
  lines.push('# ─────────────────────────────────────────────────────────────')
  lines.push('')
  for (const r of rules) {
    lines.push(`# [${r.sourceName}]`)
    lines.push(r.raw)
  }
  return lines.join('\n') + '\n'
}
