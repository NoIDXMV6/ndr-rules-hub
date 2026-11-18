// ─────────────────────────────────────────────────────────────────────────────
// Автоочистка диска: контроль свободного места на томе данных хаба и хосте.
// Очистители (каждый включается отдельно в «Настройки»):
//   1. cache       — кэш архивов источников хаба (data/cache) и temp-каталоги сборок;
//   2. logs        — логи в указанных каталогах (логи suricata с хоста: каталог
//                    монтируется в контейнер и перечисляется в cleanupLogDirs);
//   3. opensearch  — старые индексы OpenSearch ТОЛЬКО из разрешённых префиксов
//                    (logstash-, ndr-, eve-, suricata-, selks-); системные
//                    индексы (.kibana, .opendistro-*, security*) не трогаются;
//   4. files       — большие файлы в явно перечисленных каталогах: по умолчанию
//                    только отчёт, удаление — отдельным переключателем.
// Всё, что не входит в явно разрешённые списки, никогда не удаляется.
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { request, Agent } from 'undici'
import cron from 'node-cron'
import { db } from '@/lib/db'
import { DEFAULT_SETTINGS } from './seed'
import { log, getSettings } from './service'
import { notifyEvent } from './notify'
import { readDisks, type DiskInfo } from './monitor'
import { CACHE_DIR, EXPORTS_DIR, DATA_DIR } from './fetcher'

const execFileP = promisify(execFile)

const SETTING_LAST_RUN = 'cleanupLastRunJson'
const SETTING_LAST_NOTIFY = 'cleanupLastNotifyJson'
const NOTIFY_THROTTLE_MS = 6 * 3600 * 1000 // не чаще раза в 6 часов на уровень

// ── Настройки ────────────────────────────────────────────────────────────────

export interface CleanupSettings {
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

export async function getCleanupSettings(): Promise<CleanupSettings> {
  const s = await getSettings()
  const n = (k: string, d: number) => {
    const v = parseInt(s[k] ?? '', 10)
    return Number.isFinite(v) ? v : d
  }
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean)
  return {
    autoEnabled: s.cleanupAutoEnabled === 'true',
    schedule: s.cleanupSchedule || DEFAULT_SETTINGS.cleanupSchedule,
    triggerPct: n('cleanupTriggerPct', 90),
    freeTargetPct: n('cleanupFreeTargetPct', 80),
    osEnabled: s.cleanupOsEnabled !== 'false',
    osKeepDays: n('cleanupOsKeepDays', 14),
    osPrefixes: list(s.cleanupOsPrefixes || DEFAULT_SETTINGS.cleanupOsPrefixes),
    osMaxDelete: n('cleanupOsMaxDelete', 50),
    osUrl: s.cleanupOsUrl || '',
    cacheEnabled: s.cleanupCacheEnabled !== 'false',
    cacheKeepDays: n('cleanupCacheKeepDays', 14),
    logsEnabled: s.cleanupLogsEnabled !== 'false',
    logDirs: list(s.cleanupLogDirs || ''),
    logKeepDays: n('cleanupLogKeepDays', 7),
    filesEnabled: s.cleanupFilesEnabled === 'true',
    fileDirs: list(s.cleanupFileDirs || ''),
    largeFileMb: n('cleanupLargeFileMb', 500),
    fileKeepDays: n('cleanupFileKeepDays', 7),
    filesDelete: s.cleanupFilesDelete === 'true',
    diskWarnPct: n('diskWarnPct', 85),
    diskCriticalPct: n('diskCriticalPct', 92),
  }
}

// ── Диск с данными хаба ──────────────────────────────────────────────────────

/** Диск, на котором лежат данные хаба (БД, кэш, сборки) — главный контролируемый том */
export async function dataDisk(): Promise<DiskInfo | null> {
  const disks = await readDisks()
  return disks.find((d) => d.isData) ?? disks.sort((a, b) => b.usedPct - a.usedPct)[0] ?? null
}

// ── Типы отчёта ──────────────────────────────────────────────────────────────

export interface CleanupAction {
  cleaner: 'cache' | 'logs' | 'opensearch' | 'files'
  ok: boolean
  dryRun: boolean
  detail: string
  freedBytes: number
  items?: string[]
  skipped?: string
}

