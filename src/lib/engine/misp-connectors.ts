// ─────────────────────────────────────────────────────────────────────────────
// Коннекторы событий в MISP: хаб собирает события/индикаторы из источников
// инфраструктуры и создаёт события в MISP через REST API (/events/add),
// чтобы MISP коррелировал их и служил центральным узлом threat intelligence:
//
//   • clearndr  — обнаружения Clear NDR (Suricata-алерты, OpenSearch logstash-*)
//   • wazuh     — уязвимости сервисов (Wazuh Indexer, wazuh-states-vulnerabilities-*)
//   • zabbix    — проблемы из мониторинга (Zabbix API, JSON-RPC)
//   • mikrotik  — новые записи списков блокировок (RouterOS v7 REST API)
//   • webhook   — универсальный приёмник POST /api/misp/ingest (uuWAF и другие
//                 источники без готового коннектора: токен-аутентификация)
//
// Дедупликация по времени: у каждого коннектора lastRun (настройка
// mispConn<X>LastRun) — источники опрашиваются инкрементально. MikroTik
// дополнительно держит «Seen»-слепок (data/misp/state/mikrotik-seen.json):
// в MISP уходят только НОВЫЕ записи address-list.
//
// Планировщик: ensureConnectorLoop() — интервал 60 c, коннектор срабатывает,
// когда включён и его интервал (mispConn<X>Interval, минут) истёк.
// ─────────────────────────────────────────────────────────────────────────────
import { request, Agent } from 'undici'
import { promises as fs } from 'fs'
import path from 'path'
import { getSettings, setSetting, log } from './service'
import { DATA_DIR } from './fetcher'
import { resolveEsChannel, esQuery } from './cleanup'

// ────────────────────────────── типы и константы ─────────────────────────────

export const CONNECTOR_IDS = ['clearndr', 'wazuh', 'zabbix', 'mikrotik'] as const
export type ConnectorId = (typeof CONNECTOR_IDS)[number]

export interface AttrSpec {
  type: string
  value: string
  comment?: string
  /** to_ids=true — атрибут для автоматической блокировки (IPS) */
  toIds?: boolean
}

export interface MispEventSpec {
  info: string
  attrs: AttrSpec[]
  tags: string[]
}

export interface ConnectorRunResult {
  ok: boolean
  count?: number
  eventId?: string
  error?: string
  /** ok и 0 событий — «ничего нового», не ошибка */
  empty?: boolean
}

const MISPS_DIR = path.join(DATA_DIR, 'misp')
const MIKROTIK_SEEN_FILE = path.join(MISPS_DIR, 'state', 'mikrotik-seen.json')
const ATTR_CAP = 500 // максимум атрибутов в одном событии (страховка от гигантских окон)

const insecure = () => new Agent({ connect: { rejectUnauthorized: false } })

/** Категория MISP по типу атрибута (defaults из полиса типов MISP) */
export function attrCategory(type: string): string {
  if (type.startsWith('ip-') || type === 'domain' || type === 'hostname' || type === 'url' || type === 'domain|ip' || type === 'user-agent') return 'Network activity'
  if (type === 'vulnerability') return 'External analysis'
  if (type === 'md5' || type === 'sha1' || type === 'sha256') return 'Artifacts dropped'
  if (type === 'email-src' || type === 'email-dst') return 'Payload delivery'
  return 'Other'
}

/** Тело запроса /events/add. Distribution: 0 org,1 community,2 connected,3 all.
 *  Threat level: 1 High … 4 Undefined. Атрибуты наследуют распределение (5). */
export function buildEventPayload(
  spec: MispEventSpec,
  opts: { distribution: number; threatLevel: number; published: boolean; tagPrefix: string },
): Record<string, unknown> {
  const dist = Math.min(Math.max(Math.trunc(opts.distribution), 0), 3)
  const threat = Math.min(Math.max(Math.trunc(opts.threatLevel), 1), 4)
  const tags = [opts.tagPrefix, ...spec.tags]
    .map((t) => String(t).trim())
    .filter((t, i, a) => t && a.indexOf(t) === i)
    .slice(0, 30)
  return {
    Event: {
      info: spec.info.slice(0, 255),
      distribution: dist,
      threat_level_id: threat,
      analysis: 1, // «enabled» — событие в работе
      published: opts.published === true,
      Tag: tags.map((name) => ({ name })),
      Attribute: spec.attrs.slice(0, ATTR_CAP).map((a) => ({
        type: a.type,
        value: a.value,
        comment: (a.comment ?? '').slice(0, 191),
        to_ids: a.toIds === true,
        distribution: 5, // inherit event
        category: attrCategory(a.type),
      })),
    },
  }
}

