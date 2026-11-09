// ─────────────────────────────────────────────────────────────────────────────
// Раздел «Дашборды OpenSearch»: наполнение Alerting / Anomaly Detection /
// Security Analytics и каталог дополнительных дашбордов (packs) для clearNDR.
//
// Исполнительная часть — скрипты на хосте:
//   • scripts/clearndr-osd-analytics-setup.sh — мониторы/детекторы/SA;
//   • scripts/clearndr-osd-dashboard-import.sh — импорт pack-ов в .kibana;
//   • scripts/osd-packs/*.json — пакеты (генератор osd-pack-generator.py).
//
// Исполнение — по той же схеме, что и «Обновление Clear NDR»
// (см. clearndr-update.ts): ssh или local, detached-раннер, лог опрашивается
// поллингом. Настройки соединения (ssh/local, инстанс) — общие с разделом
// обновления, отдельная настройка не требуется.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, SpawnOptions } from 'child_process'
import path from 'path'
import { promises as fs } from 'fs'
import { DATA_DIR } from './fetcher'
import { execOnHost, sudoPrefix, type UpdateSettings } from './clearndr-update'

// ────────────────────────────── константы ───────────────────────────────────

/** Каталог локальных метаданных прогонов (в томе хаба /app/data) */
export const OSD_RUNS_DIR = path.join(DATA_DIR, 'clearndr-osd', 'runs')

/** Ключи пакетов дашбордов (файлы scripts/osd-packs/<key>.json) */
export const OSD_PACK_KEYS = ['traffic', 'http', 'dns', 'tls', 'alerts', 'files'] as const
export type OsdPackKey = (typeof OSD_PACK_KEYS)[number]

/** Виды действий аналитики */
export const OSD_APPLY_KINDS = ['alerting', 'anomaly', 'security', 'all'] as const
export type OsdApplyKind = (typeof OSD_APPLY_KINDS)[number]

export function localOsdAnalyticsPath(): string {
  return process.env.CLEARNDR_OSD_ANALYTICS_SCRIPT || path.join(process.cwd(), 'scripts', 'clearndr-osd-analytics-setup.sh')
}
export function localOsdImportPath(): string {
  return process.env.CLEARNDR_OSD_IMPORT_SCRIPT || path.join(process.cwd(), 'scripts', 'clearndr-osd-dashboard-import.sh')
}
export function localOsdPacksDir(): string {
  return process.env.CLEARNDR_OSD_PACKS_DIR || path.join(process.cwd(), 'scripts', 'osd-packs')
}

// ────────────────────────────── probe ────────────────────────────────────────

export interface OsdProbe {
  ok: boolean
  mode: 'ssh' | 'local'
  error?: string
  cluster?: string        // имя кластера OpenSearch
  esVersion?: string      // версия OpenSearch
  osdVersion?: string     // версия OpenSearch Dashboards
  alerting?: boolean      // плагин opensearch-alerting
  anomaly?: boolean       // плагин opensearch-anomaly-detection
  security?: boolean      // плагин opensearch-security-analytics
  indices?: number        // число индексов logstash-*
  docs?: number           // суммарно документов
  packs?: number          // объектов ndr-pack-* в .kibana
  monitors?: number       // мониторов «NDR ·»
  adetectors?: number     // AD-детекторов «NDR ·»
  sdetectors?: number     // SA-детекторов «NDR ·»
  ranAt: string
}

