// ─────────────────────────────────────────────────────────────────────────────
// Интеграция с RST Cloud (https://www.rstcloud.com/api-docs/).
// База API: https://api.rstcloud.net/v1, авторизация всех запросов —
// заголовок X-Api-Key (ключ задаётся в «Настройки → Токены источников»).
//
// Возможности сервиса, используемые хабом:
//  • RST Threat Feed — фиды индикаторов четырёх типов (GET /ip, /domain, /url,
//    /hash; параметры type=csv|json, date=latest|YYYY-MM-DD; ответ — gzip-CSV
//    с редиректом на подписанный URL хранилища). Фиды конвертируются:
//    ip → IP-правила, url → HTTP-правила, hash (sha256) → правила filesha256,
//    domain → DNS-список заблокированных доменов.
//  • RST IoC Lookup (GET /ioc?value=…) — проверка одного индикатора
//    (домен/IP/URL/хэш): балл, теги (категории), описание, источники,
//    резолвинга и whois-данные. Используется кнопкой «Проверить в RST Cloud».
//  • RST Noise Control (GET /benign/lookup?value=…) — проверка «шума»:
//    считается ли значение доброкачественным (false-positive контроль).
//  • RST Whois API (GET /whois/{домен}) — регистрационные данные домена.
//  • Connectivity (GET /auth/check) — проверка ключа: валидность, права
//    (entitlements), квота запросов (used/limit/remaining/period).
//
// Фиды приходят CSV-строками с кавычками (внутри полей есть запятые) —
// парсер RST_FEEDS извлекает колонку индикатора (+ фильтры по score/fp_alarm).
// ─────────────────────────────────────────────────────────────────────────────
import { gunzipSync } from 'zlib'

export const RST_API_BASE = 'https://api.rstcloud.net/v1'

/** Тип фида RST Threat Feed → колонка CSV с индикатором */
export const RST_FEEDS: Record<string, { column: string; label: string; labelEn: string }> = {
  ip: { column: 'ip_v4', label: 'IP-адреса', labelEn: 'IP addresses' },
  domain: { column: 'domain', label: 'домены', labelEn: 'domains' },
  url: { column: 'url', label: 'URL-адреса', labelEn: 'URLs' },
  hash: { column: 'sha256', label: 'хэши SHA-256', labelEn: 'SHA-256 hashes' },
}

/** Распознать gzip-тело (у RST-фидов Content-Type: application/octet-stream) */
export function isGzipBody(body: Buffer): boolean {
  return body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b
}

/** Распаковать тело ответа, если оно gzip; иначе вернуть как есть */
export function maybeGunzip(body: Buffer): Buffer {
  if (!isGzipBody(body)) return body
  try {
    return gunzipSync(body)
  } catch {
    return body // повреждённый gzip — отдадим как есть (ошибка разбора будет наверху)
  }
}

// ── Разбор одной CSV-строки (кавычки, запятые внутри полей, двойные кавычки) ──
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else cur += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

export interface RstFeedRow {
  value: string
  score: number
  fpAlarm: boolean
  tags: string[]
}

export interface RstFeedParseOptions {
  /** пропускать записи с fp_alarm=true (обычно «Domain is sinkholed» — домен под контролем исследователей) */
  skipFpAlarm?: boolean
  /** минимальный балл score_total (0..100); 0 — без фильтра */
  minScore?: number
  /** предохранитель: максимум индикаторов */
  maxValues?: number
}

export interface RstFeedParseResult {
  values: string[]
  total: number
  skippedFpAlarm: number
  skippedScore: number
  skippedInvalid: number
  /** текстовое резюме (в журнал загрузки) */
  summary: string
  summaryEn: string
}

const SHA256_RE = /^[0-9a-f]{64}$/i
/** IPv4: четыре октета 0..255 */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** Валиден ли индикатор фида данного типа */
export function isValidRstValue(feed: string, v: string): boolean {
  const t = v.trim().toLowerCase()
  if (!t) return false
  if (feed === 'ip') return IPV4_RE.test(t)
  if (feed === 'hash') return SHA256_RE.test(t)
  if (feed === 'url') return /^https?:\/\/[a-z0-9]/.test(t)
  if (feed === 'domain') return /^[a-z0-9][a-z0-9._-]*\.[a-z]{2,24}$/.test(t)
  return false
}

/**
 * Разобрать CSV-фид RST Cloud: извлечь колонку индикатора (по заголовку),
 * применить фильтры fp_alarm/minScore. Использует parseCsvLine.
 */