// ────────────────────────────── MISP REST API ────────────────────────────────

interface MispCfg { url: string; key: string }

async function mispCfgFromDb(cfg?: Partial<MispCfg>): Promise<MispCfg> {
  const s = await getSettings()
  const url = (cfg?.url ?? s.mispUrl ?? '').trim().replace(/\/+$/, '')
  const key = (cfg?.key ?? s.mispAuthKey ?? '').trim()
  return { url, key }
}

async function mispRequest(cfg: MispCfg, method: 'GET' | 'POST', p: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
  if (!cfg.url || !cfg.key) throw new Error('MISP не настроен: укажите URL и API-ключ («Интеграции → MISP»)')
  const res = await request(`${cfg.url}${p}`, {
    method,
    headers: {
      Authorization: cfg.key,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: insecure(), // MISP часто за self-signed сертификатом
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  })
  const text = await res.body.text()
  return { status: res.statusCode, body: text }
}

/** Проверка связи: GET /servers/getVersion → {version: "2.4.x"} */
export async function mispTestConnection(cfg?: Partial<MispCfg>): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const c = await mispCfgFromDb(cfg)
    const r = await mispRequest(c, 'GET', '/servers/getVersion')
    if (r.status !== 200) {
      const hint = r.status === 403 ? ' — неверный API-ключ или ключ не авторизован' : ''
      return { ok: false, error: `HTTP ${r.status}${hint}: ${r.body.slice(0, 160)}` }
    }
    const j = JSON.parse(r.body) as { version?: string }
    return { ok: true, version: j.version }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Создание события в MISP. Возвращает id события. */
export async function createMispEvent(spec: MispEventSpec, cfg?: Partial<MispCfg>): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const c = await mispCfgFromDb(cfg)
    const s = await getSettings()
    const payload = buildEventPayload(spec, {
      distribution: parseInt(s.mispDistribution ?? '1', 10) || 1,
      threatLevel: parseInt(s.mispThreatLevel ?? '2', 10) || 2,
      published: (s.mispPublished ?? 'false') === 'true',
      tagPrefix: (s.mispTagPrefix || 'ndr-hub').slice(0, 60),
    })
    const r = await mispRequest(c, 'POST', '/events/add', payload)
    if (r.status !== 200) {
      return { ok: false, error: `HTTP ${r.status}: ${r.body.slice(0, 200)}` }
    }
    let id: string | undefined
    try {
      const j = JSON.parse(r.body) as { Event?: { id?: string | number } }
      id = j.Event?.id !== undefined ? String(j.Event.id) : undefined
    } catch { /* не-JSON — оставим id пустым */ }
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ─────────────────────────── коннектор: Clear NDR ────────────────────────────

const TS_FIELD = '@timestamp'

/** Атрибуты из hit OpenSearch (Suricata eve в logstash-*): ip-src/ip-dst + signature. */
export function clearndrHitAttrs(hit: Record<string, unknown>): AttrSpec[] {
  const src = hit['src_ip'] ?? (hit.source as Record<string, unknown> | undefined)?.['src_ip']
  const dst = hit['dest_ip'] ?? (hit.source as Record<string, unknown> | undefined)?.['dest_ip']
  const sig = hit['alert'] ?? (hit.source as Record<string, unknown> | undefined)?.['alert']
  const attrs: AttrSpec[] = []
  const sigName = sig && typeof sig === 'object' ? String((sig as Record<string, unknown>).signature ?? '') : ''
  const sigId = sig && typeof sig === 'object' ? String((sig as Record<string, unknown>).signature_id ?? '') : ''
  const comment = sigName ? `sid ${sigId} ${sigName}`.slice(0, 191) : 'Clear NDR detection'
  const push = (v: unknown, type: string) => {
    const s = String(v ?? '').trim()
    if (s) attrs.push({ type, value: s, comment })
  }
  push(src, 'ip-src')
  push(dst, 'ip-dst')
  if (sigName && attrs.length === 0) attrs.push({ type: 'text', value: sigName.slice(0, 191), comment: 'Clear NDR detection' })
  return attrs
}

/** Поиск по индексам OpenSearch: window от lastRun до now, только алерты. */
export function clearndrQueryBody(index: string, fromIso: string): Record<string, unknown> {
  void index
  return {
    query: {
      bool: {
        must: [
          { range: { [TS_FIELD]: { gte: fromIso, lte: 'now' } } },
          { exists: { field: 'alert.signature_id' } },
        ],
      },
    },
    sort: [{ [TS_FIELD]: 'asc' }],
    size: ATTR_CAP,
    _source: [TS_FIELD, 'src_ip', 'dest_ip', 'src_port', 'dest_port', 'alert.signature', 'alert.signature_id', 'alert.category', 'alert.severity', 'proto'],
  }
}

async function runClearndrConnector(now: Date): Promise<ConnectorRunResult> {
  const s = await getSettings()
  const index = (s.mispConnClearndrIndex || 'logstash-*').trim()
  const lastRun = s.mispConnClearndrLastRun
  const fromIso = lastRun ? new Date(lastRun).toISOString() : new Date(now.getTime() - 15 * 60_000).toISOString()
  const { channel, tried } = await resolveEsChannel()
  if (!channel) {
    return { ok: false, error: `OpenSearch не найден (пробовал: ${tried.join(', ') || '—'}). Укажите URL в настройках очистки или коннектора` }
  }
  const r = await esQuery(channel, 'POST', `/${encodeURIComponent(index)}/_search`, clearndrQueryBody(index, fromIso))
  if (r.status !== 200) {
    // старые кластеры не поддерживают _source/sort в таком виде — повтор без украшений
    const retry = await esQuery(channel, 'POST', `/${encodeURIComponent(index)}/_search`, {
      query: { bool: { must: [{ range: { [TS_FIELD]: { gte: fromIso, lte: 'now' } } }, { exists: { field: 'alert.signature_id' } }] } },
      size: ATTR_CAP,
    })
    if (retry.status !== 200) {
      return { ok: false, error: `OpenSearch HTTP ${r.status}: ${r.body.slice(0, 160)}` }
    }
    return finishClearndr(retry.body, fromIso, now)
  }
  return finishClearndr(r.body, fromIso, now)
}

async function finishClearndr(rawBody: string, fromIso: string, now: Date): Promise<ConnectorRunResult> {
  let hits: Array<Record<string, unknown>> = []
  try {
    const j = JSON.parse(rawBody) as { hits?: { hits?: Array<{ _source?: Record<string, unknown> }> } }
    hits = (j.hits?.hits ?? []).map((h) => h._source ?? {})
  } catch {
    return { ok: false, error: 'не-JSON ответ OpenSearch' }
  }
  const attrs: AttrSpec[] = []
  const seen = new Set<string>()
  let maxTs = fromIso
  for (const h of hits) {
    const ts = String(h[TS_FIELD] ?? '')
    if (ts && ts > maxTs) maxTs = ts
    for (const a of clearndrHitAttrs(h)) {
      const k = `${a.type}|${a.value}|${a.comment}`
      if (!seen.has(k)) {
        seen.add(k)
        attrs.push(a)
      }
    }
    if (attrs.length >= ATTR_CAP) break
  }
  if (attrs.length === 0) {
    await setSetting('mispConnClearndrLastRun', maxTs)
    return { ok: true, count: 0, empty: true }
  }
  const ev = await createMispEvent({
    info: `Clear NDR: обнаружений ${hits.length} (с ${fromIso.slice(0, 19).replace('T', ' ')})`,
    attrs: attrs.slice(0, ATTR_CAP),
    tags: ['clearndr', 'detections'],
  })
  if (!ev.ok) return { ok: false, error: ev.error, count: attrs.length }
  await setSetting('mispConnClearndrLastRun', maxTs)
  await log('success', 'misp', `Коннектор Clear NDR: событие MISP #${ev.id ?? '?'} — ${attrs.length} атрибутов из ${hits.length} обнаружений`)
  return { ok: true, count: attrs.length, eventId: ev.id }
}

// ──────────────────────────── коннектор: Wazuh ───────────────────────────────

/** Атрибуты из hit wazuh-states-vulnerabilities-*: CVE + агент/пакет. */
export function wazuhHitAttrs(hit: Record<string, unknown>): AttrSpec[] {
  const vul = (hit.vulnerability ?? {}) as Record<string, unknown>
  const agent = (hit.agent ?? {}) as Record<string, unknown>
  const pkg = (hit.package ?? {}) as Record<string, unknown>
  const attrs: AttrSpec[] = []
  const cve = String(vul.id ?? '').trim()
  if (!cve) return attrs
  const score = vul['score'] && typeof vul.score === 'object' ? (vul.score as Record<string, unknown>).base : undefined
  const comment = [
    pkg.name ? `пакет: ${pkg.name}${pkg.version ? ` ${pkg.version}` : ''}` : '',
    vul.severity ? String(vul.severity) : '',
    score !== undefined ? `score ${score}` : '',
    agent.name ? `агент: ${agent.name}` : '',
  ].filter(Boolean).join('; ').slice(0, 191)
  attrs.push({ type: 'vulnerability', value: cve, comment })
  const host = String(agent.name ?? '').trim()
  if (host) attrs.push({ type: 'hostname', value: host, comment: cve })
  return attrs
}

/** Wazuh Indexer (OpenSearch): инкрементальный запрос уязвимостей. */
async function runWazuhConnector(now: Date): Promise<ConnectorRunResult> {
  const s = await getSettings()
  const url = (s.mispConnWazuhUrl ?? '').trim().replace(/\/+$/, '')
  if (!url) return { ok: false, error: 'не указан адрес Wazuh Indexer (https://<хост>:9200)' }
  const user = (s.mispConnWazuhUser || 'admin').trim()
  const pass = (s.mispConnWazuhPass ?? '').trim()
  const index = (s.mispConnWazuhIndex || 'wazuh-states-vulnerabilities-*').trim()
  const lastRun = s.mispConnWazuhLastRun
  const fromIso = lastRun ? new Date(lastRun).toISOString() : new Date(now.getTime() - 60 * 60_000).toISOString()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (pass) headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  // поле времени: vulnerability.detected_at (Wazuh 4.8+); на отказе — @timestamp
  for (const tsField of ['vulnerability.detected_at', TS_FIELD]) {
    let res
    try {
      res = await request(`${url}/${encodeURIComponent(index)}/_search`, {
        method: 'POST',
        headers,
        dispatcher: insecure(),
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
        body: JSON.stringify({
          query: { range: { [tsField]: { gte: fromIso, lte: 'now' } } },
          sort: [{ [tsField]: 'asc' }],
          size: ATTR_CAP,
        }),
      })
    } catch (e) {
      return { ok: false, error: `Wazuh Indexer недоступен: ${(e as Error).message}` }
    }
    const body = await res.body.text()
    if (res.statusCode !== 200) {
      if (tsField === TS_FIELD) return { ok: false, error: `Wazuh Indexer HTTP ${res.statusCode}: ${body.slice(0, 160)}` }
      continue // поле detected_at отсутствует — пробуем @timestamp
    }
    let hits: Array<Record<string, unknown>> = []
    let maxTs = fromIso
    try {
      const j = JSON.parse(body) as { hits?: { hits?: Array<{ _source?: Record<string, unknown> }> } }
      hits = (j.hits?.hits ?? []).map((h) => h._source ?? {})
    } catch {
      return { ok: false, error: 'не-JSON ответ Wazuh Indexer' }
    }
    const attrs: AttrSpec[] = []
    const seen = new Set<string>()
    for (const h of hits) {
      const rawTs = h[tsField] ?? h[TS_FIELD]
      const ts = typeof rawTs === 'string' ? rawTs : ''
      if (ts && ts > maxTs) maxTs = ts
      for (const a of wazuhHitAttrs(h)) {
        const k = `${a.type}|${a.value}|${a.comment}`
        if (!seen.has(k)) {
          seen.add(k)
          attrs.push(a)
        }
      }
      if (attrs.length >= ATTR_CAP) break
    }
    if (attrs.length === 0) {
      await setSetting('mispConnWazuhLastRun', maxTs)
      return { ok: true, count: 0, empty: true }
    }
    const ev = await createMispEvent({
      info: `Wazuh: уязвимости ${attrs.length} (с ${fromIso.slice(0, 19).replace('T', ' ')})`,
      attrs: attrs.slice(0, ATTR_CAP),
      tags: ['wazuh', 'vulnerabilities'],
    })
    if (!ev.ok) return { ok: false, error: ev.error, count: attrs.length }
    await setSetting('mispConnWazuhLastRun', maxTs)
    await log('success', 'misp', `Коннектор Wazuh: событие MISP #${ev.id ?? '?'} — ${attrs.length} атрибутов из ${hits.length} уязвимостей`)
    return { ok: true, count: attrs.length, eventId: ev.id }
  }
  return { ok: false, error: 'Wazuh Indexer: запрос не выполнен' }
}

// ──────────────────────────── коннектор: Zabbix ──────────────────────────────

export interface ZabbixProblem {
  eventid?: string
  objectid?: string
  name?: string
  severity?: string | number
  clock?: string
  host?: string
  hostName?: string
}

/** Атрибуты проблемы Zabbix: hostname + текст проблемы. */
export function zabbixProblemAttrs(p: ZabbixProblem): AttrSpec[] {
  const attrs: AttrSpec[] = []
  const host = String(p.host ?? '').trim()
  const name = String(p.name ?? '').trim()
  const sev = severityName(p.severity)
  if (host) attrs.push({ type: 'hostname', value: host, comment: name ? `${sev}: ${name}`.slice(0, 191) : 'Zabbix problem' })
  if (name) attrs.push({ type: 'text', value: name.slice(0, 191), comment: host ? `${host} (${sev})` : sev })
  return attrs
}

export function severityName(sev: string | number | undefined): string {
  const n = typeof sev === 'string' ? parseInt(sev, 10) : sev ?? 0
  return ['not classified', 'information', 'warning', 'average', 'high', 'disaster'][Number.isFinite(n) ? Math.min(Math.max(n as number, 0), 5) : 0]
}

/** Zabbix API (JSON-RPC): login → problem.get → trigger.get (имена хостов). */
async function runZabbixConnector(now: Date): Promise<ConnectorRunResult> {
  const s = await getSettings()
  const url = (s.mispConnZabbixUrl ?? '').trim()
  if (!url) return { ok: false, error: 'не указан URL Zabbix API (http://<хост>/api_jsonrpc.php)' }
  const token = (s.mispConnZabbixToken ?? '').trim()
  const user = (s.mispConnZabbixUser || 'Admin').trim()
  const password = (s.mispConnZabbixPassword ?? '').trim()
  const minSev = Math.min(Math.max(parseInt(s.mispConnZabbixMinSeverity ?? '2', 10) || 2, 0), 5)
  const lastRun = s.mispConnZabbixLastRun
  const fromMs = lastRun ? new Date(lastRun).getTime() : now.getTime() - 15 * 60_000
  const timeFrom = Math.floor(fromMs / 1000)

  const rpc = async (method: string, params: Record<string, unknown>, auth?: string, tokenHeader?: boolean): Promise<Record<string, unknown>> => {
    const headers: Record<string, string> = { 'content-type': 'application/json-rpc' }
    if (tokenHeader && token) headers.authorization = `Bearer ${token}`
    let res
    try {
      res = await request(url, {
        method: 'POST',
        headers,
        dispatcher: insecure(),
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
        body: JSON.stringify({ jsonrpc: '2.0', method, params: tokenHeader ? params : { ...params, ...(auth ? { auth } : {}) }, id: 1 }),
      })
    } catch (e) {
      throw new Error(`Zabbix API недоступен: ${(e as Error).message}`)
    }
    const body = await res.body.text()
    let j: { result?: unknown; error?: { message?: string; data?: string } }
    try {
      j = JSON.parse(body)
    } catch {
      throw new Error(`не-JSON ответ Zabbix (HTTP ${res.statusCode}): ${body.slice(0, 120)}`)
    }
    if (j.error) throw new Error(`Zabbix API: ${j.error.message ?? ''} ${j.error.data ?? ''}`.trim())
    return (j.result ?? {}) as Record<string, unknown>
  }

  // аутентификация: токен (Bearer, Zabbix 5.4+) или user.login (username в 6.0+
  // заменил «user»; неизвестный параметр в старых версиях даёт ошибку — пробуем оба)
  let auth = ''
  if (!token) {
    let loginRes: Record<string, unknown>
    try {
      loginRes = await rpc('user.login', { username: user, password })
    } catch {
      loginRes = await rpc('user.login', { user, password })
    }
    auth = String(loginRes ?? '')
    if (!auth) return { ok: false, error: 'Zabbix: не удалось войти (user.login вернул пустой токен)' }
  }

  try {
    const problemsRes = await rpc('problem.get', {
      time_from: timeFrom,
      output: ['eventid', 'objectid', 'name', 'severity', 'clock'],
      severity: minSev,
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: ATTR_CAP,
    }, auth || undefined, !!token)
    const problems = (Array.isArray(problemsRes) ? problemsRes : []) as unknown as ZabbixProblem[]
    if (problems.length === 0) {
      await setSetting('mispConnZabbixLastRun', now.toISOString())
      return { ok: true, count: 0, empty: true }
    }
    const triggerIds = [...new Set(problems.map((p) => String(p.objectid ?? '')).filter(Boolean))]
    let hostByTrigger = new Map<string, { host?: string; name?: string }>()
    if (triggerIds.length) {
      const trigRes = await rpc('trigger.get', {
        triggerids: triggerIds,
        output: ['triggerid'],
        selectHosts: ['host', 'name'],
      }, auth || undefined, !!token)
      const trigs = (Array.isArray(trigRes) ? trigRes : []) as Array<{ triggerid?: string; hosts?: Array<{ host?: string; name?: string }> }>
      hostByTrigger = new Map(trigs.map((t) => [String(t.triggerid ?? ''), t.hosts?.[0] ?? {}]))
    }
    const attrs: AttrSpec[] = []
    const seen = new Set<string>()
    for (const p of problems) {
      const h = hostByTrigger.get(String(p.objectid ?? ''))
      const merged: ZabbixProblem = { ...p, host: h?.host, hostName: h?.name }
      for (const a of zabbixProblemAttrs(merged)) {
        const k = `${a.type}|${a.value}|${a.comment}`
        if (!seen.has(k)) {
          seen.add(k)
          attrs.push(a)
        }
      }
      if (attrs.length >= ATTR_CAP) break
    }
    const ev = await createMispEvent({
      info: `Zabbix: проблем ${problems.length} (с ${new Date(fromMs).toISOString().slice(0, 19).replace('T', ' ')})`,
      attrs: attrs.slice(0, ATTR_CAP),
      tags: ['zabbix', 'monitoring'],
    })
    if (!ev.ok) return { ok: false, error: ev.error, count: attrs.length }
    await setSetting('mispConnZabbixLastRun', now.toISOString())
    await log('success', 'misp', `Коннектор Zabbix: событие MISP #${ev.id ?? '?'} — ${attrs.length} атрибутов из ${problems.length} проблем`)
    return { ok: true, count: attrs.length, eventId: ev.id }
  } finally {
    if (auth) await rpc('user.logout', {}, auth).catch(() => undefined)
  }
}

// ──────────────────────────── коннектор: MikroTik ────────────────────────────

export interface MikrotikEntry {
  address?: string
  list?: string
  comment?: string
  dynamic?: boolean | string
  disabled?: boolean | string
}

/** Ключ дедупликации записи address-list */
export function mikrotikEntryKey(e: MikrotikEntry): string {
  return `${e.list ?? ''}|${e.address ?? ''}`
}

/** Только новые записи против слепка seen (ключ → firstSeen ISO). */
export function filterNewMikrotikEntries(entries: MikrotikEntry[], seen: Record<string, string>): { fresh: MikrotikEntry[]; seen: Record<string, string> } {
  const next = { ...seen }
  const fresh: MikrotikEntry[] = []
  for (const e of entries) {
    const k = mikrotikEntryKey(e)
    if (!k || k === '|') continue
    if (!next[k]) {
      next[k] = new Date().toISOString()
      fresh.push(e)
    }
  }
  // страховка от бесконечного роста: храним не более 20 000 ключей (свежие в конце)
  const keys = Object.keys(next)
  if (keys.length > 20_000) {
    const keep = keys.slice(keys.length - 20_000)
    const pruned: Record<string, string> = {}
    for (const k of keep) pruned[k] = next[k]
    return { fresh, seen: pruned }
  }
  return { fresh, seen: next }
}

function truthy(v: boolean | string | undefined): boolean {
  return v === true || v === 'true' || v === 'yes'
}

/** RouterOS v7 REST API: GET /ip/firewall/address-list (Basic auth). */
async function runMikrotikConnector(now: Date): Promise<ConnectorRunResult> {
  const s = await getSettings()
  const url = (s.mispConnMikrotikUrl ?? '').trim().replace(/\/+$/, '')
  if (!url) return { ok: false, error: 'не указан URL RouterOS REST API (https://<роутер>/rest)' }
  const user = (s.mispConnMikrotikUser || 'admin').trim()
  const pass = (s.mispConnMikrotikPass ?? '').trim()
  const lists = (s.mispConnMikrotikLists ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)

  let res
  try {
    res = await request(`${url}/ip/firewall/address-list`, {
      method: 'GET',
      headers: { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, accept: 'application/json' },
      dispatcher: insecure(),
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    })
  } catch (e) {
    return { ok: false, error: `RouterOS REST недоступен: ${(e as Error).message}` }
  }
  const body = await res.body.text()
  if (res.statusCode !== 200) {
    return { ok: false, error: `RouterOS HTTP ${res.statusCode}: ${body.slice(0, 160)}` }
  }
  let entries: MikrotikEntry[]
  try {
    const j = JSON.parse(body)
    entries = Array.isArray(j) ? j : []
  } catch {
    return { ok: false, error: 'не-JSON ответ RouterOS (REST API включён? /ip service set rest-api disabled=no)' }
  }
  const wanted = entries.filter((e) => !truthy(e.dynamic) && !truthy(e.disabled) && (!lists.length || lists.includes(String(e.list ?? '').toLowerCase())))
  const seen = await readMikrotikSeen()
  const { fresh, seen: nextSeen } = filterNewMikrotikEntries(wanted, seen)
  if (fresh.length === 0) {
    return { ok: true, count: 0, empty: true }
  }
  const attrs: AttrSpec[] = fresh.slice(0, ATTR_CAP).map((e) => ({
    type: 'ip-src',
    value: String(e.address ?? ''),
    comment: `address-list: ${e.list ?? ''}${e.comment ? ` — ${e.comment}` : ''}`.slice(0, 191),
    toIds: true,
  }))
  const ev = await createMispEvent({
    info: `MikroTik: новые записи блок-листов (${fresh.length})`,
    attrs: attrs,
    tags: ['mikrotik', 'blocklist'],
  })
  if (!ev.ok) return { ok: false, error: ev.error, count: fresh.length }
  await writeMikrotikSeen(nextSeen)
  await log('success', 'misp', `Коннектор MikroTik: событие MISP #${ev.id ?? '?'} — ${fresh.length} новых записей address-list`)
  return { ok: true, count: fresh.length, eventId: ev.id }
}

async function readMikrotikSeen(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(MIKROTIK_SEEN_FILE, 'utf8')
    const j = JSON.parse(raw) as Record<string, string>
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

async function writeMikrotikSeen(seen: Record<string, string>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(MIKROTIK_SEEN_FILE), { recursive: true })
    await fs.writeFile(MIKROTIK_SEEN_FILE, JSON.stringify(seen))
  } catch { /* том read-only — дедуп не переживёт перезапуск */ }
}