/** Текст probe-скрипта (POSIX sh) — выполняется на хосте одной командой */
export function buildOsdProbeScript(cfg: UpdateSettings): string {
  // p() печатает «KEY<TAB>VALUE»; esget() выбирает канал доступа к OpenSearch.
  return [
    `p() { printf '%s\\t%s\\n' "$1" "$2"; }`,
    `ES_MODE=""; OS_CT=""; OSD_CT=""`,
    `if curl -s --max-time 5 http://127.0.0.1:9200 2>/dev/null | grep -q cluster_name; then`,
    `  ES_MODE=host`,
    `else`,
    `  OS_CT="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- '-opensearch-[A-Za-z0-9_]+$' | head -1)"`,
    `  [ -n "$OS_CT" ] && ES_MODE=exec`,
    `fi`,
    `esget() {`,
    `  if [ "$ES_MODE" = host ]; then curl -s --max-time 15 "$1" 2>/dev/null`,
    `  elif [ "$ES_MODE" = exec ]; then docker exec "$OS_CT" curl -s --max-time 15 "http://127.0.0.1:9200$1" 2>/dev/null`,
    `  fi`,
    `}`,
    `INFO="$(esget /)"`,
    `printf '%s' "$INFO" | grep -q cluster_name || { p error "OpenSearch недоступен (127.0.0.1:9200 и docker)"; exit 0; }`,
    `p cluster "$(printf '%s' "$INFO" | sed -n 's/.*"cluster_name"[: ]*"\\([^"]*\\)".*/\\1/p' | head -1)"`,
    `p es_version "$(printf '%s' "$INFO" | sed -n 's/.*"number"[: ]*"\\([^"]*\\)".*/\\1/p' | head -1)"`,
    `PLUG="$(esget '/_cat/plugins?h=component')"`,
    `p alerting "$(printf '%s' "$PLUG" | grep -q opensearch-alerting && echo 1 || echo 0)"`,
    `p anomaly "$(printf '%s' "$PLUG" | grep -q opensearch-anomaly-detection && echo 1 || echo 0)"`,
    `p security "$(printf '%s' "$PLUG" | grep -q opensearch-security-analytics && echo 1 || echo 0)"`,
    `IDX="$(esget '/_cat/indices/logstash-*?h=docs.count&bytes=mb')";`,
    `p indices "$(printf '%s\\n' "$IDX" | grep -c . || true)"`,
    `p docs "$(printf '%s\\n' "$IDX" | awk '{s+=$1} END{printf "%d", s+0}')";`,
    `p packs "$(esget '/.kibana/_search?q=_id:ndr-pack-*&size=0' | sed -n 's/.*"value":[0-9]*.*/&/p' | sed -n 's/.*"value":\\([0-9]*\\).*/\\1/p' | head -1)"`,
    `p monitors "$(esget '/_plugins/_alerting/monitors/_search?size=200' 2>/dev/null | grep -o '"name":"NDR' | wc -l | tr -d ' ')"`,
    `p adetectors "$(esget '/_plugins/_anomaly_detection/detectors/_search?size=200' 2>/dev/null | grep -o '"name":"NDR' | wc -l | tr -d ' ')"`,
    `p sdetectors "$(esget '/_plugins/_security_analytics/detectors/_search?size=200' 2>/dev/null | grep -o '"name":"NDR' | wc -l | tr -d ' ')"`,
    `OSD_CT="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- '-opensearch-dashboards-[A-Za-z0-9_]+$' | head -1)"`,
    `if [ -n "$OSD_CT" ]; then`,
    `  p osd_version "$(docker exec "$OSD_CT" curl -s --max-time 8 http://127.0.0.1:5601/api/stats 2>/dev/null | sed -n 's/.*"version":{[^}]*"number":"\\([^"]*\\)".*/\\1/p' | head -1)"`,
    `fi`,
    '',
  ].join('\n')
}

/** Разбор вывода probe-скрипта: строки «KEY<TAB>VALUE» */
export function parseOsdProbe(raw: string): Partial<OsdProbe> {
  const p: Partial<OsdProbe> = {}
  for (const line of (raw || '').split('\n')) {
    const i = line.indexOf('\t')
    if (i <= 0) continue
    const key = line.slice(0, i)
    const val = line.slice(i + 1).trim()
    if (!val && key !== 'docs') continue
    switch (key) {
      case 'error': p.error = val; break
      case 'cluster': p.cluster = val; break
      case 'es_version': p.esVersion = val; break
      case 'osd_version': p.osdVersion = val; break
      case 'alerting': p.alerting = val === '1'; break
      case 'anomaly': p.anomaly = val === '1'; break
      case 'security': p.security = val === '1'; break
      case 'indices': p.indices = parseInt(val, 10) || 0; break
      case 'docs': p.docs = parseInt(val, 10) || 0; break
      case 'packs': p.packs = parseInt(val, 10) || 0; break
      case 'monitors': p.monitors = parseInt(val, 10) || 0; break
      case 'adetectors': p.adetectors = parseInt(val, 10) || 0; break
      case 'sdetectors': p.sdetectors = parseInt(val, 10) || 0; break
      default: break
    }
  }
  return p
}

