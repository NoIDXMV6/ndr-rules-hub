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
  // диф последней загрузки vs предыдущей: добавлено/изменено/удалено
  diffAdded: number
  diffChanged: number
  diffRemoved: number
  badge: string | null
  notes: string | null
  notesEn: string | null
  builtin: boolean
  deletedAt: string | null
  ownerId?: string | null
  createdAt?: string // порядок добавления — основа стабильной сортировки списка
}

/** Диф правил: агрегат по обновлению источников / сборке */
export interface RulesDiff {
  added: number
  changed: number
  removed: number
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
    /** имя интерфейса из конфига (# InterfaceName: или wg0) */
    iface?: string
    /** реальное состояние: интерфейс есть в `wg show interfaces` */
    ifaceUp?: boolean
  }>
}

export interface BuildStats {
  totalInputRules: number
  uniqueSids: number
  duplicateBySid: number
  duplicateByContent: number
  incompatibleDropped: number
  renumbered: number
  conflictingRemoved?: number
  sanitizedForScirius?: number
  excludedByCategory?: number
  excludedByRule?: number
  changes?: RulesDiff
  archive?: { fileName: string; filePath: string; sizeBytes: number; files: Array<{ name: string; rules: number; sha256: string }> }
  perSource: Record<string, { total: number; kept: number; droppedSid: number; droppedContent: number; droppedCompat: number }>
}

export interface CategoryItem {
  id: string | null
  name: string
  label: string | null
  enabled: boolean
  hidden: boolean
  rules: number
  sources: number
  known: boolean
}

export interface CategoriesState {
  categories: CategoryItem[]
  totalRules: number
  activeSources: number
  overridesOff: number
  overridesAll: number
  uncategorized: string
  categoriesRows: number
}

export interface CategoryRuleRow {
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
  overrideEnabled: boolean | null
}