// ────────────────────── универсальный webhook-приёмник ───────────────────────

export interface IngestPayload {
  info?: unknown
  source?: unknown
  type?: unknown
  text?: unknown
  values?: unknown
  tags?: unknown
}

/** Приём webhook (uuWAF и другие источники): валидация и нормализация тела. */
export function parseIngestPayload(body: IngestPayload): { ok: boolean; spec?: MispEventSpec; error?: string } {
  const src = typeof body.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 60) : 'webhook'
  const tagsRaw = Array.isArray(body.tags) ? body.tags : []
  const tags = [src, ...tagsRaw]
    .filter((t): t is string => typeof t === 'string' && /^[A-Za-z0-9_.\-]+$/.test(t.trim()) && t.trim().length <= 64)
    .slice(0, 20)
  const defaultType = typeof body.type === 'string' && /^[a-z0-9|\-]+$/.test(body.type) ? body.type : 'ip-src'
  const attrs: AttrSpec[] = []
  const vals = Array.isArray(body.values) ? body.values : []
  for (const v of vals.slice(0, ATTR_CAP)) {
    if (typeof v === 'string' && v.trim()) {
      attrs.push({ type: defaultType, value: v.trim().slice(0, 191), comment: `webhook: ${src}` })
    } else if (v && typeof v === 'object') {
      const o = v as { type?: unknown; value?: unknown; comment?: unknown }
      if (typeof o.value === 'string' && o.value.trim()) {
        attrs.push({
          type: typeof o.type === 'string' && /^[a-z0-9|\-]+$/.test(o.type) ? o.type : defaultType,
          value: o.value.trim().slice(0, 191),
          comment: typeof o.comment === 'string' ? o.comment.slice(0, 191) : `webhook: ${src}`,
        })
      }
    }
  }
  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 191) : ''
  if (text) attrs.push({ type: 'text', value: text, comment: `webhook: ${src}` })
  if (attrs.length === 0) return { ok: false, error: 'нет ни одного атрибута: передайте values[] и/или text' }
  const info = (typeof body.info === 'string' && body.info.trim() ? body.info.trim() : `${src}: событие`)
  const spec: MispEventSpec = {
    info: `${info} (${attrs.length})`.slice(0, 255),
    attrs,
    tags,
  }
  return { ok: true, spec }
}

