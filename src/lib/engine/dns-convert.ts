// ─────────────────────────────────────────────────────────────────────────────
// Конвертация «не-доменных» строк хостлистов в правила Suricata.
//
// Хостлисты нередко содержат IP-адреса, CIDR, URL и regex — разбиратель
// parseDomainList раньше просто считал их «skipped» и терял. Теперь строки
// собираются (collectOthers) и при загрузке DNS-источника конвертируются:
//   IP/CIDR → IP-правила чанками по 500 адресов (convertIpList);
//   URL     → HTTP-правила host+uri (convertUrlList);
//   regex   → pcre-правила на http.uri.raw.
// Файл data/domains/ndr/src-<dnsSourceId>.rules и ВЫКЛЮЧЕННЫЙ источник
// «DNS-конвертация: …» (включается осознанно в «Правила → Источники», как и
// источники дампа «Дамп фильтрации: …»). SID-блоки выдаются без перекрытий
// из счётчика в Setting (dnsConvSidAlloc), диапазон 1 900 000+ — после блоков
// дампа (1,2–1,5 млн) и RST Threat Feed (1,6–1,8 млн).
// ─────────────────────────────────────────────────────────────────────────────
import path from 'path'
import { promises as fs } from 'fs'
import { db } from '@/lib/db'
import { convertIpList, convertUrlList, type ConvertedRule } from './convert'
import { isValidDumpIp, isValidDumpCidr, isValidDumpRegex, normalizeDumpUrl, type DumpIndicatorKind } from './dns-import'
import { DATA_DIR } from './fetcher'

/** Каталог NDR-файлов конвертации DNS-источников (data/domains/ndr — как у дампа) */
export const DNS_CONVERT_DIR = path.join(DATA_DIR, 'domains', 'ndr')

/** Блок SID на один источник-конвертер (40 000 правил) */
const SID_BLOCK = 40_000
/** Первый SID-блок конвертации хостлистов (после 1,2–1,8 млн дампа/RST) */
const SID_FIRST = 1_900_000
const SETTING_KEY = 'dnsConvSidAlloc'

export type HostlistOtherKind = 'ip' | 'cidr' | 'url' | 'regex'

/** Классифицировать строку-не-домен из хостлиста (или null, если это мусор) */
export function classifyHostlistOther(raw: string): HostlistOtherKind | null {
  const t = (raw ?? '').trim().toLowerCase()
  if (!t || t.length > 500) return null
  if (isValidDumpIp(t)) return 'ip'
  if (isValidDumpCidr(t)) return 'cidr'
  // URL: со схемой или путём; голый домен (example.com) — не URL, а обычный
  // домен, который уже разобран parseDomainList (иначе adguard-списки с голыми
  // доменами давали бы бессмысленные http-правила «http://example.com»)
  if (normalizeDumpUrl(t) && (t.startsWith('http') || t.includes('/'))) return 'url'
  // IP-подобные строки (включая приватные/битые октеты) — НЕ regex: точка —
  // метасимвол, и «10.0.0.1» компилируется как шаблон, но правилом не является
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(t)) return null
  // regex: компилируется И содержит метасимволы помимо точки. Точка есть в любом
  // домене/IP («example.com» компилируется как шаблон, но правилом не является)
  if (/[\\^$*+?()[\]{}|]/.test(t) && isValidDumpRegex(t)) return 'regex'
  return null
}