export interface CleanupReport {
  dryRun: boolean
  triggeredBy: 'manual' | 'auto'
  startedAt: string
  finishedAt: string
  freedBytes: number
  diskBefore: { mount: string; usedPct: number; freeMb: number } | null
  diskAfter: { mount: string; usedPct: number; freeMb: number } | null
  actions: CleanupAction[]
}

const snapDisk = (d: DiskInfo | null) =>
  d ? { mount: d.mount, usedPct: d.usedPct, freeMb: d.freeMb } : null

// ── Ходьба по каталогу (с ограничением глубины) ──────────────────────────────

interface FoundFile {
  path: string
  size: number
  mtimeMs: number
}

async function walkFiles(root: string, maxDepth: number): Promise<FoundFile[]> {
  const out: FoundFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import('fs').Dirent[] = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(p, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      try {
        const st = await fs.stat(p)
        out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* файл мог исчезнуть в момент обхода */
      }
    }
  }
  await walk(root, 0)
  return out
}

const DAY_MS = 24 * 3600 * 1000
const ageDays = (mtimeMs: number) => (Date.now() - mtimeMs) / DAY_MS
const fmtMb = (b: number) => `${(b / 1048576).toFixed(1)} МБ`

/** Удалить файл, посчитав освобождённое место (в dry-run только считается) */
async function removeFile(f: FoundFile, dryRun: boolean): Promise<void> {
  if (!dryRun) await fs.rm(f.path, { force: true }).catch(() => undefined)
}

/** Убрать опустевшие каталоги после очистки (не выше root) */
async function removeEmptyDirs(root: string): Promise<void> {
  const walk = async (dir: string): Promise<boolean> => {
    let entries: import('fs').Dirent[] = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let empty = true
    for (const e of entries) {
      if (e.isDirectory()) {
        const childEmpty = await walk(path.join(dir, e.name))
        if (childEmpty) await fs.rmdir(path.join(dir, e.name)).catch(() => undefined)
        else empty = false
      } else {
        empty = false
      }
    }
    return empty && entries.every((e) => e.isDirectory())
  }
  await walk(root)
}

// ── Очиститель 1: кэш хаба ───────────────────────────────────────────────────

/** Файлы кэша источников и temp-каталоги сборок (безопасно: всё пересоздаётся) */
async function cleanHubCache(dryRun: boolean, keepDays: number): Promise<CleanupAction> {
  const items: string[] = []
  let freed = 0
  const candidates: FoundFile[] = []
  // кэш источников: архивы/распакованные наборы старше keepDays
  candidates.push(...(await walkFiles(CACHE_DIR, 4)).filter((f) => ageDays(f.mtimeMs) > keepDays))
  // temp-каталоги сборок .pack-* старше суток — остатки упавших сборок
  try {
    const entries = await fs.readdir(EXPORTS_DIR, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('.pack-')) continue
      const p = path.join(EXPORTS_DIR, e.name)
      const st = await fs.stat(p).catch(() => null)
      if (st && Date.now() - st.mtimeMs > DAY_MS) candidates.push({ path: p, size: 0, mtimeMs: st.mtimeMs })
    }
  } catch { /* нет каталога экспортов */ }
  for (const f of candidates) {
    freed += f.size
    items.push(`${path.relative(DATA_DIR, f.path) || f.path} (${fmtMb(f.size)}, ${Math.floor(ageDays(f.mtimeMs))} дн.)`)
    if (f.size === 0 && !dryRun) await fs.rm(f.path, { recursive: true, force: true }).catch(() => undefined)
    else await removeFile(f, dryRun)
  }
  if (!dryRun) await removeEmptyDirs(CACHE_DIR)
  return {
    cleaner: 'cache',
    ok: true,
    dryRun,
    freedBytes: freed,
    detail: candidates.length
      ? `${candidates.length} объект(ов) кэша старше ${keepDays} дн. — ${dryRun ? 'к удалению (dry-run)' : 'удалено'}, освобождено ${fmtMb(freed)}`
      : `кэш чист (нет объектов старше ${keepDays} дн.)`,
    items: items.slice(0, 50),
  }
}

// ── Очиститель 2: каталоги логов ─────────────────────────────────────────────

