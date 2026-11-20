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

/** Правило для диапазона IP (один SID на чанк); metadata — тег набора в metadata:ruleset */
function ipChunkRule(ips: string[], sid: number, opts: Required<Pick<ConvertOptions, 'action' | 'msgPrefix' | 'proto' | 'classtype'>>, metadata = 'converted-feed'): ConvertedRule {
  const list = ips.join(',')
  const cls = opts.classtype ? ` classtype:${opts.classtype};` : ''
  const raw =
    `${opts.action} ${opts.proto} ${LOCAL_NET} any -> [${list}] any ` +
    `(msg:"${opts.msgPrefix} ${ips.length} indicator(s)"; flow:to_server,established;${cls} metadata:ruleset ${metadata}; sid:${sid}; rev:1;)`
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

// ─────────────────────────────────────────────────────────────────────────────
// Zeek intel (TSV) → правила Suricata. Формат файла .intel:
//   #fields  indicator  indicator_type  meta.source  meta.do_notice  meta.desc
//   1.2.3.4\tIntel::ADDR\tCobaltStrike-IP\tF\tCobaltStrike
// Поддерживаются Intel::ADDR / Intel::IP (→ IP-правила), Intel::DOMAIN /
// Intel::DNS (→ DNS-правила), Intel::URL (→ HTTP-правила); прочие типы
// (хэши, EMAIL, USER_NAME…) в сетевые правила не конвертируются — пропускаются.
// ─────────────────────────────────────────────────────────────────────────────

function safeIndicator(s: string): string | null {
  // значения индикаторов идут в content-строку правила: кавычки/обратные слэши/
  // управляющие символы недопустимы; пробельные значения не имеют смысла
  const t = s.trim()
  if (!t || t.length > 400) return null
  if (/["\\\x00-\x1f]/.test(t)) return null
  return t
}

const ZEEK_TYPE_LABEL: Record<string, string> = {
  'intel::addr': 'IP',
  'intel::ip': 'IP',
  'intel::domain': 'domain',
  'intel::dns': 'domain',
  'intel::url': 'URL',
}

export function convertZeekIntel(text: string, opts: ConvertOptions): ConvertedRule[] {
  const action = opts.action ?? 'alert'
  const msgPrefix = opts.msgPrefix ?? 'ZEEK-INTEL'
  const perRule = opts.perRule ?? 500
  const maxRules = opts.maxRules ?? 10000
  const classtype = opts.classtype ?? 'trojan-activity'

  const ips: string[] = []
  const domains: string[] = []
  const urls: string[] = []
  const seen = new Set<string>()

  for (const line of text.split(/\r?\n/)) {
    if (urls.length + domains.length + ips.length > maxRules * 3) break // предохранитель от гигантских файлов
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const cols = t.split('\t').map((c) => c.trim())
    const indicator = safeIndicator(cols[0] ?? '')
    if (!indicator) continue
    // Intel::ADDR → 'ADDR' (регистр у фидов разный — приводим к нижнему)
    const ztype = (cols[1] ?? '').toLowerCase().replace(/^intel::/, '')
    const label = ZEEK_TYPE_LABEL[cols[1]?.toLowerCase() ?? ''] ?? null
    if (label === 'IP' || (!cols[1] && extractCidr(indicator))) {
      const ip = extractCidr(indicator)
      if (!ip) continue
      const key = `ip:${ip}`
      if (!seen.has(key)) { seen.add(key); ips.push(ip) }
    } else if (label === 'domain' || (!cols[1] && ztype === '' && extractDomain(indicator))) {
      const d = extractDomain(indicator)
      if (!d) continue
      const key = `d:${d}`
      if (!seen.has(key)) { seen.add(key); domains.push(d) }
    } else if (label === 'URL') {
      const u = extractUrl(indicator)
      if (u) {
        const key = `u:${u}`
        if (!seen.has(key)) { seen.add(key); urls.push(u) }
      } else {
        // URL без пути (http://evil.com) — падаем на домен, чтобы индикатор не терялся
        const d = extractDomain(indicator.replace(/^https?:\/\//i, ''))
        if (!d) continue
        const key = `d:${d}`
        if (!seen.has(key)) { seen.add(key); domains.push(d) }
      }
    }
  }

  const rules: ConvertedRule[] = []
  // IP-индикаторы — чанками (как convertIpList)
  for (let i = 0; i < ips.length && rules.length < maxRules; i += perRule) {
    rules.push(ipChunkRule(ips.slice(i, i + perRule), opts.sidStart + rules.length, { action, msgPrefix, proto: opts.proto ?? 'ip', classtype }, 'zeek-intel'))
  }
  // домены и URL — по одному SID
  for (const d of domains) {
    if (rules.length >= maxRules) break
    const sid = opts.sidStart + rules.length
    rules.push({ sid, rev: 1, suricataOk: true, compatNotes: null,
      raw: `${action} dns ${LOCAL_NET} any -> ${EXTERNAL_NET} any (msg:"${msgPrefix} domain: ${d.slice(0, 100)}"; dns.query; content:"${d}"; nocase; endswith; classtype:${classtype}; metadata:ruleset zeek-intel; sid:${sid}; rev:1;)` })
  }
  for (const u of urls) {
    if (rules.length >= maxRules) break
    const slash = u.indexOf('/')
    const host = slash === -1 ? u : u.slice(0, slash)
    const uri = slash === -1 ? '/' : u.slice(slash)
    const sid = opts.sidStart + rules.length
    rules.push({ sid, rev: 1, suricataOk: true, compatNotes: null,
      raw: `${action} http ${LOCAL_NET} any -> ${EXTERNAL_NET} any (msg:"${msgPrefix} URL: ${u.slice(0, 100)}"; flow:to_server,established; http.host; content:"${host}"; startswith; endswith; http.uri; content:"${uri}"; startswith; classtype:${classtype}; metadata:ruleset zeek-intel; sid:${sid}; rev:1;)` })
  }
  return rules
}

// ─────────────────────────────────────────────────────────────────────────────
// MISP attributes (JSON) → правила Suricata.
// Вход: ответ /attributes/restSearch.json (или экспорт атрибутов события):
//   { "response": { "Attribute": [ {type, value, category, comment…}, … ] } }
//   { "response": [ … ] }   — новые версии MISP
//   [ … ] / { "Attribute": [ … ] } — тоже разбираются
// Сетевые индикаторы конвертируются: ip-* → IP-правила (чанками), domain /
// hostname → DNS-правила, url / uri → HTTP-правила. Не-сетевые типы
// (md5/sha256, filename|md5, regkey, email, ja3…) пропускаются.
// ─────────────────────────────────────────────────────────────────────────────

function mispAttrs(text: string): { type: string; value: string; comment: string }[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  type RawAttr = { type?: unknown; value?: unknown; comment?: unknown; category?: unknown }
  let list: RawAttr[] = []
  const obj = data as Record<string, unknown>
  if (Array.isArray(data)) list = data as RawAttr[]
  else if (obj && typeof obj === 'object') {
    const resp = obj.response
    if (Array.isArray(resp)) list = resp as RawAttr[]
    else if (resp && typeof resp === 'object') {
      const r = resp as Record<string, unknown>
      if (Array.isArray(r.Attribute)) list = r.Attribute as RawAttr[]
      else if (r.Attribute && typeof r.Attribute === 'object' && !Array.isArray(r.Attribute)) {
        // free-text поиск возвращает объект {id: attribute} — превращаем в массив
        list = Object.values(r.Attribute as Record<string, RawAttr>)
      }
    } else if (Array.isArray(obj.Attribute)) list = obj.Attribute as RawAttr[]
  }
  const out: { type: string; value: string; comment: string }[] = []
  for (const a of list) {
    if (!a || typeof a !== 'object') continue
    const type = typeof a.type === 'string' ? a.type : ''
    const value = typeof a.value === 'string' ? a.value.trim() : ''
    if (!type || !value) continue
    const comment = [typeof a.category === 'string' && a.category, typeof a.comment === 'string' && a.comment.trim()]
      .filter((x): x is string => Boolean(x)).join(' — ')
    out.push({ type, value, comment })
  }
  return out
}

/** Из значения MISP-атрибута извлечь сетевые индикаторы.
 *  Классификация по ЯВНОМУ списку сетевых типов MISP: составные типы
 *  (filename|md5 и т.п.) содержат имена файлов/хэши, которые эвристика
 *  префиксов ошибочно превращала бы в домены/IP. Не-сетевые типы — пропуск. */
function mispNetworkParts(type: string, value: string): { ips: string[]; domains: string[]; urls: string[] } {
  const ips: string[] = []
  const domains: string[] = []
  const urls: string[] = []
  const t = type.toLowerCase()
  const parts = value.split('|')
  const addIp = (raw: string) => {
    const v = safeIndicator(raw)
    const ip = v ? extractCidr(v) : null
    if (ip) ips.push(ip)
  }
  const addDomain = (raw: string) => {
    const v = safeIndicator(raw)
    const d = v ? extractDomain(v) : null
    if (d) domains.push(d)
  }
  const addUrl = (raw: string) => {
    const v = safeIndicator(raw)
    if (!v) return
    const u = extractUrl(v)
    if (u) { urls.push(u); return }
    // URL без пути (http://evil.com) — падаем на домен, чтобы индикатор не терялся
    const d = extractDomain(v.replace(/^https?:\/\//i, ''))
    if (d) domains.push(d)
  }
  if (t === 'ip' || t === 'ip-src' || t === 'ip-dst' || t === 'ip-src|ip-dst' || t === 'ip-dst|ip-src') {
    for (const p of parts) addIp(p)
  } else if (t === 'ip-src|port' || t === 'ip-dst|port' || t === 'hostname|port') {
    // первый сегмент — индикатор, второй — порт (в сетевое правило не идёт)
    if (parts[0]) {
      if (t === 'hostname|port') addDomain(parts[0])
      else addIp(parts[0])
    }
  } else if (t === 'domain|ip') {
    if (parts[0]) addDomain(parts[0])
    if (parts[1]) addIp(parts[1])
  } else if (t === 'domain' || t === 'hostname') {
    for (const p of parts) addDomain(p)
  } else if (t === 'url' || t === 'uri') {
    for (const p of parts) addUrl(p)
  }
  // прочие типы (md5, sha256, filename|md5, ja3-fingerprint-md5, regkey, email,
  // link — ссылки на источники аналитиков) в сетевые правила не конвертируются
  return { ips, domains, urls }
}

export function convertMispJson(text: string, opts: ConvertOptions): ConvertedRule[] {
  const action = opts.action ?? 'alert'
  const msgPrefix = opts.msgPrefix ?? 'MISP'
  const perRule = opts.perRule ?? 500
  const maxRules = opts.maxRules ?? 10000
  const classtype = opts.classtype ?? 'trojan-activity'

  const ips: string[] = []
  const domains: string[] = []
  const urls: string[] = []
  const seen = new Set<string>()
  const notes = new Map<string, string>() // комментарий атрибута для msg (домены/URL)

  for (const a of mispAttrs(text)) {
    const { ips: pi, domains: pd, urls: pu } = mispNetworkParts(a.type, a.value)
    for (const ip of pi) {
      const key = `ip:${ip}`
      if (!seen.has(key)) { seen.add(key); ips.push(ip) }
    }
    for (const d of pd) {
      const key = `d:${d}`
      if (!seen.has(key)) { seen.add(key); domains.push(d); if (a.comment) notes.set(key, a.comment) }
    }
    for (const u of pu) {
      const key = `u:${u}`
      if (!seen.has(key)) { seen.add(key); urls.push(u); if (a.comment) notes.set(key, a.comment) }
    }
  }

  const rules: ConvertedRule[] = []
  for (let i = 0; i < ips.length && rules.length < maxRules; i += perRule) {
    rules.push(ipChunkRule(ips.slice(i, i + perRule), opts.sidStart + rules.length, { action, msgPrefix, proto: opts.proto ?? 'ip', classtype }, 'misp'))
  }
  for (const d of domains) {
    if (rules.length >= maxRules) break
    const sid = opts.sidStart + rules.length
    const note = notes.get(`d:${d}`) ? ` — ${notes.get(`d:${d}`)}`.slice(0, 140) : ''
    rules.push({ sid, rev: 1, suricataOk: true, compatNotes: null,
      raw: `${action} dns ${LOCAL_NET} any -> ${EXTERNAL_NET} any (msg:"${msgPrefix} domain: ${d.slice(0, 100)}${note.replace(/"/g, '')}"; dns.query; content:"${d}"; nocase; endswith; classtype:${classtype}; metadata:ruleset misp; sid:${sid}; rev:1;)` })
  }
  for (const u of urls) {
    if (rules.length >= maxRules) break
    const slash = u.indexOf('/')
    const host = slash === -1 ? u : u.slice(0, slash)
    const uri = slash === -1 ? '/' : u.slice(slash)
    const sid = opts.sidStart + rules.length
    const note = notes.get(`u:${u}`) ? ` — ${notes.get(`u:${u}`)}`.slice(0, 140) : ''
    rules.push({ sid, rev: 1, suricataOk: true, compatNotes: null,
      raw: `${action} http ${LOCAL_NET} any -> ${EXTERNAL_NET} any (msg:"${msgPrefix} URL: ${u.slice(0, 100)}${note.replace(/"/g, '')}"; flow:to_server,established; http.host; content:"${host}"; startswith; endswith; http.uri; content:"${uri}"; startswith; classtype:${classtype}; metadata:ruleset misp; sid:${sid}; rev:1;)` })
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

// ─────────────────────────────────────────────────────────────────────────────
// Список хэшей SHA-256 (RST Threat Feed и др.) → правила filesha256.
// Suricata включает инспекцию файлов HTTP-ответов при наличии file-ключевых
// слов в наборе: правило с filesha256 срабатывает на скачиваемый файл с этим
// хэшем (дроппер/малварь по контрольной сумме, md5/sha1 не используем —
// в Suricata для них те же правила, но sha256 устойчив к коллизиям).
// ─────────────────────────────────────────────────────────────────────────────

const SHA256_RULE_RE = /^[0-9a-f]{64}$/

/** Конвертация списка SHA-256 → правила filesha256 (1 правило = 1 хэш, с предохранителем) */
export function convertHashList(text: string, opts: ConvertOptions): ConvertedRule[] {
  const action = opts.action ?? 'alert'
  const msgPrefix = opts.msgPrefix ?? 'CONVERTED-FILE known malicious file hash'
  const maxRules = opts.maxRules ?? 10000
  const classtype = opts.classtype ?? 'trojan-activity'
  const rules: ConvertedRule[] = []
  const seen = new Set<string>()
  let sid = opts.sidStart
  for (const line of text.split(/\r?\n/)) {
    if (rules.length >= maxRules) break
    const t = line.trim().toLowerCase()
    if (!t || t.startsWith('#') || t.startsWith('//')) continue
    if (!SHA256_RULE_RE.test(t) || seen.has(t)) continue
    seen.add(t)
    const raw =
      `${action} http ${LOCAL_NET} any -> ${EXTERNAL_NET} any ` +
      `(msg:"${msgPrefix} ${t.slice(0, 16)}…"; flow:to_server,established; filesha256:"${t}"; classtype:${classtype}; metadata:ruleset converted-feed; sid:${sid}; rev:1;)`
    rules.push({ sid, rev: 1, raw, suricataOk: true, compatNotes: null })
    sid++
  }
  return rules
}