/** Правила по типу: IP/CIDR чанками, URL построчно, regex — pcre */
export function generateHostlistRules(kind: HostlistOtherKind, entries: string[], sidStart: number): ConvertedRule[] {
  if (kind === 'ip') {
    // CIDR живёт в одном бакете с IP: convertIpList понимает префиксы
    return convertIpList(entries.join('\n'), {
      sidStart,
      action: 'drop',
      proto: 'ip',
      msgPrefix: 'DNS-LIST known unwanted IP/CIDR',
      perRule: 500,
      maxRules: SID_BLOCK / 2,
      classtype: 'policy-violation',
    }).map((r) => ({ ...r, raw: r.raw.replace('metadata:ruleset converted-feed', 'metadata:ruleset dns-convert') }))
  }
  if (kind === 'url') {
    const normalized = entries.map((u) => {
      const rest = u.replace(/^https?:\/\//i, '')
      return rest.includes('/') ? u : `${u}/`
    })
    return convertUrlList(normalized.join('\n'), {
      sidStart,
      action: 'drop',
      msgPrefix: 'DNS-LIST known unwanted URL',
      maxRules: SID_BLOCK / 4,
      classtype: 'policy-violation',
    }).map((r) => ({ ...r, raw: r.raw.replace('metadata:ruleset converted-feed', 'metadata:ruleset dns-convert') }))
  }
  // regex → pcre-правила на http.uri.raw (аналог генератора дампа)
  const rules: ConvertedRule[] = []
  let sid = sidStart
  for (const p of entries) {
    if (rules.length >= SID_BLOCK / 4) break
    const esc = p.replace(/"/g, '\\"').replace(/\//g, '\\/')
    rules.push({
      sid,
      rev: 1,
      suricataOk: true,
      compatNotes: null,
      raw:
        `drop http $HOME_NET any -> $EXTERNAL_NET any ` +
        `(msg:"DNS-LIST unwanted URL pattern (regex)"; flow:to_server,established; http.uri.raw; pcre:"/${esc}/i"; classtype:policy-violation; metadata:ruleset dns-convert; sid:${sid}; rev:1;)`,
    })
    sid++
  }
  return rules
}

/**
 * Выдать SID-блок для нового источника-конвертера (Setting dnsConvSidAlloc —
 * JSON { next }). Идемпотентно по отношению к отсутствию настройки.
 */
export async function allocateHostlistSidBlock(): Promise<number> {
  let next = SID_FIRST
  try {
    const row = await db.setting.findUnique({ where: { key: SETTING_KEY } })
    if (row) {
      const parsed = JSON.parse(row.value) as { next?: number }
      if (typeof parsed.next === 'number' && parsed.next >= SID_FIRST) next = parsed.next
    }
  } catch { /* нет/битая настройка — начнём с первого блока */ }
  await db.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify({ next: next + SID_BLOCK }) },
    update: { value: JSON.stringify({ next: next + SID_BLOCK }) },
  })
  return next
}

export interface HostlistConversionResult {
  /** по видам: сколько строк классифицировано (до дедупликации) */
  counts: Record<HostlistOtherKind, number>
  rules: number
  /** SID-блок файла (совпадает с extraJson источника-конвертера) */
  sidStart: number
  /** усечено ли (лимит правил на источник — SID_BLOCK/… по видам) */
  truncated: boolean
  sourceName: string | null
}

function converterNotes(): { notes: string; notesEn: string } {
  return {
    notes: 'Автогенерированный источник из строк-не-доменов DNS-источника (IP/CIDR → IP-правила, URL → HTTP-правила, regex → pcre). Файл data/domains/ndr/src-<id>.rules пересоздаётся при каждой загрузке DNS-источника; SID-блок — в шапке файла.',
    notesEn: 'Auto-generated source from non-domain lines of a DNS source (IP/CIDR → IP rules, URL → HTTP rules, regex → pcre). The file data/domains/ndr/src-<id>.rules is regenerated on every DNS source fetch; the SID block is in the file header.',
  }
}

function hostlistRulesHeader(parts: Array<{ kind: DumpIndicatorKind | 'cidr'; count: number; rules: number }>, sidStart: number, dnsName: string): string {
  const gen = new Date().toISOString()
  const rows = parts.map((p) => `#   ${p.kind}: ${p.count} индикаторов → ${p.rules} правил`).join('\n')
  return [
    '# ─────────────────────────────────────────────────────────────',
    `# Конвертация строк-не-доменов DNS-источника «${dnsName}»`,
    `# Non-domain lines of DNS source "${dnsName}" converted to Suricata rules`,
    `# Сгенерировано / Generated: ${gen}`,
    `# SID-блок / SID block: ${sidStart}+`,
    rows,
    '# Источник создан выключенным — включите его в «Правила → Источники».',
    '# The source is created disabled — enable it under "Rules → Sources".',
    '# ─────────────────────────────────────────────────────────────',
    '',
  ].join('\n')
}