/** Обработка входящего webhook: событие в MISP + журнал хаба. */
export async function ingestToMisp(payload: IngestPayload, ip?: string): Promise<{ ok: boolean; eventId?: string; count?: number; error?: string }> {
  const p = parseIngestPayload(payload)
  if (!p.ok || !p.spec) {
    await log('warn', 'misp', `Webhook-приёмник: некорректное тело от ${ip ?? '—'}: ${p.error}`)
    return { ok: false, error: p.error }
  }
  const ev = await createMispEvent(p.spec)
  await log(ev.ok ? 'success' : 'error', 'misp',
    ev.ok
      ? `Webhook-приёмник (${p.spec.tags[0] ?? 'webhook'}): событие MISP #${ev.id ?? '?'} — ${p.spec.attrs.length} атрибутов`
      : `Webhook-приёмник: не удалось создать событие: ${ev.error}`)
  if (!ev.ok) return { ok: false, error: ev.error }
  return { ok: true, eventId: ev.id, count: p.spec.attrs.length }
}

// ─────────────────────────────── планировщик ─────────────────────────────────

export function connectorDue(lastRunIso: string | undefined, intervalMin: number, now: number): boolean {
  const interval = Math.max(1, Math.trunc(intervalMin)) * 60_000
  if (!lastRunIso) return true
  const t = new Date(lastRunIso).getTime()
  if (!Number.isFinite(t)) return true
  return now - t >= interval
}