// активный файл, который suricata/logrotate держит открытым: удалять его нельзя,
// даже если он «старый» (место освобождается только переоткрытием — trunc/rotate)
const ACTIVE_LOG_NAMES = new Set(['eve.json', 'fast.log', 'stats.log', 'suricata.log', 'syslog.log', 'eve.json.new'])

async function cleanLogDirs(dryRun: boolean, dirs: string[], keepDays: number): Promise<CleanupAction> {
  const items: string[] = []
  let freed = 0
  let exists = 0
  for (const dir of dirs) {
    if (!dir.startsWith('/')) continue // относительные пути — не наш случай, пропускаем
    const files = await walkFiles(dir, 3)
    if (files.length > 0) exists++
    for (const f of files) {
      if (ACTIVE_LOG_NAMES.has(path.basename(f.path))) continue
      if (ageDays(f.mtimeMs) <= keepDays) continue
      freed += f.size
      items.push(`${f.path} (${fmtMb(f.size)}, ${Math.floor(ageDays(f.mtimeMs))} дн.)`)
      await removeFile(f, dryRun)
    }
    if (!dryRun) await removeEmptyDirs(dir)
  }
  return {
    cleaner: 'logs',
    ok: true,
    dryRun,
    freedBytes: freed,
    detail: dirs.length === 0
      ? 'каталоги логов не заданы (Настройки → Диск и очистка → «Каталоги логов»)'
      : `${dirs.length} кат., обработано ${exists}: файлов старше ${keepDays} дн. — ${dryRun ? 'к удалению (dry-run)' : 'удалено'}, ${fmtMb(freed)}`,
    items: items.slice(0, 50),
    skipped: dirs.length === 0 ? 'no-dirs' : undefined,
  }
}

// ── Очиститель 3: индексы OpenSearch ─────────────────────────────────────────

export type EsChannel =
  | { kind: 'http'; base: string; headers: Record<string, string> }
  | { kind: 'docker'; container: string }

let insecureAgentEs: Agent | null = null
const esDispatcher = () => (insecureAgentEs ??= new Agent({ connect: { rejectUnauthorized: false } }))