let osdProbeCache: { at: number; key: string; value: OsdProbe } | null = null

export async function probeOsd(cfg: UpdateSettings, force = false): Promise<OsdProbe> {
  const key = JSON.stringify([cfg.updateMode, cfg.sshHost, cfg.sshPort, cfg.sshUser, cfg.instanceDir])
  if (!force && osdProbeCache && osdProbeCache.key === key && Date.now() - osdProbeCache.at < 20_000) {
    return osdProbeCache.value
  }
  const script = buildOsdProbeScript(cfg)
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  const r = await execOnHost(cfg, `echo ${b64} | base64 -d | bash`, 45_000)
  const probe: OsdProbe = {
    ok: r.ok && !!parseOsdProbe(r.stdout).cluster,
    mode: cfg.updateMode,
    ranAt: new Date().toISOString(),
    ...(r.ok ? parseOsdProbe(r.stdout) : {}),
  }
  if (!r.ok) probe.error = (r.stderr || '').trim().slice(0, 400) || 'не удалось выполнить проверку'
  else if (!probe.cluster) probe.error = probe.error || 'OpenSearch недоступен'
  osdProbeCache = { at: Date.now(), key, value: probe }
  return probe
}

// ────────────────────────────── синхронизация ───────────────────────────────

function scriptDirOnHost(cfg: UpdateSettings): string {
  // скрипты и пакеты кладём рядом с clearndr-update.sh (scriptPath)
  const p = cfg.scriptPath || '/opt/ClearNDR/clearndr-update.sh'
  return p.replace(/\/[^/]*$/, '')
}

async function writeFileOnHost(cfg: UpdateSettings, remotePath: string, content: string, mode = '755'): Promise<{ ok: boolean; error?: string }> {
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  const cmd = [
    `mkdir -p "$(dirname '${remotePath}')"`,
    `echo ${b64} | base64 -d > '${remotePath}'`,
    `chmod ${mode} '${remotePath}'`,
    `echo synced`,
  ].join('\n')
  const r = await execOnHost(cfg, cmd, 120_000)
  if (!r.ok || !r.stdout.includes('synced')) {
    return { ok: false, error: `${remotePath}: ${(r.stderr || r.stdout || '').trim().slice(0, 300) || 'ошибка записи'}` }
  }
  return { ok: true }
}

/** Синхронизация скриптов и пакетов дашбордов на хост (в local-режиме файлы уже в образе) */
export async function syncOsdScripts(cfg: UpdateSettings): Promise<{ ok: boolean; error?: string }> {
  if (cfg.updateMode === 'local') {
    for (const f of [localOsdAnalyticsPath(), localOsdImportPath()]) {
      try { await fs.access(f) } catch { return { ok: false, error: `файл не найден: ${f}` } }
    }
    return { ok: true }
  }
  const dir = scriptDirOnHost(cfg)
  for (const [src, name] of [
    [localOsdAnalyticsPath(), 'clearndr-osd-analytics-setup.sh'],
    [localOsdImportPath(), 'clearndr-osd-dashboard-import.sh'],
  ] as const) {
    let content: string
    try { content = await fs.readFile(src, 'utf8') } catch { return { ok: false, error: `скрипт не найден в хабе: ${src}` } }
    const r = await writeFileOnHost(cfg, `${dir}/${name}`, content)
    if (!r.ok) return r
  }
  const packsDir = localOsdPacksDir()
  let names: string[]
  try { names = (await fs.readdir(packsDir)).filter((n) => n.endsWith('.json')) } catch { names = [] }
  if (names.length === 0) return { ok: false, error: `пакеты не найдены: ${packsDir}` }
  for (const n of names) {
    const content = await fs.readFile(path.join(packsDir, n), 'utf8')
    const r = await writeFileOnHost(cfg, `${dir}/osd-packs/${n}`, content, '644')
    if (!r.ok) return r
  }
  return { ok: true }
}