const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1)

function connSetting(id: ConnectorId, suffix: string): string {
  return `mispConn${cap(id)}${suffix}`
}

/** Запуск коннектора по id (ручной или по расписанию). */
export async function runConnector(id: ConnectorId): Promise<ConnectorRunResult> {
  const now = new Date()
  let r: ConnectorRunResult
  try {
    switch (id) {
      case 'clearndr':
        r = await runClearndrConnector(now)
        break
      case 'wazuh':
        r = await runWazuhConnector(now)
        break
      case 'zabbix':
        r = await runZabbixConnector(now)
        break
      case 'mikrotik':
        r = await runMikrotikConnector(now)
        break
      default:
        r = { ok: false, error: `неизвестный коннектор: ${id as string}` }
    }
  } catch (e) {
    r = { ok: false, error: (e as Error).message }
  }
  await setSetting(connSetting(id, 'LastRun'), now.toISOString())
  await setSetting(connSetting(id, 'LastStatus'), r.ok ? (r.empty ? 'empty' : 'ok') : 'error')
  await setSetting(connSetting(id, 'LastCount'), String(r.count ?? 0))
  if (!r.ok && !r.empty) {
    await log('error', 'misp', `Коннектор ${id}: ${r.error}`)
  }
  return r
}

/** Тик планировщика: запускаем включённые коннекторы с истёкшим интервалом. */
export async function connectorTick(): Promise<{ ran: string[] }> {
  const s = await getSettings()
  const ran: string[] = []
  for (const id of CONNECTOR_IDS) {
    if (s[connSetting(id, 'Enabled')] !== 'true') continue
    const interval = parseInt(s[connSetting(id, 'Interval')] ?? '15', 10) || 15
    if (!connectorDue(s[connSetting(id, 'LastRun')] || undefined, interval, Date.now())) continue
    const r = await runConnector(id)
    ran.push(`${id}:${r.ok ? (r.empty ? 'empty' : `ok(${r.count ?? 0})`) : 'error'}`)
  }
  return { ran }
}

