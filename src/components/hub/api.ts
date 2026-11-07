'use client'

// Клиентский слой для Rules Hub API

export interface SourceItem {
  id: string
  name: string
  category: string
  kind: string
  url: string | null
  authType: string
  extraJson: string | null
  enabled: boolean
  priority: number
  status: string
  lastFetchAt: string | null
  lastError: string | null
  ruleCount: number
  sizeBytes: number
  badge: string | null
  notes: string | null
  builtin: boolean
}

export interface WgPeer {
  publicKey?: string
  endpoint?: string
  allowedIps?: string
  latestHandshake?: string
  transferRx?: string
  transferTx?: string
  online: boolean
}
export interface WgIface {
  name: string
  publicKey?: string
  listeningPort?: string
  peers: WgPeer[]
}
export interface VpnState {
  available: boolean
  error?: string
  interfaces: WgIface[]
  tools: { wgQuick: boolean; wg: boolean; tunDevice: boolean; netAdmin: boolean; sysctl: boolean; srcValidMark: boolean; notes: string[] }
  configOk?: { ok: boolean; error?: string; iface?: string; peers?: number; endpoint?: string }
  profiles?: Array<{
    id: string
    name: string
    active: boolean
    lastCheckAt: string | null
    config: string
    lastStatusJson?: string | null
  }>
}

export interface BuildStats {
  totalInputRules: number
  uniqueSids: number
  duplicateBySid: number
  duplicateByContent: number
  incompatibleDropped: number
  renumbered: number
  perSource: Record<string, { total: number; kept: number; droppedSid: number; droppedContent: number; droppedCompat: number }>
}

export interface Dashboard {
  sources: { total: number; enabled: number; ok: number; error: number; list: SourceItem[] }
  rules: { inDb: number; inBuild: number }
  lastBuild: null | {
    id: string
    createdAt: string
    totalRules: number
    fileName: string
    filePath: string
    sha256: string
    sizeBytes: number
    source: string
    stats: BuildStats
  }
  settings: Record<string, string>
  vpn: VpnState
  logs: Array<{ id: number; ts: string; level: string; scope: string; message: string }>
}

async function j<T>(res: Response): Promise<T> {
  // читаем тело как текст: при 500 от Next.js оно может быть не-JSON,
  // и важно показать пользователю реальную причину, а не безликий «HTTP 500»
  const text = await res.text().catch(() => '')
  let data: Record<string, unknown> = {}
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // не-JSON ответ (страница ошибки прокси/сервера) — покажем фрагмент текста
  }
  if (!res.ok) {
    const err = (data as { error?: string }).error
    throw new Error(err ?? `HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
  }
  return data as T
}

export const api = {
  dashboard: () => fetch('/api/dashboard', { cache: 'no-store' }).then((r) => j<Dashboard>(r)),
  fetchAll: () => fetch('/api/fetch-all', { method: 'POST' }).then((r) => j<{ ok: number; failed: number; errors: string[] }>(r)),
  fetchSource: (id: string) => fetch(`/api/sources/${id}/fetch`, { method: 'POST' }).then((r) => j<{ ok: boolean; count: number; error?: string }>(r)),
  patchSource: (id: string, data: Partial<SourceItem>) =>
    fetch(`/api/sources/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ source: SourceItem }>(r)),
  deleteSource: (id: string) => fetch(`/api/sources/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
  createSource: (data: Record<string, unknown>) =>
    fetch('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ source: SourceItem }>(r)),
  build: (exportAfter: boolean) =>
    fetch('/api/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ export: exportAfter }) }).then((r) => j<{ ok: boolean; total?: number; fileName?: string; error?: string; export?: { ok: boolean; error?: string; detail?: string } }>(r)),
  exportPush: () => fetch('/api/export', { method: 'POST' }).then((r) => j<{ ok: boolean; error?: string; detail?: string; pushedTo?: string }>(r)),
  exportFiles: () => fetch('/api/export', { method: 'PUT' }).then((r) => j<{ files: Array<{ name: string; size: number; mtime: string }> }>(r)),
  rules: (params: string) => fetch(`/api/rules?${params}`, { cache: 'no-store' }).then((r) => j<{ total: number; rules: RuleRow[] }>(r)),
  settings: () => fetch('/api/settings', { cache: 'no-store' }).then((r) => j<{ settings: Record<string, string> }>(r)),
  saveSettings: (data: Record<string, string>) =>
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ settings: Record<string, string> }>(r)),
  vpn: () => fetch('/api/vpn', { cache: 'no-store' }).then((r) => j<VpnState>(r)),
  vpnAction: (body: Record<string, unknown>) =>
    fetch('/api/vpn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<Record<string, unknown>>(r)),
  vpnSave: (name: string, config: string) =>
    fetch('/api/vpn', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, config }) }).then((r) => j<{ profile: { id: string } }>(r)),
  vpnDelete: (id: string) => fetch(`/api/vpn?id=${id}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
  logs: (take = 200) => fetch(`/api/logs?take=${take}`, { cache: 'no-store' }).then((r) => j<{ logs: Dashboard['logs'] }>(r)),
}

export interface RuleRow {
  id: number
  sid: number
  rev: number
  action: string
  proto: string
  msg: string | null
  raw: string
  suricataOk: boolean
  compatNotes: string | null
  sourceName: string
}

export function fmtSize(n: number): string {
  if (!n) return '0 Б'
  if (n < 1024) return `${n} Б`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} КБ`
  return `${(n / 1048576).toFixed(1)} МБ`
}

export function fmtTime(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