// ────────────────────────────── прогоны ──────────────────────────────────────

export interface OsdRunOptions {
  kind: 'apply' | 'import' | 'remove'
  what?: OsdApplyKind      // для kind=apply
  packs?: OsdPackKey[]     // для kind=import/remove
  dryRun?: boolean
}

export interface OsdRunMeta {
  runId: string
  mode: 'ssh' | 'local'
  kind: OsdRunOptions['kind']
  startedAt: string
  finishedAt?: string
  exitCode?: number
  args: string[]
  remoteDir?: string
}

export interface OsdRunStatus {
  runId: string
  active: boolean
  exitCode?: number
  log: string
  startedAt?: string
  finishedAt?: string
}

function buildOsdArgs(kind: OsdRunOptions['kind'], script: 'analytics' | 'import', o: OsdRunOptions): string[] {
  const args: string[] = ['--yes', '--no-color']
  if (o.dryRun) args.push('--dry-run')
  if (script === 'analytics') {
    args.push(`--apply-${o.what || 'all'}`)
  } else {
    if (kind === 'import') {
      const packs = (o.packs && o.packs.length ? o.packs : [...OSD_PACK_KEYS]) as string[]
      for (const p of packs) args.push('--pack', p)
    } else {
      args.push(`--remove`, o.packs && o.packs.length ? o.packs.join('|') : 'all')
    }
  }
  return args
}

function remoteOsdRunRoot(cfg: UpdateSettings): string {
  return `${cfg.instanceDir.replace(/\/+$/, '')}/.hub-osd-runs`
}

async function osdMetaPath(runId: string): Promise<string> {
  const dir = path.join(OSD_RUNS_DIR, runId)
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, 'meta.json')
}

async function writeOsdMeta(meta: OsdRunMeta): Promise<void> {
  await fs.writeFile(await osdMetaPath(meta.runId), JSON.stringify(meta, null, 2), { mode: 0o600 })
}

async function readOsdMeta(runId: string): Promise<OsdRunMeta | null> {
  try { return JSON.parse(await fs.readFile(await osdMetaPath(runId), 'utf8')) as OsdRunMeta } catch { return null }
}

export async function listOsdRuns(): Promise<OsdRunMeta[]> {
  try {
    const dirs = await fs.readdir(OSD_RUNS_DIR)
    const metas: OsdRunMeta[] = []
    for (const d of dirs) {
      const m = await readOsdMeta(d)
      if (m) metas.push(m)
    }
    return metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  } catch {
    return []
  }
}