export interface Dashboard {
  sources: { total: number; enabled: number; ok: number; error: number; trash: number; list: SourceItem[] }
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

// ── Системный мониторинг («Обзор») ───────────────────────────────────────────

export interface CpuInfo {
  usagePct: number
  load1: number
  load5: number
  load15: number
  cores: number
}

export interface MemInfo {
  totalMb: number
  freeMb: number
  availableMb: number
  usedMb: number
  usedPct: number
}

export interface DiskInfo {
  fs: string
  type: string
  mount: string
  totalMb: number
  usedMb: number
  freeMb: number
  usedPct: number
  isData: boolean
}

export interface NetIface {
  iface: string
  rxBytes: number
  txBytes: number
  up: boolean
}

export interface ContainersInfo {
  available: boolean
  error?: string
  hint?: string
  list: Array<{ name: string; image: string; status: string; state: string; up: boolean; isHub: boolean }>
}

export interface CleanupAction {
  cleaner: string
  ok: boolean
  dryRun: boolean
  detail: string
  freedBytes: number
  items?: string[]
  skipped?: string
}

export interface CleanupReport {
  dryRun: boolean
  triggeredBy: string
  startedAt: string
  finishedAt: string
  freedBytes: number
  diskBefore: { mount: string; usedPct: number; freeMb: number } | null
  diskAfter: { mount: string; usedPct: number; freeMb: number } | null
  actions: CleanupAction[]
}

export interface CleanupSettingsUi {
  autoEnabled: boolean
  schedule: string
  triggerPct: number
  freeTargetPct: number
  osEnabled: boolean
  osKeepDays: number
  osPrefixes: string[]
  osMaxDelete: number
  osUrl: string
  cacheEnabled: boolean
  cacheKeepDays: number
  logsEnabled: boolean
  logDirs: string[]
  logKeepDays: number
  filesEnabled: boolean
  fileDirs: string[]
  largeFileMb: number
  fileKeepDays: number
  filesDelete: boolean
  diskWarnPct: number
  diskCriticalPct: number
}

export interface SystemStats {
  ts: string
  uptimeSec: number
  cpu: CpuInfo
  mem: MemInfo
  disks: DiskInfo[]
  net: NetIface[]
  containers: ContainersInfo
  wg: WgState
  cleanup: { lastRun: CleanupReport | null; settings: CleanupSettingsUi }
  notify: null | {
    telegram: { enabled: boolean; configured: boolean }
    gotify: { enabled: boolean; configured: boolean }
  }
}

// алиас, чтобы не ломать существующие импорты
export type WgState = VpnState

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
  fetchAll: () => fetch('/api/fetch-all', { method: 'POST' }).then((r) => j<{ ok: number; failed: number; errors: string[]; diff?: RulesDiff; unchangedSources?: number; changesTotal?: number }>(r)),
  fetchSource: (id: string) => fetch(`/api/sources/${id}/fetch`, { method: 'POST' }).then((r) => j<{ ok: boolean; count: number; error?: string; note?: string; diff?: RulesDiff & { unchanged: boolean } }>(r)),
  patchSource: (id: string, data: Partial<SourceItem>) =>
    fetch(`/api/sources/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ source: SourceItem }>(r)),
  deleteSource: (id: string) => fetch(`/api/sources/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean; trashed?: boolean; purged?: boolean }>(r)),
  restoreSource: (id: string) => fetch(`/api/sources/${id}/restore`, { method: 'POST' }).then((r) => j<{ ok: boolean }>(r)),
  purgeSource: (id: string) => fetch(`/api/sources/${id}?purge=1`, { method: 'DELETE' }).then((r) => j<{ ok: boolean; purged?: boolean }>(r)),
  createSource: (data: Record<string, unknown>) =>
    fetch('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ source: SourceItem }>(r)),
  build: (exportAfter: boolean) =>
    fetch('/api/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ export: exportAfter }) }).then((r) => j<{ ok: boolean; jobId: string; alreadyRunning?: boolean; origin?: string; error?: string }>(r)),
  buildProgress: () => fetch('/api/build/progress', { cache: 'no-store' }).then((r) => j<{ progress: BuildProgressInfo | null }>(r)),
  /** Запустить сборку и дождаться завершения (опрос /api/build/progress).
   *  onProgress вызывается на каждый опрос — вкладка «Сборка» рисует по нему прогрессбар.
   *  Возвращает результат сборки (или null — маршрут прогресса недоступен/таймаут). */
  buildWait: async (exportAfter: boolean, onProgress?: (p: BuildProgressInfo) => void): Promise<BuildResultInfo | null> => {
    const start = await api.build(exportAfter)
    if (!start.ok) throw new Error(start.error ?? 'не удалось запустить сборку')
    const started = Date.now()
    while (Date.now() - started < 15 * 60_000) {
      const pr = await api.buildProgress().catch(() => null)
      const p = pr?.progress ?? null
      if (p) onProgress?.(p)
      if (p && !p.active) return p.result
      // маршрут прогресса недоступен (старый сервер) — не зависаем
      if (!p && Date.now() - started > 5000) return null
      await new Promise((res) => setTimeout(res, 1000))
    }
    return null
  },
  exportPush: () => fetch('/api/export', { method: 'POST' }).then((r) => j<{ ok: boolean; error?: string; detail?: string; pushedTo?: string }>(r)),
  exportFiles: () => fetch('/api/export', { method: 'PUT' }).then((r) => j<{ files: Array<{ name: string; size: number; mtime: string }> }>(r)),
  rules: (params: string) => fetch(`/api/rules?${params}`, { cache: 'no-store' }).then((r) => j<{ total: number; rules: RuleRow[] }>(r)),
  categories: () => fetch('/api/categories', { cache: 'no-store' }).then((r) => j<CategoriesState>(r)),
  categoriesScan: () => fetch('/api/categories', { method: 'POST' }).then((r) => j<{ ok: boolean; added: number; categories: number; totalRules: number; rows: number }>(r)),
  categoriesBulk: (enabled: boolean) =>
    fetch('/api/categories', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }).then((r) => j<{ ok: boolean; updated: number }>(r)),
  patchCategory: (id: string, data: { enabled?: boolean; label?: string | null; hidden?: boolean }) =>
    fetch(`/api/categories/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ category: { id: string; name: string; label: string | null; enabled: boolean; hidden: boolean } }>(r)),
  categoryRules: (id: string, params: string) =>
    fetch(`/api/categories/${id}/rules?${params}`, { cache: 'no-store' }).then((r) => j<{ total: number; page: number; perPage: number; category: { id: string; name: string; label: string | null; enabled: boolean }; rules: CategoryRuleRow[] }>(r)),
  setRuleOverride: (categoryId: string, sid: number, enabled: boolean) =>
    fetch(`/api/categories/${categoryId}/rules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, enabled }) }).then((r) => j<{ ok: boolean; override: { sid: number; enabled: boolean } }>(r)),
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
  // системный мониторинг («Обзор») и очистка диска
  system: () => fetch('/api/system', { cache: 'no-store' }).then((r) => j<SystemStats>(r)),
  systemAction: (body: Record<string, unknown>) =>
    fetch('/api/system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<{ ok: boolean; report?: CleanupReport; ran?: boolean; notified?: string; error?: string }>(r)),
  // уведомления: тест канала, развёртывание Gotify
  notifyAction: (body: Record<string, unknown>) =>
    fetch('/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<Record<string, unknown>>(r)),
  notifyState: () => fetch('/api/notify', { cache: 'no-store' }).then((r) => j<{ gotify: { containerRunning: boolean; url?: string; port: number } }>(r)),
  // обновление Clear NDR
  updateStatus: () => fetch('/api/clearndr-update', { cache: 'no-store' }).then((r) => j<UpdateStatus>(r)),
  updateRun: (runId: string, tail = 24000) => fetch(`/api/clearndr-update?log=${encodeURIComponent(runId)}&tail=${tail}`, { cache: 'no-store' }).then((r) => j<UpdateRunStatus>(r)),
  updateAction: (body: Record<string, unknown>) =>
    fetch('/api/clearndr-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<Record<string, unknown>>(r)),
  updateSaveSettings: (data: Partial<UpdateSettingsUi>) =>
    fetch('/api/clearndr-update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ ok: boolean; settings: UpdateStatus['settings'] }>(r)),
  // дашборды OpenSearch (аналитика)
  osdStatus: () => fetch('/api/clearndr-osd', { cache: 'no-store' }).then((r) => j<OsdStatus>(r)),
  osdRun: (runId: string, tail = 24000) => fetch(`/api/clearndr-osd?log=${encodeURIComponent(runId)}&tail=${tail}`, { cache: 'no-store' }).then((r) => j<OsdRunStatus>(r)),
  osdAction: (body: Record<string, unknown>) =>
    fetch('/api/clearndr-osd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<Record<string, unknown>>(r)),
  // многопользовательский режим (Enterprise)
  me: () => fetch('/api/auth/me', { cache: 'no-store' }).then((r) => j<Me>(r)),
  captcha: () => fetch('/api/auth/captcha', { cache: 'no-store' }).then((r) => j<Captcha>(r)),
  login: (data: { email: string; password: string; captchaId?: string; captchaAnswer?: string }) =>
    fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<Record<string, unknown>>(r)),
  loginVerify: (code: string) =>
    fetch('/api/auth/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => j<Record<string, unknown>>(r)),
  // аварийный сброс 2FA администратором при входе из локальной сети (пароль в теле)
  loginReset2fa: (password: string) =>
    fetch('/api/auth/login/reset-2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }).then((r) => j<Record<string, unknown>>(r)),
  register: (data: { email: string; displayName: string; password: string; twoFactor: string; telegramUsername?: string; captchaId?: string; captchaAnswer?: string }) =>
    fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<Record<string, unknown>>(r)),
  registerVerify: (code: string) =>
    fetch('/api/auth/register/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => j<Record<string, unknown>>(r)),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then((r) => j<{ ok: boolean }>(r)),
  account: () => fetch('/api/auth/account', { cache: 'no-store' }).then((r) => j<AccountInfo>(r)),
  accountAction: (body: Record<string, unknown>) =>
    fetch('/api/auth/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<Record<string, unknown>>(r)),
  users: () => fetch('/api/auth/users', { cache: 'no-store' }).then((r) => j<{ users: UserItem[]; registrationOpen: boolean }>(r)),
  userAction: (id: string, action: string) =>
    fetch(`/api/auth/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).then((r) => j<{ ok: boolean; user?: UserItem }>(r)),
  userDelete: (id: string) =>
    fetch(`/api/auth/users/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
  registrationOpen: (open: boolean) =>
    fetch('/api/auth/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationOpen: open }) }).then((r) => j<{ ok: boolean; registrationOpen: boolean }>(r)),
  authEvents: (take = 100) => fetch(`/api/auth/events?take=${take}`, { cache: 'no-store' }).then((r) => j<{ events: AuthEventItem[] }>(r)),
  tokens: () => fetch('/api/tokens', { cache: 'no-store' }).then((r) => j<{ tokens: DownloadTokenItem[] }>(r)),
  createToken: (data: { name: string; ttlDays?: number }) =>
    fetch('/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => j<{ ok: boolean; token?: { id: string; token: string; name: string; prefix: string; expiresAt: string | null }; error?: string }>(r)),
  revokeToken: (id: string) => fetch(`/api/tokens/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
  restoreToken: (id: string) =>
    fetch(`/api/tokens/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'restore' }) }).then((r) => j<{ ok: boolean }>(r)),
  deleteToken: (id: string) =>
    fetch(`/api/tokens/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete' }) }).then((r) => j<{ ok: boolean }>(r)),
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
  composeOk?: boolean
  composeErr?: string
  maxMapCount?: number
  memAvailMb?: number
  dockerRoot?: string
  diskFreeMb?: number
  webHttp?: string
  apiHttp?: string
  apiSources?: string
  apiBase?: string
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
  cancelled?: boolean
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
    osdEsUrl: string
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
  cancelled?: boolean
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
  osdEsUrl: string
}

// ── Раздел «Дашборды OpenSearch» ─────────────────────────────────────────────

export interface OsdProbe {
  ok: boolean
  mode: 'ssh' | 'local'
  error?: string
  cluster?: string
  esVersion?: string
  osdVersion?: string
  esUrl?: string
  esChannel?: string
  dockerStatus?: string
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
  cancelled?: boolean
  args: string[]
  remoteDir?: string
}

export interface OsdStatus {
  settings: UpdateSettingsUi & { sshKeySet: boolean }
  packs: string[]
  applyKinds: string[]
  probe: OsdProbe
  activeRun: { runId: string; active: boolean; exitCode?: number; startedAt?: string; cancelled?: boolean } | null
  runs: OsdRunMeta[]
}

export interface OsdRunStatus {
  runId: string
  active: boolean
  exitCode?: number
  cancelled?: boolean
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

// ── Многопользовательский режим (Enterprise): аутентификация, токены ─────────

export interface Me {
  edition: 'community' | 'enterprise'
  multiUser: boolean
  authenticated: boolean
  user: { id: string; email: string; displayName: string; role: 'admin' | 'user'; status: 'pending' | 'active' | 'disabled' } | null
  twoFactor?: { twoFactor: 'none' | 'telegram' | 'totp'; telegramUsername: string | null; telegramBound: boolean; totpEnabled: boolean } | null
  needsBootstrap?: boolean
  registrationOpen?: boolean
}

export interface UserItem {
  id: string
  email: string
  displayName: string
  role: 'admin' | 'user'
  status: 'pending' | 'active' | 'disabled'
  verifiedAt: string | null
  verifiedBy: string | null
  lastLoginAt: string | null
  createdAt: string
  lockedUntil: string | null
  twoFactor?: 'none' | 'telegram' | 'totp'
  telegramUsername?: string | null
  telegramBound?: boolean
  activeSessions?: number
  tokens?: number
}

export interface AccountInfo {
  email: string
  displayName: string
  role: string
  status: string
  twoFactor: 'none' | 'telegram' | 'totp'
  telegramUsername: string | null
  telegramBound: boolean
  totpEnabled: boolean
  botLink: string | null
}

// ── Капча (вход/регистрация) ─────────────────────────────────────────────────

export interface Captcha {
  captchaId: string
  svg: string
  expiresSec: number
}

export interface AuthEventItem {
  id: number
  ts: string
  kind: string
  email: string | null
  userId: string | null
  ip: string | null
  detail: string | null
}

export interface DownloadTokenItem {
  id: string
  name: string
  prefix: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  lastIp: string | null
  downloadCount: number
  bytesServed: number
  owner?: string
  ownerName?: string
  own: boolean
}

// ── Прогресс сборки (GET /api/build/progress) ──────────────────────────────

/** Фазы сборки — совпадают с кодами в src/lib/engine/build-progress.ts */
export const BUILD_STAGES = [
  'db-read', 'filter', 'merge', 'conflict-dedup', 'sanitize', 'remap', 'sid-check',
  'render', 'diff', 'save', 'archive', 'db-write', 'export', 'done',
] as const

export interface BuildProgressInfo {
  jobId: string
  origin: string
  active: boolean
  stage: string
  percent: number
  startedAt: string
  finishedAt: string | null
  error: string | null
  log: Array<{ ts: string; msg: string }>
  result: BuildResultInfo | null
}

/** Финальный результат сборки (из GET /api/build/progress после завершения) */
export interface BuildResultInfo {
  ok: boolean
  error?: string
  total?: number
  fileName?: string
  changes?: RulesDiff | null
  unchanged?: boolean
  export?: { ok: boolean; error?: string; detail?: string; pushedTo?: string } | null
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
