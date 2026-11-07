// ─────────────────────────────────────────────────────────────────────────────
// Конвертеры: списки индикаторов (IP / домены / URL) → правила Suricata
// ─────────────────────────────────────────────────────────────────────────────

export interface ConvertOptions {
  sidStart: number        // начало приватного диапазона SID
  action?: string         // alert | drop (по умолчанию alert)
  proto?: string          // для ip-list (по умолчанию tcp)
  msgPrefix?: string      // префикс сообщения
  perRule?: number        // сколько индикаторов в одном правиле (для ip-list)
  maxRules?: number       // предохранитель: макс. число правил
  classtype?: string
}

export interface ConvertedRule {
  sid: number
  rev: number
  raw: string
  suricataOk: boolean
  compatNotes: string | null
}

const DEFAULT_HEADER_IP = 'alert tcp any any -> $converted any'
const LOCAL_NET = '$HOME_NET'
const EXTERNAL_NET = '$EXTERNAL_NET'

function extractIp(line: string): string | null {
  // поддержка форматов: 1.2.3.4 | 1.2.3.4/32 | 1.2.3.4 # comment | «1.2.3.4»,5
  const m = line.match(/^\s*#?(\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?)\s*(?:,|#|$)/)
  return m ? m[1] : null
}

function extractCidr(line: string): string | null {
  const m = line.match(/^\s*[;#]?\s*((?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?)\s*(?:,|;|#|$)/)
  return m ? m[1] : null
}

function extractDomain(line: string): string | null {
  const m = line.match(/^\s*(?:#|;)?\s*([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+)\s*(?:,|#|$)/)
  return m ? m[1] : null
}

function extractUrl(line: string): string | null {
  const m = line.match(/^\s*(?:https?:\/\/)?([a-zA-Z0-9.-]+)(\/[^\s,]*)\s*(?:,|#|$)/)
  return m ? `${m[1]}${m[2]}` : null
}

/** Правило для диапазона IP (один SID на чанк) */
function ipChunkRule(ips: string[], sid: number, opts: Required<Pick<ConvertOptions, 'action' | 'msgPrefix' | 'proto' | 'classtype'>>): ConvertedRule {
  const list = ips.join(',')
  const cls = opts.classtype ? ` classtype:${opts.classtype};` : ''
  const raw =
    `${opts.action} ${opts.proto} ${LOCAL_NET} any -> [${list}] any ` +
    `(msg:"${opts.msgPrefix} ${ips.length} indicator(s)"; flow:to_server,established;${cls} metadata:ruleset converted-feed; sid:${sid}; rev:1;)`
  return { sid, rev: 1, raw, suricataOk: true, compatNotes: null }
}

/** Конвертация списка IP/CIDR → правила Suricata */
export function convertIpList(text: string, opts: ConvertOptions): ConvertedRule[] {
  const action = opts.action ?? 'alert'
  const proto = opts.proto ?? 'tcp'
  const msgPrefix = opts.msgPrefix ?? 'CONVERTED-IP known malicious IP'
  const perRule = opts.perRule ?? 500
  const maxRules = opts.maxRules ?? 20000
  const classtype = opts.classtype ?? 'trojan-activity'

  const entries: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('//')) continue
    const ip = extractCidr(t)
    if (ip) entries.push(ip)
  }
  const rules: ConvertedRule[] = []
  let sid = opts.sidStart
  for (let i = 0; i < entries.length && rules.length < maxRules; i += perRule) {
    const chunk = entries.slice(i, i + perRule)
    rules.push(ipChunkRule(chunk, sid, { action, msgPrefix, proto, classtype }))
    sid++
  }
  return rules
}

/** Конвертация списка доменов → DNS-правила (1 правило = 1 домен, с предохранителем) */
export function convertDomainList(text: string, opts: ConvertOptions): ConvertedRule[] {
  const action = opts.action ?? 'alert'
  const msgPrefix = opts.msgPrefix ?? 'CONVERTED-DNS known malicious domain'
  const maxRules = opts.maxRules ?? 10000
  const classtype = opts.classtype ?? 'trojan-activity'
  const rules: ConvertedRule[] = []
  const seen = new Set<string>()
  let sid = opts.sidStart
  for (const line of text.split(/\r?\n/)) {
    if (rules.length >= maxRules) break
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('//')) continue
    const d = extractDomain(t)
    if (!d || seen.has(d)) continue
    seen.add(d)
    const raw =
      `${action} dns ${LOCAL_NET} any -> ${EXTERNAL_NET} any ` +
      `(msg:"${msgPrefix}: ${d}"; dns.query; content:"${d}"; nocase; endswith; classtype:${classtype}; metadata:ruleset converted-feed; sid:${sid}; rev:1;)`
    rules.push({ sid, rev: 1, raw, suricataOk: true, compatNotes: null })
    sid++
  }
  return rules
}

/** Конвертация списка URL → HTTP-правила (1 правило = 1 URL, с предохранителем) */
export function convertUrlList(text: string, opts: ConvertOptions): ConvertedRule[] {
  const action = opts.action ?? 'alert'
  const msgPrefix = opts.msgPrefix ?? 'CONVERTED-HTTP known malicious URL'
  const maxRules = opts.maxRules ?? 10000
  const classtype = opts.classtype ?? 'trojan-activity'
  const rules: ConvertedRule[] = []
  const seen = new Set<string>()
  let sid = opts.sidStart
  for (const line of text.split(/\r?\n/)) {
    if (rules.length >= maxRules) break
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('//')) continue
    const u = extractUrl(t)
    if (!u || seen.has(u)) continue
    seen.add(u)
    const slash = u.indexOf('/')
    const host = slash === -1 ? u : u.slice(0, slash)
    const uri = slash === -1 ? '/' : u.slice(slash)
    const raw =
      `${action} http ${LOCAL_NET} any -> ${EXTERNAL_NET} any ` +
      `(msg:"${msgPrefix}: ${host}${uri === '/' ? '' : uri.slice(0, 60)}"; flow:to_server,established; http.host; content:"${host}"; startswith; endswith; http.uri; content:"${uri === '/' ? '/' : uri.replace(/"/g, '')}"; startswith; classtype:${classtype}; metadata:ruleset converted-feed; sid:${sid}; rev:1;)`
    rules.push({ sid, rev: 1, raw, suricataOk: true, compatNotes: null })
    sid++
  }
  return rules
}