/** Запуск прогонов аналитики/импорта (detached-раннер как в clearndr-update) */
export async function startOsdRun(cfg: UpdateSettings, o: OsdRunOptions): Promise<{ ok: boolean; error?: string; runId?: string; args?: string[] }> {
  const runs = await listOsdRuns()
  const active = runs.find((r) => !r.finishedAt)
  if (active) {
    const st = await readOsdRunStatus(cfg, active.runId)
    if (st.active) return { ok: false, error: `прогон ${active.runId} ещё выполняется` }
  }
  const script = o.kind === 'apply' ? 'analytics' : 'import'
  const scriptLocal = script === 'analytics' ? localOsdAnalyticsPath() : localOsdImportPath()
  let scriptOnHost: string
  if (cfg.updateMode === 'local') {
    try { await fs.access(scriptLocal) } catch { return { ok: false, error: `файл не найден: ${scriptLocal}` } }
    scriptOnHost = scriptLocal
  } else {
    scriptOnHost = `${scriptDirOnHost(cfg)}/${path.basename(scriptLocal)}`
  }
  const args = buildOsdArgs(o.kind, script, o)
  const runId = `osd-${o.kind}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  const remoteDir = cfg.updateMode === 'local' ? path.join(OSD_RUNS_DIR, runId) : `${remoteOsdRunRoot(cfg)}/${runId}`
  const meta: OsdRunMeta = { runId, mode: cfg.updateMode, kind: o.kind, startedAt: new Date().toISOString(), args, remoteDir }
  await writeOsdMeta(meta)

  const sync = await syncOsdScripts(cfg)
  if (!sync.ok) {
    meta.finishedAt = new Date().toISOString()
    await writeOsdMeta(meta)
    return { ok: false, error: `скрипты не синхронизированы: ${sync.error}` }
  }

  const sudo = cfg.updateMode === 'local' ? '' : sudoPrefix(cfg.sudoMode, cfg.sshUser)
  const runner = [
    '#!/bin/sh',
    `# Раннер OSD-аналитики NDR Rules Hub (${new Date().toISOString()})`,
    `echo $$ > '${remoteDir}/pid'`,
    `cd '${cfg.instanceDir}' 2>/dev/null || true`,
    `${sudo}bash '${scriptOnHost}' ${args.map((a) => `'${a}'`).join(' ')}`,
    `RC=$?`,
    `echo $RC > '${remoteDir}/rc'`,
    `exit $RC`,
    '',
  ].join('\n')
  const rb64 = Buffer.from(runner, 'utf8').toString('base64')

  if (cfg.updateMode === 'local') {
    const dir = remoteDir
    const logPath = path.join(dir, 'log.txt')
    const rcPath = path.join(dir, 'rc')
    await fs.writeFile(path.join(dir, 'runner.sh'), runner, { mode: 0o755 })
    const out = await fs.open(logPath, 'a')
    const spawnOpts: SpawnOptions = { detached: true, stdio: ['ignore', out.fd, out.fd], cwd: cfg.instanceDir }
    const child = spawn('bash', [path.join(dir, 'runner.sh')], spawnOpts)
    await fs.writeFile(path.join(dir, 'pid.txt'), String(child.pid ?? '')).catch(() => undefined)
    child.on('exit', async (code) => {
      await out.close().catch(() => undefined)
      let finalCode = code ?? 1
      try {
        const rcRaw = parseInt((await fs.readFile(rcPath, 'utf8')).trim(), 10)
        if (Number.isFinite(rcRaw)) finalCode = rcRaw
      } catch {
        await fs.writeFile(rcPath, String(finalCode)).catch(() => undefined)
      }
      const m = await readOsdMeta(runId)
      if (m && !m.finishedAt) {
        m.finishedAt = new Date().toISOString()
        m.exitCode = finalCode
        await writeOsdMeta(m)
      }
    })
    child.unref()
    return { ok: true, runId, args }
  }

  const r = await execOnHost(
    cfg,
    [
      `mkdir -p '${remoteDir}'`,
      `echo ${rb64} | base64 -d > '${remoteDir}/runner.sh'`,
      `chmod 700 '${remoteDir}/runner.sh'`,
      `cd '${cfg.instanceDir}' && nohup setsid sh '${remoteDir}/runner.sh' >> '${remoteDir}/log' 2>&1 &`,
      `echo started`,
    ].join('\n'),
    30_000,
  )
  if (!r.ok || !r.stdout.includes('started')) {
    meta.finishedAt = new Date().toISOString()
    await writeOsdMeta(meta)
    return { ok: false, error: `не удалось запустить прогон на хосте: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}` }
  }
  await logOsdEvent('info', `Запущен прогон OSD (${runId}): ${args.join(' ')}`)
  return { ok: true, runId, args }
}