async function probeHttpEs(base: string): Promise<EsChannel | null> {
  let u: URL
  try {
    u = new URL(base)
  } catch {
    return null
  }
  const headers: Record<string, string> = {}
  if (u.username || u.password) {
    headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`
  }
  const clean = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
  try {
    const res = await request(`${clean}/`, {
      headers,
      dispatcher: esDispatcher(),
      headersTimeout: 1500,
      bodyTimeout: 1500,
    })
    await res.body.dump()
    if (res.statusCode !== 200) return null
    return { kind: 'http', base: clean, headers }
  } catch {
    return null
  }
}

/** Канал ES: указанный URL → настройки очистки/OSD → автопоиск → docker exec */
export async function resolveEsChannel(override?: string): Promise<{ channel: EsChannel | null; tried: string[] }> {
  const s = await getSettings()
  const candidates = [
    override,
    s.cleanupOsUrl,
    s.osdEsUrl,
    'https://127.0.0.1:9200',
    'http://127.0.0.1:9200',
    'https://172.17.0.1:9200',
    'http://172.17.0.1:9200',
    'https://host.docker.internal:9200',
    'http://host.docker.internal:9200',
  ].filter((x): x is string => !!x && !!x.trim())
  const tried: string[] = []
  for (const c of candidates) {
    tried.push(c)
    const ch = await probeHttpEs(c.trim())
    if (ch) return { channel: ch, tried }
  }
  // автопоиск через docker exec (OpenSearch на той же машине, прямой доступ закрыт)
  try {
    const ps = await execFileP('docker', ['ps', '--format', '{{.Names}}'], { timeout: 5000 })
    const ct = ps.stdout.split('\n').find((n) => /-opensearch-[A-Za-z0-9_]+$/.test(n.trim()) || n.trim() === 'opensearch')
    if (ct) {
      const r = await execFileP('docker', ['exec', ct.trim(), 'curl', '-sk', '--noproxy', '*', '--max-time', '5', 'http://127.0.0.1:9200/'], { timeout: 12_000 })
      if (r.stdout.includes('"cluster_name"') || r.stdout.includes('"version"')) {
        tried.push(`docker exec ${ct.trim()}`)
        return { channel: { kind: 'docker', container: ct.trim() }, tried }
      }
    }
  } catch { /* docker недоступен */ }
  return { channel: null, tried }
}

async function esRequest(ch: EsChannel, method: string, p: string, body?: string, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
  if (ch.kind === 'http') {
    const res = await request(`${ch.base}${p}`, {
      method,
      headers: body ? { ...ch.headers, 'content-type': 'application/json' } : ch.headers,
      body: body || undefined,
      dispatcher: esDispatcher(),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    })
    const out = await res.body.text()
    return { status: res.statusCode, body: out }
  }
  const args = ['exec', ch.container, 'curl', '-sk', '--noproxy', '*', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-w', '\n%{http_code}', '-X', method]
  if (body) args.push('-H', 'content-type: application/json', '-d', body)
  args.push(`http://127.0.0.1:9200${p}`)
  try {
    const r = await execFileP('docker', args, { timeout: timeoutMs + 10_000 })
    const out = r.stdout
    const m = out.match(/\n(\d{3})$/)
    const status = m ? parseInt(m[1], 10) : 200
    return { status, body: m ? out.slice(0, m.index) : out }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { status: 0, body: err.stderr || err.stdout || 'docker exec failed' }
  }
}

interface OsIndex {
  index: string
  createdMs: number
  sizeBytes: number
}

/** POST/GET c JSON-телом (поиск индексов для коннектора Clear NDR → MISP) */
export async function esQuery(
  ch: EsChannel,
  method: string,
  p: string,
  body: Record<string, unknown> | undefined,
  timeoutMs = 30_000,
): Promise<{ status: number; body: string }> {
  return esRequest(ch, method, p, body ? JSON.stringify(body) : undefined, timeoutMs)
}

/** Список индексов с датой создания и размером (/_cat/indices) */
export async function listOsIndices(ch: EsChannel): Promise<OsIndex[]> {
  const r = await esRequest(ch, 'GET', '/_cat/indices?format=json&h=index,creation.date,store.size', undefined, 20_000)
  if (r.status !== 200) throw new Error(`OpenSearch вернул HTTP ${r.status}: ${r.body.slice(0, 160)}`)
  let arr: Array<Record<string, string>> = []
  try {
    arr = JSON.parse(r.body)
  } catch {
    throw new Error(`не-JSON ответ OpenSearch: ${r.body.slice(0, 120)}`)
  }
  return arr
    .map((x) => ({
      index: x.index ?? '',
      createdMs: parseInt(x['creation.date'] ?? '0', 10) || 0,
      sizeBytes: parseInt(x['store.size'] ?? '0', 10) || 0,
    }))
    .filter((x) => x.index && !x.index.startsWith('.'))
}

/** Кандидаты на удаление: разрешённый префикс + старше keepDays; системные индексы исключены всегда */
export function pickOsCandidates(indices: OsIndex[], prefixes: string[], keepDays: number, maxDelete: number): OsIndex[] {
  const cutoff = Date.now() - keepDays * DAY_MS
  return indices
    .filter((i) => prefixes.some((p) => i.index.startsWith(p)))
    .filter((i) => i.createdMs > 0 && i.createdMs < cutoff)
    .sort((a, b) => a.createdMs - b.createdMs) // сначала самые старые
    .slice(0, Math.max(1, maxDelete))
}

async function cleanOpenSearch(dryRun: boolean, cfg: CleanupSettings): Promise<CleanupAction> {
  const { channel, tried } = await resolveEsChannel()
  if (!channel) {
    return {
      cleaner: 'opensearch',
      ok: false,
      dryRun,
      freedBytes: 0,
      detail: `OpenSearch не найден (пробовал: ${tried.join(', ') || '—'}). Укажите URL в настройках очистки (например http://172.17.0.1:9200) или смонтируйте docker.sock`,
    }
  }
  const indices = await listOsIndices(channel)
  const candidates = pickOsCandidates(indices, cfg.osPrefixes, cfg.osKeepDays, cfg.osMaxDelete)
  if (candidates.length === 0) {
    return {
      cleaner: 'opensearch',
      ok: true,
      dryRun,
      freedBytes: 0,
      detail: `индексов старше ${cfg.osKeepDays} дн. с префиксами [${cfg.osPrefixes.join(', ')}] нет (всего индексов: ${indices.length})`,
    }
  }
  const items: string[] = []
  let freed = 0
  let deleted = 0
  let failed = 0
  for (const c of candidates) {
    if (dryRun) {
      freed += c.sizeBytes
      items.push(`${c.index} (${fmtMb(c.sizeBytes)}, создан ${new Date(c.createdMs).toISOString().slice(0, 10)})`)
      continue
    }
    const r = await esRequest(channel, 'DELETE', `/${encodeURIComponent(c.index)}?master_timeout=30s&timeout=30s`)
    if (r.status === 200 || r.status === 404) {
      // 404 — индекс уже удалён (конкурентно): цель достигнута
      deleted++
      freed += c.sizeBytes
      items.push(`${c.index} (${fmtMb(c.sizeBytes)}) — удалён`)
    } else {
      failed++
      items.push(`${c.index} — ошибка HTTP ${r.status}: ${r.body.slice(0, 100)}`)
    }
  }
  return {
    cleaner: 'opensearch',
    ok: failed === 0,
    dryRun,
    freedBytes: freed,
    detail: `${channel.kind === 'docker' ? `через docker exec (${(channel as { container: string }).container})` : channel.base}: ` +
      `кандидатов ${candidates.length}, ${dryRun ? 'к удалению (dry-run)' : `удалено ${deleted}`}${failed ? `, ошибок ${failed}` : ''}, ${dryRun ? 'оценка' : 'освобождено'} ${fmtMb(freed)}`,
    items: items.slice(0, 50),
  }
}

// ── Очиститель 4: большие файлы ──────────────────────────────────────────────

async function cleanLargeFiles(dryRun: boolean, cfg: CleanupSettings): Promise<CleanupAction> {
  if (cfg.fileDirs.length === 0) {
    return {
      cleaner: 'files',
      ok: true,
      dryRun,
      freedBytes: 0,
      detail: 'каталоги поиска не заданы (Настройки → Диск и очистка → «Где искать большие файлы»)',
      skipped: 'no-dirs',
    }
  }
  const minSize = cfg.largeFileMb * 1048576
  const items: string[] = []
  let freed = 0
  let found = 0
  for (const dir of cfg.fileDirs) {
    if (!dir.startsWith('/')) continue
    const files = await walkFiles(dir, 5)
    for (const f of files) {
      if (f.size < minSize) continue
      if (ageDays(f.mtimeMs) <= cfg.fileKeepDays) continue
      found++
      if (cfg.filesDelete && !dryRun) {
        await removeFile(f, dryRun)
        freed += f.size
        items.push(`${f.path} (${fmtMb(f.size)}) — удалён`)
      } else {
        items.push(`${f.path} (${fmtMb(f.size)}, ${Math.floor(ageDays(f.mtimeMs))} дн.)${cfg.filesDelete ? ' — к удалению (dry-run)' : ' — только отчёт (удаление выключено)'}`)
      }
    }
  }
  return {
    cleaner: 'files',
    ok: true,
    dryRun,
    freedBytes: freed,
    detail: cfg.filesDelete
      ? `найдено ${found} файл(ов) > ${cfg.largeFileMb} МБ и старше ${cfg.fileKeepDays} дн.: ${dryRun ? 'к удалению (dry-run)' : `удалено, ${fmtMb(freed)}`}`
      : `найдено ${found} файл(ов) > ${cfg.largeFileMb} МБ и старше ${cfg.fileKeepDays} дн. — режим «только отчёт» (включите «Удалять найденные файлы» для удаления)`,
    items: items.slice(0, 50),
  }
}

// ── Прогон очистки ───────────────────────────────────────────────────────────

export async function runCleanup(opts: { dryRun?: boolean; triggeredBy?: 'manual' | 'auto' } = {}): Promise<CleanupReport> {
  const dryRun = !!opts.dryRun
  const triggeredBy = opts.triggeredBy ?? 'manual'
  const cfg = await getCleanupSettings()
  const startedAt = new Date().toISOString()
  const before = await dataDisk()
  const actions: CleanupAction[] = []
  let freed = 0

  /** Цель достигнута — дальнейшие очистители не нужны (только для автоочистки:
   *  ручной прогон и dry-run выполняют все включённые шаги — пользователь
   *  ожидает полный отчёт, а не «пропущено») */
  const targetReached = async (): Promise<boolean> => {
    if (triggeredBy !== 'auto' || dryRun) return false
    const d = await dataDisk()
    return !!d && d.usedPct <= cfg.freeTargetPct
  }
  const skip = (cleaner: CleanupAction['cleaner'], reason: string): CleanupAction => ({
    cleaner, ok: true, dryRun, freedBytes: 0, detail: '', skipped: reason,
  })
  const SKIP_TEXT: Record<string, string> = {
    disabled: 'шаг выключен в настройках',
    target: 'цель свободного места уже достигнута — шаг пропущен',
    'no-dirs': 'каталоги не заданы в настройках',
  }
  const finalize = (a: CleanupAction): CleanupAction => {
    if (a.skipped && !a.detail) a.detail = SKIP_TEXT[a.skipped] ?? a.skipped
    freed += a.freedBytes
    actions.push(a)
    return a
  }

  // Шаги по возрастанию «дороговизны»: свой кэш → логи → индексы OpenSearch →
  // большие файлы. Как только свободного места достаточно (freeTargetPct),
  // остальные шаги пропускаются.
  if (!cfg.cacheEnabled) finalize(skip('cache', 'disabled'))
  else if (freed > 0 && (await targetReached())) finalize(skip('cache', 'target'))
  else finalize(await cleanHubCache(dryRun, cfg.cacheKeepDays))

  if (!cfg.logsEnabled || cfg.logDirs.length === 0) finalize(skip('logs', !cfg.logsEnabled ? 'disabled' : 'no-dirs'))
  else if (freed > 0 && (await targetReached())) finalize(skip('logs', 'target'))
  else finalize(await cleanLogDirs(dryRun, cfg.logDirs, cfg.logKeepDays))

  if (!cfg.osEnabled) finalize(skip('opensearch', 'disabled'))
  else if (freed > 0 && (await targetReached())) finalize(skip('opensearch', 'target'))
  else finalize(await cleanOpenSearch(dryRun, cfg))

  if (!cfg.filesEnabled) finalize(skip('files', 'disabled'))
  else finalize(await cleanLargeFiles(dryRun, cfg))

  const finishedAt = new Date().toISOString()
  const after = await dataDisk()
  const report: CleanupReport = {
    dryRun,
    triggeredBy,
    startedAt,
    finishedAt,
    freedBytes: freed,
    diskBefore: snapDisk(before),
    diskAfter: snapDisk(after),
    actions,
  }
  await db.setting
    .upsert({ where: { key: SETTING_LAST_RUN }, create: { key: SETTING_LAST_RUN, value: JSON.stringify(report) }, update: { value: JSON.stringify(report) } })
    .catch(() => undefined)
  await log(dryRun ? 'info' : freed > 0 ? 'success' : 'info', 'cleanup',
    `Очистка диска (${dryRun ? 'dry-run' : triggeredBy}): освобождено ${fmtMb(freed)}; ` +
    actions.map((a) => `${a.cleaner}: ${a.skipped ? `пропущено (${a.skipped})` : a.detail}`).join(' | '))
  return report
}

// ── Статус для UI ────────────────────────────────────────────────────────────

export function parseLastRun(json?: string | null): CleanupReport | null {
  if (!json) return null
  try {
    return JSON.parse(json) as CleanupReport
  } catch {
    return null
  }
}

export async function getCleanupStatus(): Promise<{ lastRun: CleanupReport | null; settings: CleanupSettings }> {
  const [row, settings] = await Promise.all([
    db.setting.findUnique({ where: { key: SETTING_LAST_RUN } }).catch(() => null),
    getCleanupSettings(),
  ])
  return { lastRun: parseLastRun(row?.value), settings }
}

// ── Планировщик: проверка порогов + автоочистка ──────────────────────────────

type CronTask = ReturnType<typeof cron.schedule>
const g = globalThis as unknown as { __cleanupCron?: CronTask; __cleanupStarted?: boolean }

/** Проверка диска по расписанию: уведомления о порогах + запуск автоочистки */
export async function cleanupTick(origin = 'cron'): Promise<{ ran: boolean; report?: CleanupReport; notified?: string }> {
  const cfg = await getCleanupSettings()
  const disk = await dataDisk()
  if (!disk) return { ran: false }

  // 1) порог триггера + автоочистка включена → запуск
  if (cfg.autoEnabled && disk.usedPct >= cfg.triggerPct) {
    const report = await runCleanup({ triggeredBy: 'auto' })
    const failures = report.actions.filter((a) => !a.ok)
    await notifyEvent('disk', failures.length ? 'error' : 'success',
      `Автоочистка выполнена: ${fmtMb(report.freedBytes)}`,
      `Диск ${report.diskAfter?.mount ?? '?'}: было ${report.diskBefore?.usedPct ?? '?'}%, стало ${report.diskAfter?.usedPct ?? '?'}%. ` +
      report.actions.map((a) => `${a.cleaner}: ${a.detail}`).join('\n'))
    return { ran: true, report, notified: failures.length ? 'errors' : 'ok' }
  }

  // 2) пороги предупреждения/критичности → уведомление (не чаще раза в 6 ч на уровень)
  const level = disk.usedPct >= cfg.diskCriticalPct ? 'critical' : disk.usedPct >= cfg.diskWarnPct ? 'warn' : null
  if (level) {
    const last = parseLastNotify(await readSetting(SETTING_LAST_NOTIFY))
    if (!last || last.level !== level || Date.now() - last.at > NOTIFY_THROTTLE_MS) {
      await writeSetting(SETTING_LAST_NOTIFY, JSON.stringify({ level, at: Date.now() }))
      const msg = level === 'critical'
        ? `Мало места на диске: ${disk.mount} занят ${disk.usedPct}% (свободно ${fmtMb(disk.freeMb * 1048576)}). Критический уровень — очистите диск или включите автоочистку (Настройки → Диск и очистка).`
        : `Мало места на диске: ${disk.mount} занят ${disk.usedPct}% (свободно ${fmtMb(disk.freeMb * 1048576)}). Предупреждение — при достижении ${cfg.triggerPct}% запустится автоочистка (сейчас ${cfg.autoEnabled ? 'включена' : 'ВЫКЛЮЧЕНА'}).`
      await notifyEvent('disk', level === 'critical' ? 'error' : 'warn', 'Занятость диска', msg)
      await log('warn', 'cleanup', `Диск ${disk.mount}: занято ${disk.usedPct}% (${level === 'critical' ? 'критично' : 'предупреждение'}) — уведомление отправлено (${origin})`)
      return { ran: false, notified: level }
    }
  }
  return { ran: false }
}

const readSetting = async (key: string): Promise<string | null> =>
  (await db.setting.findUnique({ where: { key } }).catch(() => null))?.value ?? null
const writeSetting = (key: string, value: string): Promise<unknown> =>
  db.setting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => undefined)