/**
 * Конвертировать «other»-строки DNS-источника в правила Suricata: файл
 * data/domains/ndr/src-<id>.rules + выключенный NDR-источник «DNS-конвертация: …»
 * (SID-блок закрепляется за источником в extraJson). Вызывать после parseDomainList
 * с collectOthers: true. Если строк-не-доменов нет — ничего не делает (null).
 */
export async function convertHostlistOthers(
  dnsSource: { id: string; name: string },
  others: string[],
): Promise<HostlistConversionResult | null> {
  const buckets: Record<HostlistOtherKind, Set<string>> = { ip: new Set(), cidr: new Set(), url: new Set(), regex: new Set() }
  for (const raw of others) {
    const kind = classifyHostlistOther(raw)
    if (!kind) continue
    const value = kind === 'url' ? normalizeDumpUrl(raw.trim().toLowerCase())!.url : raw.trim().toLowerCase()
    buckets[kind].add(value)
  }
  const ipEntries = [...buckets.ip, ...buckets.cidr]
  const totalOther = ipEntries.length + buckets.url.size + buckets.regex.size
  if (totalOther === 0) return null

  // источник-конвертер: ищем по dnsSourceId в extraJson (имя DNS-источника могло смениться)
  let src = await db.source.findFirst({ where: { extraJson: { contains: `"dnsSourceId":"${dnsSource.id}"` } } })
  let sidStart: number
  if (src?.extraJson) {
    try {
      const extra = JSON.parse(src.extraJson) as { sidStart?: number }
      if (typeof extra.sidStart === 'number') sidStart = extra.sidStart
      else sidStart = await allocateHostlistSidBlock()
    } catch { sidStart = await allocateHostlistSidBlock() }
  } else {
    sidStart = await allocateHostlistSidBlock()
  }

  const rules: ConvertedRule[] = []
  const parts: Array<{ kind: DumpIndicatorKind | 'cidr'; count: number; rules: number }> = []
  let truncated = false
  const kinds: Array<{ kind: HostlistOtherKind; entries: string[] }> = [
    { kind: 'ip', entries: ipEntries },
    { kind: 'url', entries: [...buckets.url] },
    { kind: 'regex', entries: [...buckets.regex] },
  ]
  for (const { kind, entries } of kinds) {
    if (entries.length === 0) continue
    const generated = generateHostlistRules(kind, entries, sidStart + rules.length)
    if (generated.length < entries.length && (kind === 'url' || kind === 'regex')) truncated = true
    parts.push({ kind, count: entries.length, rules: generated.length })
    rules.push(...generated)
  }
  if (rules.length === 0) return null

  const dir = DNS_CONVERT_DIR
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `src-${dnsSource.id}.rules`)
  const body = rules.map((r) => r.raw).join('\n') + '\n'
  await fs.writeFile(filePath, hostlistRulesHeader(parts, sidStart, dnsSource.name) + body, 'utf8')

  const notes = converterNotes()
  const name = `DNS-конвертация: ${dnsSource.name}`.slice(0, 120)
  const extraJson = JSON.stringify({ dnsSourceId: dnsSource.id, sidStart })
  if (!src) {
    src = await db.source.create({
      data: {
        name, category: 'ruleset', kind: 'local', url: filePath, format: 'suricata',
        enabled: false, priority: 150, badge: 'converter', builtin: false,
        notes: notes.notes, notesEn: notes.notesEn, extraJson,
      },
    })
  } else {
    src = await db.source.update({ where: { id: src.id }, data: { name, url: filePath, extraJson, deletedAt: null } })
  }
  return {
    counts: { ip: buckets.ip.size, cidr: buckets.cidr.size, url: buckets.url.size, regex: buckets.regex.size },
    rules: rules.length,
    sidStart,
    truncated,
    sourceName: src.name,
  }
}