async function readTailFile(p: string, bytes: number): Promise<string> {
  const fh = await fs.open(p, 'r')
  try {
    const size = (await fh.stat()).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

async function closeOsdMetaIfNeeded(meta: OsdRunMeta, active: boolean, rc: string | null): Promise<void> {
  if (active || rc === null || meta.finishedAt) return
  meta.finishedAt = new Date().toISOString()
  meta.exitCode = parseInt(rc, 10)
  await writeOsdMeta(meta)
  await logOsdEvent(meta.exitCode === 0 ? 'success' : 'error', `Прогон OSD (${meta.runId}) завершён с кодом ${meta.exitCode}`)
}

export async function readOsdRunStatus(cfg: UpdateSettings, runId: string, tailBytes = 24_000): Promise<OsdRunStatus> {
  const meta = await readOsdMeta(runId)
  if (!meta) return { runId, active: false, log: 'прогон не найден' }
  if (cfg.updateMode === 'local') {
    let rc: string | null = null
    try { rc = (await fs.readFile(path.join(OSD_RUNS_DIR, runId, 'rc'), 'utf8')).trim() } catch { /* работает */ }
    let log = ''
    try { log = await readTailFile(path.join(OSD_RUNS_DIR, runId, 'log.txt'), tailBytes) } catch { /* нет лога */ }
    const active = rc === null
    await closeOsdMetaIfNeeded(meta, active, rc)
    return { runId, active, exitCode: rc !== null ? parseInt(rc, 10) : undefined, log, startedAt: meta.startedAt, finishedAt: meta.finishedAt }
  }
  const remoteDir = meta.remoteDir || `${remoteOsdRunRoot(cfg)}/${runId}`
  const r = await execOnHost(
    cfg,
    [
      `tail -c ${tailBytes} '${remoteDir}/log' 2>/dev/null || true`,
      `printf 'RC:' ; cat '${remoteDir}/rc' 2>/dev/null || echo RUNNING`,
    ].join('\n'),
    25_000,
  )
  const out = r.stdout || ''
  const m = out.match(/RC:(\d+)\s*$/)
  const rc = m ? parseInt(m[1], 10) : null
  const log = out.replace(/RC:\d+\s*$/, '').replace(/RC:RUNNING\s*$/, '')
  if (!r.ok) {
    return {
      runId, active: true, exitCode: undefined,
      log: (log + (log ? '\n' : '') + `[hub] не удалось опросить хост: ${(r.stderr || '').trim().slice(0, 300)}`).trim(),
      startedAt: meta.startedAt, finishedAt: meta.finishedAt,
    }
  }
  const active = rc === null
  await closeOsdMetaIfNeeded(meta, active, rc === null ? null : String(rc))
  return { runId, active, exitCode: rc ?? undefined, log, startedAt: meta.startedAt, finishedAt: meta.finishedAt }
}

export async function cancelOsdRun(cfg: UpdateSettings, runId: string): Promise<{ ok: boolean; error?: string }> {
  const meta = await readOsdMeta(runId)
  if (!meta) return { ok: false, error: 'прогон не найден' }
  if (meta.mode === 'local') {
    try {
      let pid = parseInt(await fs.readFile(path.join(OSD_RUNS_DIR, runId, 'pid.txt'), 'utf8').catch(() => ''), 10)
      if (!Number.isFinite(pid) || !(pid > 0)) {
        pid = parseInt(await fs.readFile(path.join(OSD_RUNS_DIR, runId, 'pid'), 'utf8').catch(() => ''), 10)
      }
      if (!Number.isFinite(pid) || !(pid > 0)) throw new Error('pid не найден')
      process.kill(-pid, 'SIGTERM')
      return { ok: true }
    } catch {
      return { ok: false, error: 'процесс не найден (возможно, уже завершён)' }
    }
  }
  const remoteDir = meta.remoteDir || `${remoteOsdRunRoot(cfg)}/${runId}`
  const r = await execOnHost(cfg, `kill -TERM -- -"$(cat '${remoteDir}/pid' 2>/dev/null)" 2>/dev/null; echo done`, 20_000)
  return r.ok ? { ok: true } : { ok: false, error: (r.stderr || '').trim().slice(0, 300) }
}

async function logOsdEvent(level: string, message: string): Promise<void> {
  try {
    const { log } = await import('./service')
    await log(level, 'osd', message)
  } catch { /* журнал не критичен */ }
}