function parseLastNotify(json: string | null): { level: string; at: number } | null {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Пересоздать cron-задачу проверки диска (вызывается при сохранении настроек) */
export async function reinitCleanupScheduler(): Promise<void> {
  if (g.__cleanupCron) {
    g.__cleanupCron.stop()
    g.__cleanupCron = undefined
  }
  const cfg = await getCleanupSettings()
  if (cron.validate(cfg.schedule)) {
    g.__cleanupCron = cron.schedule(cfg.schedule, () => {
      void cleanupTick().catch((e) => log('error', 'cleanup', `Ошибка тика проверки диска: ${(e as Error).message}`))
    })
    await log('info', 'cleanup', `Проверка диска запланирована: «${cfg.schedule}» (автоочистка: ${cfg.autoEnabled ? `вкл, порог ${cfg.triggerPct}%` : 'выкл — только уведомления о порогах'})`)
  } else {
    await log('warn', 'cleanup', `Неверное выражение cron «${cfg.schedule}» — проверка диска не запланирована`)
  }
}

/** Однократный автозапуск на процесс (вызывается из ensureSeed/dashboard) */
export function maybeStartCleanupScheduler(): void {
  if (g.__cleanupStarted) return
  g.__cleanupStarted = true
  void reinitCleanupScheduler().catch(() => undefined)
}
