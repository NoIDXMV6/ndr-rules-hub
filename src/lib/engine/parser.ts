// ─────────────────────────────────────────────────────────────────────────────
// Парсер правил Snort 2 / Snort 3 / Suricata
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedRule {
  action: string
  proto: string
  srcIp: string
  srcPort: string
  dstIp: string
  dstPort: string
  sid: number | null
  rev: number
  msg: string | null
  classtype: string | null
  raw: string
  suricataOk: boolean
  compatNotes: string | null
  format: 'snort2' | 'snort3' | 'suricata' | 'unknown'
}

const RULE_RE =
  /^\s*(alert|drop|pass|sdrop|reject|block|rewrite|log|activate|dynamic)\s+([a-zA-Z0-9_]+)\s+(?:(\S+)\s+(\S+)\s*(->|<>)\s*(\S+)\s+(\S+)\s+)?\((.*)\)\s*;?\s*$/

const SNORT2_INCOMPAT: Array<[RegExp, string]> = [
  [/\bpreproc\s*:/, 'preproc (препроцессор Snort 2)'],
  [/\breact\s*[:;]/, 'react (Snort 2)'],
  [/\bresp\s*[:;]/, 'resp (Snort 2)'],
  [/\brawbytes\b/, 'rawbytes (Snort 2)'],
  [/\basn1\s*:/, 'asn1 (Snort 2)'],
  [/\bdce_iface\b/, 'dce_iface (SMB-препроцессор Snort 2)'],
  [/\bdce_stub_data\b/, 'dce_stub_data (SMB-препроцессор Snort 2)'],
]
const SNORT3_INCOMPAT: Array<[RegExp, string]> = [
  [/\bkeystore\s*[:;]/, 'keystore (Snort 3)'],
  [/\bpkt_trace\b/, 'pkt_trace (Snort 3)'],
  [/\bto_utf6\b/, 'to_utf6 (Snort 3)'],
  [/\bsnort\s*:\s*"/, 'snort: (Snort 3)'],
  [/\battribute_table\b/, 'attribute_table (Snort 3)'],
]

export function extractSid(raw: string): number | null {
  const m = raw.match(/\bsid\s*:\s*(\d+)\s*;/)
  return m ? parseInt(m[1], 10) : null
}

export function extractRev(raw: string): number {
  const m = raw.match(/\brev\s*:\s*(\d+)\s*;/)
  return m ? parseInt(m[1], 10) : 0
}

function extractOption(raw: string, opt: string): string | null {
  const quoted = raw.match(new RegExp(`\\b${opt}\\s*:\\s*"([^"]*)"`, 'i'))
  if (quoted) return quoted[1]
  const plain = raw.match(new RegExp(`\\b${opt}\\s*:\\s*([^;\\s]+)`, 'i'))
  return plain ? plain[1] : null
}

export function checkSuricataCompat(raw: string): { ok: boolean; notes: string | null } {
  const problems: string[] = []
  for (const [re, label] of SNORT2_INCOMPAT) if (re.test(raw)) problems.push(label)
  for (const [re, label] of SNORT3_INCOMPAT) if (re.test(raw)) problems.push(label)
  if (/^\s*(activate|dynamic)\b/.test(raw)) problems.push('действие activate/dynamic (Snort 2)')
  if (problems.length === 0) return { ok: true, notes: null }
  return { ok: false, notes: problems.join('; ') }
}

export function detectFormat(raw: string): 'snort2' | 'snort3' | 'suricata' | 'unknown' {
  if (/\b(preproc|rawbytes|asn1:)\b/.test(raw)) return 'snort2'
  if (/\b(sticky_buffer|bsize|isdataat|http\.uri|http\.host|http\.user_agent|dns\.query|tls\.sni|ja3\.|app-layer)\b/.test(raw))
    return 'snort3'
  if (/\b(app-layer-protocol|flowint|xbits|dataset|http\.uri\.buffer)\b/.test(raw)) return 'suricata'
  if (/\b(http_uri|http_header|http_client_body|file_data|byte_test|pcre|content)\b/.test(raw)) return 'snort2'
  return 'unknown'
}

/** Полный разбор одной строки правила; null, если это не правило. */
export function parseRuleLine(rawLine: string): ParsedRule | null {
  const line = rawLine.trim()
  if (!line || line.startsWith('#')) return null
  const m = line.match(RULE_RE)
  if (!m) return null
  const [, action, proto, srcIp = 'any', srcPort = 'any', , dstIp = 'any', dstPort = 'any'] = m
  const compat = checkSuricataCompat(line)
  return {
    action,
    proto,
    srcIp,
    srcPort,
    dstIp,
    dstPort,
    sid: extractSid(line),
    rev: extractRev(line),
    msg: extractOption(line, 'msg'),
    classtype: extractOption(line, 'classtype'),
    raw: line,
    suricataOk: compat.ok,
    compatNotes: compat.notes,
    format: detectFormat(line),
  }
}

/**
 * Разобрать текстовый поток правил. Строка, которая сама парсится как правило,
 * выдаётся сразу; иначе накапливаем (многострочные правила), пока склеенный
 * буфер не станет валидным правилом. Скобки внутри pcre-выражений не ломают поток.
 */
export function parseRuleText(text: string): ParsedRule[] {
  const out: ParsedRule[] = []
  const ACTION_START = /^\s*(alert|drop|pass|sdrop|reject|block|rewrite|log|activate|dynamic)\b/
  let buf: string[] = []

  const parens = (s: string) => {
    let d = 0
    for (const ch of s) {
      if (ch === '(') d++
      else if (ch === ')') d--
    }
    return d
  }

  const tryEmitJoined = () => {
    if (!buf.length) return true
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim()
    const p = parseRuleLine(joined)
    if (p) {
      out.push(p)
      buf = []
      return true
    }
    return false
  }

  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim()
    if (!t || t.startsWith('#')) continue

    if (buf.length === 0) {
      if (!ACTION_START.test(t)) continue
      const direct = parseRuleLine(t)
      if (direct) {
        out.push(direct)
      } else {
        buf.push(t)
        if (buf.join(' ').length > 4000) buf = [] // защита от «расползающихся» буферов
      }
      continue
    }

    // копим многострочное правило
    buf.push(t)
    const joinedParses = tryEmitJoined()
    if (!joinedParses && ACTION_START.test(t)) {
      // новое правило началось, а предыдущее так и не собралось — сбрасываем буфер
      buf = [t]
      const direct = parseRuleLine(t)
      if (direct) {
        out.push(direct)
        buf = []
      }
    }
  }
  return out
}
