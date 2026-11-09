'use client'

// Клиентский слой для Rules Hub API

import type { Lang } from '@/lib/i18n/detect'

const SIZE_UNITS: Record<Lang, { B: string; KB: string; MB: string }> = {
  ru: { B: 'Б', KB: 'КБ', MB: 'МБ' },
  en: { B: 'B', KB: 'KB', MB: 'MB' },
}

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
  fetchSource: (id: string) => fetch(`/api/sources/${id}/fetch`, { method: 'POST' }).then((r) => j<{ ok: boolean; count: number; error?: string; note?: string }>(r)),
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
  // обновление Clear NDR
  updateStatus: () => fetch('/api/clearndr-update', { cache: 'no-store' }).then((r) => j<UpdateStatus>(r)),
  updateRun: (runId: string, tail = 24000) => fetch(`/api/clearndr-update?log=${encodeURIComponent(runId)}&tail=${tail}`, { cache: 'no-store' }).then((r) => j<UpdateRunStatus>(r)),
  updateAction: (body: Record<string, unknown>) =>
    fetch('/api/clearndr-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<Record<string, unknown>>(r)),
  updateSaveSettings: (data: UpdateSettingsUi) =>
    fetch('/api/clearndr-update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ ok: boolean; settings: UpdateStatus['settings'] }>(r)),
  // дашборды OpenSearch (аналитика)
  osdStatus: () => fetch('/api/clearndr-osd', { cache: 'no-store' }).then((r) => j<OsdStatus>(r)),
  osdRun: (runId: string, tail = 24000) => fetch(`/api/clearndr-osd?log=${encodeURIComponent(runId)}&tail=${tail}`, { cache: 'no-store' }).then((r) => j<OsdRunStatus>(r)),
  osdAction: (body: Record<string, unknown>) =>
    fetch('/api/clearndr-osd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<Record<string, unknown>>(r)),
}

// ── Раздел «Обновление Clear NDR» ────────────────────────────────────────────

export interface StackContainerRow {
  name: string
  status: string
  up: boolean
  service?: string
}

export interface HostProbe {
  ok: boolean
  mode: 'ssh' | 'local'
  error?: string
  stamusctl?: string
  stackVersion?: string
  osTag?: string
  pgTag?: string
  suricataInterfaces?: string
  mikrocata?: boolean
  maxMapCount?: number
  memAvailMb?: number
  dockerRoot?: string
  diskFreeMb?: number
  webHttp?: string
  apiHttp?: string
  apiSources?: string
  containers: StackContainerRow[]
  ranAt: string
}

export interface LatestRelease {
  tag: string
  name?: string
  publishedAt?: string
  url?: string
  error?: string
}

export interface UpdateOptionsUi {
  version: string
  opensearchData: 'keep' | 'wipe'
  pgStrategy: 'restore'
  updateCli: boolean
  skipDbDump: boolean
  skipVolume: boolean
  fullConfig: boolean
  skipMikrocataCheck: boolean
  healthTimeout: number
}

export interface UpdateRunMeta {
  runId: string
  mode: 'ssh' | 'local'
  startedAt: string
  finishedAt?: string
  exitCode?: number
  options: UpdateOptionsUi
  args: string[]
  remoteDir?: string
  logPath?: string
}

export interface UpdateStatus {
  settings: {
    updateMode: 'ssh' | 'local'
    sshHost: string
    sshPort: string
    sshUser: string
    sshKey: string
    sudoMode: 'auto' | 'sudo' | 'plain'
    instanceDir: string
    scriptPath: string
    healthUrl: string
    apiToken: string
    sshKeySet: boolean
  }
  latest: LatestRelease
  host: HostProbe
  updateAvailable: boolean | null
  activeRun: { runId: string; active: boolean; exitCode?: number; startedAt?: string } | null
  runs: UpdateRunMeta[]
}

export interface UpdateRunStatus {
  runId: string
  active: boolean
  exitCode?: number
  log: string
  startedAt?: string
  finishedAt?: string
}

export interface UpdateSettingsUi {
  updateMode: string
  sshHost: string
  sshPort: string
  sshUser: string
  sshKey: string
  sudoMode: string
  instanceDir: string
  scriptPath: string
  healthUrl: string
  apiToken: string
}

// ── Раздел «Дашборды OpenSearch» ─────────────────────────────────────────────

export interface OsdProbe {
  ok: boolean
  mode: 'ssh' | 'local'
  error?: string
  cluster?: string
  esVersion?: string
  osdVersion?: string
  alerting?: boolean
  anomaly?: boolean
  security?: boolean
  indices?: number
  docs?: number
  packs?: number
  monitors?: number
  adetectors?: number
  sdetectors?: number
  ranAt: string
}

export interface OsdRunMeta {
  runId: string
  mode: 'ssh' | 'local'
  kind: 'apply' | 'import' | 'remove'
  startedAt: string
  finishedAt?: string
  exitCode?: number
  args: string[]
  remoteDir?: string
}

export interface OsdStatus {
  settings: UpdateSettingsUi & { sshKeySet: boolean }
  packs: string[]
  applyKinds: string[]
  probe: OsdProbe
  activeRun: { runId: string; active: boolean; exitCode?: number } | null
  runs: OsdRunMeta[]
}

export interface OsdRunStatus {
  runId: string
  active: boolean
  exitCode?: number
  log: string
  startedAt?: string
  finishedAt?: string
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

// lang — язык интерфейса (единицы и формат даты); по умолчанию ru — для совместимости
export function fmtSize(n: number, lang: Lang = 'ru'): string {
  const u = SIZE_UNITS[lang]
  if (!n) return `0 ${u.B}`
  if (n < 1024) return `${n} ${u.B}`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} ${u.KB}`
  return `${(n / 1048576).toFixed(1)} ${u.MB}`
}

export function fmtTime(ts: string | null, lang: Lang = 'ru'): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