let loopTimer: ReturnType<typeof setInterval> | null = null
let ticking = false

/** Ленивый старт цикла коннекторов (60 c): вызывается из /api/misp и /api/dashboard. */
export function ensureConnectorLoop(): void {
  if (loopTimer) return
  loopTimer = setInterval(() => {
    if (ticking) return
    ticking = true
    void connectorTick()
      .catch((e) => log('error', 'misp', `Ошибка цикла коннекторов: ${(e as Error).message}`))
      .finally(() => {
        ticking = false
      })
  }, 60_000)
  loopTimer.unref?.()
}

/** Состояние коннекторов для UI. */
export interface ConnectorStateRow {
  id: ConnectorId
  enabled: boolean
  interval: number
  lastRun: string
  lastStatus: string
  lastCount: number
}

export async function connectorStates(): Promise<ConnectorStateRow[]> {
  const s = await getSettings()
  return CONNECTOR_IDS.map((id) => ({
    id,
    enabled: s[connSetting(id, 'Enabled')] === 'true',
    interval: parseInt(s[connSetting(id, 'Interval')] ?? '15', 10) || 15,
    lastRun: s[connSetting(id, 'LastRun')] ?? '',
    lastStatus: s[connSetting(id, 'LastStatus')] ?? '',
    lastCount: parseInt(s[connSetting(id, 'LastCount')] ?? '0', 10) || 0,
  }))
}
