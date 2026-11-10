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
  esUrl?: string          // база, по которой OpenSearch доступен (учётные данные маскируются)
  esChannel?: string      // host:<base> | exec:<контейнер>
  dockerStatus?: string   // ok | no-cli | no-sock | denied
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

/**
 * Текст probe-скрипта (POSIX sh) — выполняется на хосте одной командой.
 * Канал OpenSearch определяется автоматически:
 *   1) URL из настройки osdEsUrl (если задан);
 *   2) https/http на 127.0.0.1:9200 (ssh-режим, --network host);
 *   3) https/http на 172.17.0.1:9200 (шлюз docker-моста — доступен из контейнера хаба);
 *   4) https/http на host.docker.internal:9200;
 *   5) docker exec в контейнер opensearch (если docker доступен).
 */
export function buildOsdProbeScript(cfg: UpdateSettings): string {
  const esUrl = (cfg.osdEsUrl || '').replace(/'/g, '')
  // p() печатает «KEY<TAB>VALUE»; root_cluster() достаёт cluster_name из тела /
  return [
    `p() { printf '%s\\t%s\\n' "$1" "$2"; }`,
    `root_cluster() { sed -n 's/.*"cluster_name"[: ]*"\\([^"]*\\)".*/\\1/p' | head -1; }`,
    // ── диагностика docker (объясняет, почему exec-канал может не работать) ──
    `dstat() {`,
    `  command -v docker >/dev/null 2>&1 || { echo no-cli; return; }`,
    `  if [ ! -S /var/run/docker.sock ] && [ -z "$DOCKER_HOST" ]; then echo no-sock; return; fi`,
    `  docker ps >/dev/null 2>&1 || { echo denied; return; }`,
    `  echo ok`,
    `}`,
    `DS="$(dstat)"; p docker_status "$DS"`,
    `ES_URL='${esUrl}'`,
    `ES_BASE=""; ES_CH=""; AUTH=""; OS_CT=""`,
    `es_try() { # $1=base → печатает cluster_name; 401/403 запоминает в AUTH`,
    `  local out code body`,
    `  out="$(curl -sk --noproxy '*' --max-time 4 -w '\\n%{http_code}' "$1/" 2>/dev/null)" || return 1`,
    `  code="$(printf '%s' "$out" | tail -1)"; body="$(printf '%s' "$out" | sed '$d')"`,
    `  case "$code" in`,
    `    200) printf '%s' "$body" | grep -q cluster_name || return 1`,
    `         printf '%s' "$body" | root_cluster; return 0 ;;`,
    `    401|403) AUTH="$code"; return 2 ;;`,
    `    *) return 1 ;;`,
    `  esac`,
    `}`,
    `for b in "$ES_URL" https://127.0.0.1:9200 http://127.0.0.1:9200 https://172.17.0.1:9200 http://172.17.0.1:9200 https://host.docker.internal:9200 http://host.docker.internal:9200; do`,
    `  [ -n "$b" ] || continue`,
    `  C="$(es_try "$b")" && { ES_BASE="$b"; ES_CH="host"; break; }`,
    `done`,
    `if [ -z "$ES_CH" ] && [ "$DS" = ok ]; then`,
    `  OS_CT="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- '-opensearch-[A-Za-z0-9_]+$' | head -1)"`,
    `  if [ -n "$OS_CT" ]; then`,
    `    for b in https://127.0.0.1:9200 http://127.0.0.1:9200; do`,
    `      out="$(docker exec "$OS_CT" curl -sk --noproxy '*' --max-time 6 -w '\\n%{http_code}' "$b/" 2>/dev/null)" || continue`,
    `      code="$(printf '%s' "$out" | tail -1)"; body="$(printf '%s' "$out" | sed '$d')"`,
    `      case "$code" in`,
    `        200) C="$(printf '%s' "$body" | root_cluster)"; [ -n "$C" ] && { ES_BASE="$b"; ES_CH="exec"; break; } ;;`,
    `        401|403) AUTH="$code" ;;`,
    `      esac`,
    `    done`,
    `  fi`,
    `fi`,
    `if [ -z "$ES_CH" ]; then`,
    `  H=""`,
    `  [ "$DS" = no-sock ] && H="; в контейнере нет /var/run/docker.sock — запустите хаб с -v /var/run/docker.sock:/var/run/docker.sock и -v /opt/ClearNDR:/opt/ClearNDR"`,
    `  [ "$DS" = denied ] && H="; docker есть, но нет прав на сокет (запустите контейнер от root или дайте доступ к /var/run/docker.sock)"`,
    `  [ "$DS" = no-cli ] && H="; в окружении нет docker CLI"`,
    `  [ -n "$AUTH" ] && H="$H; OpenSearch отвечает HTTP $AUTH — нужна авторизация, укажите URL вида https://user:pass@host:9200 в настройках раздела"`,
    `  p error "OpenSearch не найден (\${ES_URL:+заданный URL, }127.0.0.1:9200, 172.17.0.1:9200, host.docker.internal:9200 — https и http; docker: $DS)$H"`,
    `  exit 0`,
    `fi`,
    `p cluster "$C"`,
    `p es_url "$(printf '%s' "$ES_BASE" | sed -E 's#(://[^/@:]+):[^@]*@#\\1:***@#')"`,
    `if [ "$ES_CH" = exec ]; then p es_channel "exec:$OS_CT"; else p es_channel "host:$ES_BASE"; fi`,
    `esc() { # $1=path — GET по выбранному каналу`,
    `  if [ "$ES_CH" = exec ]; then docker exec "$OS_CT" curl -sk --noproxy '*' --max-time 15 "$ES_BASE$1" 2>/dev/null`,
    `  else curl -sk --noproxy '*' --max-time 15 "$ES_BASE$1" 2>/dev/null; fi`,
    `}`,
    `INFO="$(esc /)"`,
    `p es_version "$(printf '%s' "$INFO" | sed -n 's/.*"number"[: ]*"\\([^"]*\\)".*/\\1/p' | head -1)"`,
    `PLUG="$(esc '/_cat/plugins?h=component')"`,
    `p alerting "$(printf '%s' "$PLUG" | grep -q opensearch-alerting && echo 1 || echo 0)"`,
    `p anomaly "$(printf '%s' "$PLUG" | grep -q opensearch-anomaly-detection && echo 1 || echo 0)"`,
    `p security "$(printf '%s' "$PLUG" | grep -q opensearch-security-analytics && echo 1 || echo 0)"`,
    `IDX="$(esc '/_cat/indices/logstash-*?h=docs.count&bytes=mb')";`,
    `p indices "$(printf '%s\\n' "$IDX" | grep -c . || true)"`,
    `p docs "$(printf '%s\\n' "$IDX" | awk '{s+=$1} END{printf "%d", s+0}')";`,
    `p packs "$(esc '/.kibana/_search?q=_id:ndr-pack-*&size=0' | sed -n 's/.*"value":[0-9]*.*/&/p' | sed -n 's/.*"value":\\([0-9]*\\).*/\\1/p' | head -1)"`,
    `p monitors "$(esc '/_plugins/_alerting/monitors/_search?size=200' 2>/dev/null | grep -o '"name":"NDR' | wc -l | tr -d ' ')"`,
    `p adetectors "$(esc '/_plugins/_anomaly_detection/detectors/_search?size=200' 2>/dev/null | grep -o '"name":"NDR' | wc -l | tr -d ' ')"`,
    `p sdetectors "$(esc '/_plugins/_security_analytics/detectors/_search?size=200' 2>/dev/null | grep -o '"name":"NDR' | wc -l | tr -d ' ')"`,
    `if [ "$DS" = ok ]; then`,
    `  OSD_CT="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- '-opensearch-dashboards-[A-Za-z0-9_]+$' | head -1)"`,
    `  if [ -n "$OSD_CT" ]; then`,
    `    p osd_version "$(docker exec "$OSD_CT" curl -s --max-time 8 http://127.0.0.1:5601/api/stats 2>/dev/null | sed -n 's/.*"version":{[^}]*"number":"\\([^"]*\\)".*/\\1/p' | head -1)"`,
    `  fi`,
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
      case 'es_url': p.esUrl = val; break
      case 'es_channel': p.esChannel = val; break
      case 'docker_status': p.dockerStatus = val; break
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
  cancelled?: boolean   // остановлен пользователем (кнопка «Остановить»)
  args: string[]
  remoteDir?: string
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

function buildOsdArgs(kind: OsdRunOptions['kind'], script: 'analytics' | 'import', o: OsdRunOptions, esUrl: string): string[] {
  const args: string[] = ['--yes', '--no-color']
  if (o.dryRun) args.push('--dry-run')
  if (esUrl) args.push('--es-url', esUrl)
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

// ────────────────── зависшие/прерванные прогоны (реанимация) ──────────────────
// Раннер в local-режиме — detached-процесс; если контейнер хаба перезапускался,
// процесс погиб, не записав rc — и прогон навсегда оставался «выполняется»,
// блокируя новые запуски. Теперь статус-опрос проверяет живость процесса по pid
// и помечает такие прогоны остановленными (rc=143).

const STALE_RUN_MS = 3 * 60 * 1000 // нет pid-файла вообще → через 3 мин считаем прогон прерванным

async function osdPid(runId: string): Promise<number> {
  for (const f of ['pid.txt', 'pid']) {
    try {
      const pid = parseInt((await fs.readFile(path.join(OSD_RUNS_DIR, runId, f), 'utf8')).trim(), 10)
      if (Number.isFinite(pid) && pid > 0) return pid
    } catch { /* нет файла */ }
  }
  return 0
}

function pidAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = процесс есть, но чужой (другой пользователь) — считаем живым
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function osdRcExists(runId: string): Promise<boolean> {
  try { await fs.access(path.join(OSD_RUNS_DIR, runId, 'rc')); return true } catch { return false }
}

/** Пометить local-прогон прерванным: rc=143, строка в лог, финализация meta. */
async function finalizeInterruptedLocal(runId: string, reason: string, cancelled: boolean): Promise<void> {
  const dir = path.join(OSD_RUNS_DIR, runId)
  await fs.appendFile(path.join(dir, 'log.txt'), `\n[hub] ${reason}\n`).catch(() => undefined)
  await fs.writeFile(path.join(dir, 'rc'), '143').catch(() => undefined)
  const m = await readOsdMeta(runId)
  if (m && !m.finishedAt) {
    m.finishedAt = new Date().toISOString()
    m.exitCode = 143
    m.cancelled = cancelled || m.cancelled || false
    await writeOsdMeta(m)
    await logOsdEvent('error', `Прогон OSD (${runId}) прерван: ${reason}`)
  }
}

/** Запуск прогонов аналитики/импорта (detached-раннер как в clearndr-update) */
export async function startOsdRun(cfg: UpdateSettings, o: OsdRunOptions): Promise<{ ok: boolean; error?: string; runId?: string; args?: string[] }> {
  const runs = await listOsdRuns()
  const active = runs.find((r) => !r.finishedAt)
  if (active) {
    // readOsdRunStatus сам реанимирует зависший прогон (pid мёртв/файла нет) —
    // после этого запуск нового прогона снова разрешён
    const st = await readOsdRunStatus(cfg, active.runId)
    if (st.active) return { ok: false, error: `прогон ${active.runId} ещё выполняется — остановите его кнопкой «Остановить» и попробуйте снова` }
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
  const args = buildOsdArgs(o.kind, script, o, cfg.osdEsUrl || '')
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
    // cwd: каталог инстанса может быть не смонтирован в контейнер — не падаем
    let cwd = cfg.instanceDir
    try { await fs.access(cwd) } catch { cwd = DATA_DIR }
    const spawnOpts: SpawnOptions = { detached: true, stdio: ['ignore', out.fd, out.fd], cwd }
    const child = spawn('bash', [path.join(dir, 'runner.sh')], spawnOpts)
    await fs.writeFile(path.join(dir, 'pid.txt'), String(child.pid ?? '')).catch(() => undefined)
    child.on('exit', async (code) => {
      await out.close().catch(() => undefined)
      // маркер отмены (cancelOsdRun): остановленный прогон получает код 143
      let cancelledFlag = false
      try { await fs.access(path.join(dir, 'cancelled')); cancelledFlag = true } catch { /* нет маркера */ }
      let finalCode = code ?? 1
      if (cancelledFlag) finalCode = 143
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
        if (cancelledFlag) m.cancelled = true
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
    let active = rc === null
    // реанимация зависшего прогона: rc нет, но процесса уже нет
    if (active) {
      const pid = await osdPid(runId)
      const startedMs = Date.parse(meta.startedAt || '') || 0
      if (pid > 0 && !pidAliveLocal(pid)) {
        const reason = `процесс прогона не найден (pid ${pid} завершился без записи кода — контейнер хаба перезапускался?) — прогон помечен остановленным`
        await finalizeInterruptedLocal(runId, reason, !!meta.cancelled)
        rc = '143'
        active = false
        log += `\n[hub] ${reason}`
      } else if (pid === 0 && startedMs && Date.now() - startedMs > STALE_RUN_MS) {
        const reason = 'pid-файл не найден и прогон запущен более 3 минут назад — запуск не состоялся; прогон помечен остановленным'
        await finalizeInterruptedLocal(runId, reason, !!meta.cancelled)
        rc = '143'
        active = false
        log += `\n[hub] ${reason}`
      }
    }
    await closeOsdMetaIfNeeded(meta, active, rc)
    return { runId, active, exitCode: rc !== null ? parseInt(rc, 10) : undefined, cancelled: !!meta.cancelled, log, startedAt: meta.startedAt, finishedAt: meta.finishedAt }
  }
  const remoteDir = meta.remoteDir || `${remoteOsdRunRoot(cfg)}/${runId}`
  const r = await execOnHost(
    cfg,
    [
      `tail -c ${tailBytes} '${remoteDir}/log' 2>/dev/null || true`,
      `printf 'RC:' ; cat '${remoteDir}/rc' 2>/dev/null || echo RUNNING`,
      // жив ли процесс прогона (иначе rc мог не записаться — контейнер хаба/сессия ssh перезапускались)
      `if [ ! -s '${remoteDir}/rc' ]; then`,
      `  PID="$(cat '${remoteDir}/pid' 2>/dev/null || true)"`,
      `  if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then echo PIDDEAD`,
      `  elif [ -z "$PID" ]; then echo PIDNONE`,
      `  fi`,
      `fi`,
    ].join('\n'),
    25_000,
  )
  const out = r.stdout || ''
  const m = out.match(/RC:(\d+)\s*$/)
  let rc = m ? parseInt(m[1], 10) : null
  let log = out.replace(/RC:\d+\s*$/, '').replace(/RC:RUNNING\s*$/, '')
  if (!r.ok) {
    return {
      runId, active: true, exitCode: undefined,
      log: (log + (log ? '\n' : '') + `[hub] не удалось опросить хост: ${(r.stderr || '').trim().slice(0, 300)}`).trim(),
      startedAt: meta.startedAt, finishedAt: meta.finishedAt,
    }
  }
  // реанимация: rc нет, а процесса уже нет → пишем rc на хосте и финализируем
  if (rc === null) {
    const startedMs = Date.parse(meta.startedAt || '') || 0
    const dead = out.includes('PIDDEAD')
    const none = out.includes('PIDNONE')
    if (dead || (none && startedMs && Date.now() - startedMs > STALE_RUN_MS)) {
      const reason = dead
        ? `процесс прогона не найден (pid завершился без записи кода) — прогон помечен остановленным`
        : 'pid-файл не найден и прогон запущен более 3 минут назад — запуск не состоялся; прогон помечен остановленным'
      const w = await execOnHost(
        cfg,
        [
          `echo '[hub] ${reason}' >> '${remoteDir}/log' 2>/dev/null || true`,
          `echo 143 > '${remoteDir}/rc'`,
          `echo finalized`,
        ].join('\n'),
        15_000,
      )
      if (w.ok) {
        rc = 143
        log += `\n[hub] ${reason}`
      }
    }
  }
  const active = rc === null
  await closeOsdMetaIfNeeded(meta, active, rc === null ? null : String(rc))
  return { runId, active, exitCode: rc ?? undefined, cancelled: !!meta.cancelled, log, startedAt: meta.startedAt, finishedAt: meta.finishedAt }
}

/**
 * Остановка прогона: TERM группе процессов (при упорстве — KILL), затем запись
 * rc=143 и финализация meta. Раньше после отмены rc не записывался — прогон
 * оставался «выполняется» и продолжал блокировать новые запуски.
 */
export async function cancelOsdRun(cfg: UpdateSettings, runId: string): Promise<{ ok: boolean; error?: string }> {
  const meta = await readOsdMeta(runId)
  if (!meta) return { ok: false, error: 'прогон не найден' }
  if (meta.finishedAt) return { ok: false, error: 'прогон уже завершён' }
  if (meta.mode === 'local') {
    // маркер отмены: exit-обработчик запишет код 143 и флаг cancelled
    await fs.writeFile(path.join(OSD_RUNS_DIR, runId, 'cancelled'), '1').catch(() => undefined)
    const pid = await osdPid(runId)
    if (pid > 0) {
      try { process.kill(-pid, 'SIGTERM') } catch { /* группа уже не существует */ }
      try { process.kill(pid, 'SIGTERM') } catch { /* уже мёртв */ }
      for (let i = 0; i < 8; i++) {
        if (!pidAliveLocal(pid)) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (pidAliveLocal(pid)) {
        try { process.kill(-pid, 'SIGKILL') } catch { /* уже мёртв */ }
        try { process.kill(pid, 'SIGKILL') } catch { /* уже мёртв */ }
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    // если скрипт не успел записать rc — дописываем сами и финализируем
    if (!(await osdRcExists(runId))) {
      await fs.writeFile(path.join(OSD_RUNS_DIR, runId, 'rc'), '143').catch(() => undefined)
      await fs.appendFile(path.join(OSD_RUNS_DIR, runId, 'log.txt'), '\n[hub] Прогон остановлен пользователем.\n').catch(() => undefined)
    }
    const m = await readOsdMeta(runId)
    if (m && !m.finishedAt) {
      m.finishedAt = new Date().toISOString()
      m.exitCode = 143
      m.cancelled = true
      await writeOsdMeta(m)
      await logOsdEvent('error', `Прогон OSD (${runId}) остановлен пользователем`)
    }
    return { ok: true }
  }
  const remoteDir = meta.remoteDir || `${remoteOsdRunRoot(cfg)}/${runId}`
  const r = await execOnHost(
    cfg,
    [
      `PID="$(cat '${remoteDir}/pid' 2>/dev/null || true)"`,
      `if [ -n "$PID" ]; then kill -TERM -- -$PID 2>/dev/null; kill -TERM "$PID" 2>/dev/null; fi`,
      `sleep 2`,
      `if [ ! -s '${remoteDir}/rc' ]; then`,
      `  echo 143 > '${remoteDir}/rc'`,
      `  echo '[hub] Прогон остановлен пользователем.' >> '${remoteDir}/log' 2>/dev/null || true`,
      `fi`,
      `echo done`,
    ].join('\n'),
    20_000,
  )
  if (!r.ok) return { ok: false, error: (r.stderr || '').trim().slice(0, 300) || 'не удалось выполнить остановку на хосте' }
  const m = await readOsdMeta(runId)
  if (m && !m.finishedAt) {
    m.finishedAt = new Date().toISOString()
    m.exitCode = 143
    m.cancelled = true
    await writeOsdMeta(m)
    await logOsdEvent('error', `Прогон OSD (${runId}) остановлен пользователем`)
  }
  return { ok: true }
}

async function logOsdEvent(level: string, message: string): Promise<void> {
  try {
    const { log } = await import('./service')
    await log(level, 'osd', message)
  } catch { /* журнал не критичен */ }
}