export function parseRstFeedCsv(text: string, feed: string, opts: RstFeedParseOptions = {}): RstFeedParseResult {
  const meta = RST_FEEDS[feed] ?? RST_FEEDS.domain
  const lines = text.split(/\r?\n/)
  const res: RstFeedParseResult = { values: [], total: 0, skippedFpAlarm: 0, skippedScore: 0, skippedInvalid: 0, summary: '', summaryEn: '' }
  // колонки заголовка
  let header: string[] | null = null
  let idxValue = -1
  let idxScore = -1
  let idxFp = -1
  let idxTags = -1
  const max = opts.maxValues ?? 0
  for (const line of lines) {
    if (!line) continue
    const cells = parseCsvLine(line)
    if (!header) {
      header = cells.map((c) => c.trim().toLowerCase())
      idxValue = header.indexOf(meta.column)
      if (idxValue < 0) idxValue = 0 // не тот фид? берём первую колонку
      idxScore = header.indexOf('score_total')
      idxFp = header.indexOf('fp_alarm')
      idxTags = header.indexOf('tags_str')
      continue
    }
    res.total++
    const value = (cells[idxValue] ?? '').trim().toLowerCase()
    if (!value || !isValidRstValue(feed, value)) { res.skippedInvalid++; continue }
    const fpAlarm = idxFp >= 0 ? (cells[idxFp] ?? '').trim().toLowerCase() === 'true' : false
    if (fpAlarm && opts.skipFpAlarm) { res.skippedFpAlarm++; continue }
    const score = idxScore >= 0 ? Math.round(parseFloat(cells[idxScore] ?? '0') || 0) : 0
    if (opts.minScore && opts.minScore > 0 && score < opts.minScore) { res.skippedScore++; continue }
    if (max > 0 && res.values.length >= max) break
    res.values.push(value)
  }
  res.summary = `${meta.label}: ${res.values.length} индикаторов` + (res.skippedFpAlarm ? `, fp_alarm пропущено ${res.skippedFpAlarm}` : '') + (res.skippedScore ? `, ниже minScore ${opts.minScore} — ${res.skippedScore}` : '') + (res.skippedInvalid ? `, некорректных ${res.skippedInvalid}` : '')
  res.summaryEn = `${meta.labelEn}: ${res.values.length} indicators` + (res.skippedFpAlarm ? `, fp_alarm skipped ${res.skippedFpAlarm}` : '') + (res.skippedScore ? `, below minScore ${opts.minScore} — ${res.skippedScore}` : '') + (res.skippedInvalid ? `, invalid ${res.skippedInvalid}` : '')
  return res
}

// ── Клиент REST API ──────────────────────────────────────────────────────────

export interface RstCallResult {
  ok: boolean
  status: number
  /** тело ответа (JSON) или ошибка */
  data: Record<string, unknown> | null
  error?: string
}

async function rstCall(path: string, apiKey: string, init: RequestInit = {}): Promise<RstCallResult> {
  if (!apiKey.trim()) {
    return { ok: false, status: 0, data: null, error: 'Ключ RST Cloud не задан — введите его в «Настройки → Токены источников → RST Cloud»' }
  }
  try {
    const res = await fetch(`${RST_API_BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
        'X-Api-Key': apiKey.trim(),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    let data: Record<string, unknown> | null = null
    const text = await res.text()
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      data = null
    }
    if (!res.ok) {
      const msg = (data && typeof data.message === 'string' && data.message) || `HTTP ${res.status}`
      const err = new Error(msg) as Error & { status?: number; data?: Record<string, unknown> }
      err.status = res.status
      err.data = data ?? undefined
      return { ok: false, status: res.status, data, error: String(msg) }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } }
    return { ok: false, status: 0, data: null, error: err.message || 'ошибка запроса к RST Cloud' }
  }
}

export interface RstKeyCheck {
  ok: boolean
  status: number
  valid?: boolean
  entitlements?: string[]
  quota?: { used?: number; limit?: number; remaining?: number; period?: string }
  error?: string
}

/** GET /auth/check — валидность ключа + квота */
export async function rstCheckKey(apiKey: string): Promise<RstKeyCheck> {
  const r = await rstCall('/auth/check', apiKey)
  if (!r.ok) return { ok: false, status: r.status, error: r.error }
  const check = (r.data?.check ?? {}) as { status?: string }
  const quota = (r.data?.quota ?? {}) as RstKeyCheck['quota']
  const entitlements = Array.isArray(r.data?.entitlements) ? (r.data?.entitlements as string[]) : []
  return { ok: true, status: r.status, valid: check.status === 'valid', entitlements, quota }
}

/** GET /ioc?value=… — проверка индикатора (балл, теги, описание) */
export async function rstIocLookup(value: string, apiKey: string): Promise<RstCallResult> {
  return rstCall(`/ioc?value=${encodeURIComponent(value.trim())}`, apiKey)
}

/** GET /benign/lookup?value=… — проверка «шума» (Noise Control) */
export async function rstBenignLookup(value: string, apiKey: string): Promise<RstCallResult> {
  return rstCall(`/benign/lookup?value=${encodeURIComponent(value.trim())}`, apiKey)
}

/** GET /whois/{домен} — регистрационные данные домена */
export async function rstWhois(domain: string, apiKey: string): Promise<RstCallResult> {
  return rstCall(`/whois/${encodeURIComponent(domain.trim().replace(/\.$/, ''))}`, apiKey)
}

/** Человекочитаемое резюме проверки индикатора (для журнала/API-ответа) */
export function rstIocVerdict(data: Record<string, unknown>): { malicious: boolean; score: number; tags: string[]; text: string } {
  const score = Math.round(Number((data.score as Record<string, unknown> | undefined)?.total ?? 0) || 0)
  const tags = Array.isArray((data.tags as Record<string, unknown> | undefined)?.str) ? ((data.tags as { str: string[] }).str) : []
  const fpAlarm = (data.fp as Record<string, unknown> | undefined)?.alarm === 'true'
  const malicious = score > 0 && !fpAlarm
  const what = tags.length ? tags.join(', ') : 'без тегов'
  const text = score > 0
    ? `В базе RST Cloud: балл ${score}/100, теги: ${what}${fpAlarm ? ' (fp_alarm: возможен false positive — см. описание)' : ''}`
    : 'Не найден в базе RST Cloud (0 баллов — на момент проверки не считался вредоносным)'
  return { malicious, score, tags, text }
}
