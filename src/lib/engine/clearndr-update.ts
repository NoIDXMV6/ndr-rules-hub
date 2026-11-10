// ─────────────────────────────────────────────────────────────────────────────
// Обновление Clear NDR из web-интерфейса NDR Rules Hub.
//
// Оркестрация разработанного скрипта scripts/clearndr-update.sh (см.
// docs/clearndr-update.md): определить текущую версию стека, найти последний
// релиз шаблона stamusctl-templates, запустить обновление с выбранными в UI
// опциями и проверить результат (контейнеры, web UI, REST API).
//
// Хаб работает в контейнере, а стек Clear NDR — на хосте под управлением
// stamusctl. Скрипт обязан выполняться на хосте, поэтому поддерживаются два
// режима исполнения:
//   • ssh   (основной) — хаб подключается к хосту по SSH и запускает скрипт
//     там же, где раньше его запускали вручную (sudo/ключ настраиваются в UI);
//   • local — скрипт запускается напрямую из хаба (если контейнер хаба
//     запущен с доступом к docker и каталогу инстанса, либо хаб установлен
//     на самом хосте Clear NDR).
// Долгий процесс не держит HTTP-запрос: раннер запускается detached
// (ssh: nohup setsid + файл rc; local: spawn detached), прогресс читается
// поллингом лога.
// ─────────────────────────────────────────────────────────────────────────────
import { execFile, spawn, SpawnOptions } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { promises as fs, readFileSync } from 'fs'
import { DATA_DIR } from './fetcher'
import { getSettings } from './service'

const execFileP = promisify(execFile)

// ────────────────────────────── константы ───────────────────────────────────

/** Каталог локальных метаданных прогонов обновления (в томе хаба /app/data) */
export const UPDATE_RUNS_DIR = path.join(DATA_DIR, 'clearndr-update', 'runs')

/** Путь до скрипта внутри образа/репозитория — источник для синхронизации на хост */
export function localScriptPath(): string {
  return process.env.CLEARNDR_UPDATE_SCRIPT || path.join(process.cwd(), 'scripts', 'clearndr-update.sh')
}

/** Критичные сервисы стека (как в скрипте: STACK_SERVICES) */
export const STACK_SERVICES = ['scirius', 'db', 'suricata', 'nginx', 'opensearch'] as const

/** Репозиторий шаблонов Clear NDR — источник «последнего релиза» */
const TEMPLATES_API = 'https://api.github.com/repos/StamusNetworks/stamusctl-templates/releases/latest'

/** Ключи настроек раздела обновления (таблица Setting, k-v) */
export const UPDATE_SETTING_KEYS = [
  'updateMode',       // ssh | local
  'sshHost', 'sshPort', 'sshUser', 'sshKey',
  'sudoMode',         // auto | sudo | plain
  'instanceDir',      // /opt/ClearNDR
  'scriptPath',       // /opt/ClearNDR/clearndr-update.sh
  'healthUrl',        // https://localhost/
  'apiToken',
  'osdEsUrl',         // OpenSearch URL для раздела «Дашборды OpenSearch» (пусто = авто)
] as const

export interface UpdateSettings {
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
}

export const UPDATE_SETTINGS_DEFAULTS: UpdateSettings = {
  updateMode: 'ssh',
  sshHost: '',
  sshPort: '22',
  sshUser: 'root',
  sshKey: '',
  sudoMode: 'auto',
  instanceDir: '/opt/ClearNDR',
  scriptPath: '/opt/ClearNDR/clearndr-update.sh',
  healthUrl: 'https://localhost/',
  apiToken: '',
  osdEsUrl: '',
}

// ────────────────────────────── типы результатов ────────────────────────────

export interface StackContainer {
  name: string
  status: string
  up: boolean
  service?: string
}

/** Результат проникновения на хост: версии, предпроверки, состояние стека */
export interface HostProbe {
  ok: boolean
  mode: 'ssh' | 'local'
  error?: string
  stamusctl?: string          // «stamusctl version 1.2.3 …»
  stackVersion?: string       // версия шаблона из `stamusctl config version`
  osTag?: string              // opensearchproject/opensearch:2.5.0
  pgTag?: string              // postgres:16
  suricataInterfaces?: string
  mikrocata?: boolean
  composeOk?: boolean         // проект инстанса проходит «docker compose config»
  composeErr?: string         // причина, если конфигурация повреждена (или проверка недоступна)
  maxMapCount?: number
  memAvailMb?: number
  dockerRoot?: string
  diskFreeMb?: number
  webHttp?: string            // код ответа web UI (200/302/000…)
  apiHttp?: string            // код REST API (если задан токен)
  apiSources?: string         // количество источников правил (ответ REST)
  apiBase?: string            // база, по которой REST ответил 200 (healthUrl или шлюз)
  containers: StackContainer[]
  ranAt: string
}

export interface LatestRelease {
  tag: string
  name?: string
  publishedAt?: string
  url?: string
}

export interface RunMeta {
  runId: string
  mode: 'ssh' | 'local'
  startedAt: string
  finishedAt?: string
  exitCode?: number
  cancelled?: boolean   // остановлен пользователем
  options: UpdateOptions
  args: string[]
  logPath?: string   // путь к логу (local) — для истории
  remoteDir?: string // каталог прогона на хосте (ssh)
}

export interface RunStatus {
  runId: string
  active: boolean
  exitCode?: number
  cancelled?: boolean
  log: string
  startedAt?: string
  finishedAt?: string
}

export interface UpdateOptions {
  version: string            // '' => latest
  opensearchData: 'keep' | 'wipe'
  pgStrategy: 'restore'
  updateCli: boolean
  skipDbDump: boolean
  skipVolume: boolean
  fullConfig: boolean
  skipMikrocataCheck: boolean
  healthTimeout: number      // сек, ожидание health-check после запуска стека
}

export const UPDATE_OPTIONS_DEFAULTS: UpdateOptions = {
  version: '',
  opensearchData: 'keep',
  pgStrategy: 'restore',
  updateCli: false,
  skipDbDump: false,
  skipVolume: false,
  fullConfig: false,
  skipMikrocataCheck: false,
  healthTimeout: 600,
}

// ────────────────────────────── чистые функции ──────────────────────────────
// (экспортированы для unit-тестов; никакой работы с процессами)

/** «v1.2.3» → [1,2,3]; нечисловые хвосты (rc, beta) учитываются как младшие */
export function parseVersion(v: string): number[] {
  const s = (v || '').trim().replace(/^v/i, '')
  const parts = s.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : NaN))
  const nums: number[] = []
  for (const p of parts) {
    if (Number.isFinite(p)) nums.push(p)
    else break
  }
  while (nums.length < 3) nums.push(0)
  return nums
}

/** Сравнение версий: 1 — a новее, -1 — b новее, 0 — равны */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** Версия доступна, если latest строго новее установленной (неизвестные → null) */
export function updateAvailable(installed?: string, latest?: string): boolean | null {
  if (!installed || !latest) return null
  if (installed === 'latest') return null
  if (/неизвестна|unknown/i.test(installed)) return null
  return compareVersions(latest, installed) > 0
}

/** Допустимые символы версии: защита от инъекций в аргументы командной строки */
export function safeVersionTag(v: string): string {
  const s = (v || '').trim()
  if (s === '' || s === 'latest') return s
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) {
    throw new Error(`недопустимая версия: «${s}» (разрешены буквы, цифры, точка, дефис, подчёркивание)`)
  }
  return s
}

/** Префикт повышения прав на хосте */
export function sudoPrefix(mode: UpdateSettings['sudoMode'], sshUser: string): string {
  if (mode === 'sudo') return 'sudo -n '
  if (mode === 'plain') return ''
  // auto: root работает напрямую, остальным нужен NOPASSWD sudo
  return sshUser.trim() === 'root' ? '' : 'sudo -n '
}

/** Аргументы clearndr-update.sh из опций UI (неинтерактивный режим) */
export function buildUpdateArgs(opts: UpdateOptions): string[] {
  const args: string[] = ['--yes', '--no-color']
  const ver = safeVersionTag(opts.version)
  if (ver && ver !== 'latest') args.push('--version', ver)
  args.push('--opensearch-data', opts.opensearchData === 'wipe' ? 'wipe' : 'keep')
  args.push('--pg-strategy', 'restore')
  if (opts.updateCli) args.push('--update-cli')
  if (opts.skipDbDump) args.push('--skip-db-dump')
  if (opts.skipVolume) args.push('--skip-volume')
  if (opts.fullConfig) args.push('--full-config')
  if (opts.skipMikrocataCheck) args.push('--skip-mikrocata-check')
  const ht = Math.min(3600, Math.max(60, Math.floor(opts.healthTimeout || 600)))
  args.push('--health-timeout', String(ht))
  return args
}

/** Сформировать текст раннера (запускается на хосте в фоне) */
export function buildRunnerScript(cfg: {
  instanceDir: string
  scriptPath: string
  args: string[]
  sudo: string
  runDir: string
}): string {
  const lines = [
    '#!/bin/sh',
    `# Раннер обновления Clear NDR, сгенерирован NDR Rules Hub (${new Date().toISOString()})`,
    // свой PGID: при setsid $$ = лидер группы процессов — по нему выполняется отмена
    `echo $$ > '${cfg.runDir}/pid'`,
    `cd '${cfg.instanceDir}' || exit 90`,
    `${cfg.sudo}bash '${cfg.scriptPath}' ${cfg.args.map((a) => `'${a}'`).join(' ')}`,
    `RC=$?`,
    `echo $RC > '${cfg.runDir}/rc'`,
    // код раннера = код скрипта (иначе внешний «exit» перезапишет rc нулём)
    `exit $RC`,
    '',
  ]
  return lines.join('\n')
}

/** Разбор вывода probe-скрипта: строки «KEY<TAB>VALUE» (+ контейнеры CT\tname\tstatus) */
export function parseProbeOutput(raw: string): Partial<HostProbe> {
  const p: Partial<HostProbe> = { containers: [] }
  for (const line of (raw || '').split('\n')) {
    const i = line.indexOf('\t')
    if (i <= 0) continue
    const key = line.slice(0, i)
    const val = line.slice(i + 1).trim()
    if (!val) continue
    switch (key) {
      case 'stamusctl': p.stamusctl = val; break
      case 'stack_version': p.stackVersion = val; break
      case 'os_tag': p.osTag = val; break
      case 'pg_tag': p.pgTag = val; break
      case 'suricata_interfaces': p.suricataInterfaces = val; break
      case 'mikrocata': p.mikrocata = val === '1'; break
      case 'compose_ok': p.composeOk = val === '1'; break
      case 'compose_err': p.composeErr = val; break
      case 'max_map_count': p.maxMapCount = parseInt(val, 10) || 0; break
      case 'mem_avail_mb': p.memAvailMb = parseInt(val, 10) || 0; break
      case 'docker_root': p.dockerRoot = val; break
      case 'disk_free_mb': p.diskFreeMb = parseInt(val, 10) || 0; break
      case 'web_http': p.webHttp = val; break
      case 'api_http': p.apiHttp = val; break
      case 'api_sources': p.apiSources = val; break
      case 'api_base': p.apiBase = val; break
      case 'CT': {
        // CT\t<name>\t<status…>
        const parts = val.split('\t')
        const name = parts[0] ?? ''
        const status = parts.slice(1).join(' ')
        p.containers!.push({
          name,
          status,
          up: /^Up\b/.test(status),
          service: (name.match(/-(scirius|db|suricata|nginx|opensearch|fluentd|osd|evebox|arkime|rabbitmq|celery|cron|scout)-[A-Za-z0-9_]+$/) || [])[1],
        })
        break
      }
      default: break
    }
  }
  return p
}

/** Текст probe-скрипта (POSIX sh) — выполняется на хосте одной командой */
export function buildProbeScript(cfg: { instanceDir: string; healthUrl: string; apiToken: string }): string {
  // p() печатает «KEY<TAB>VALUE»; всё терпимо к отсутствию инструментов.
  return [
    `INSTANCE='${cfg.instanceDir}'`,
    `HEALTH='${cfg.healthUrl.replace(/'/g, '')}'`,
    `TOKEN='${(cfg.apiToken || '').replace(/'/g, '')}'`,
    `p() { printf '%s\\t%s\\n' "$1" "$2"; }`,
    // версия стека: stamusctl config version из каталога инстанса
    `if command -v stamusctl >/dev/null 2>&1; then`,
    `  p stamusctl "$(stamusctl version 2>/dev/null | head -1)"`,
    `  ( cd "$INSTANCE" 2>/dev/null && p stack_version "$(stamusctl config version 2>/dev/null | grep -Eo '[0-9]+(\\.[0-9]+){2}[^[:space:]]*' | tail -1)" )`,
    `else p stamusctl missing; fi`,
    // теги образов текущего конфига (как img_tag_from_config скрипта)
    `CFG="$INSTANCE/config"`,
    `p os_tag "$(grep -rhoE "image:[[:space:]]*[\\"']?[^\\"'[:space:]]*opensearch:[0-9][^\\"'[:space:]]*" "$CFG" 2>/dev/null | awk '{print $2}' | tr -d '\\"' | head -1)"`,
    `p pg_tag "$(grep -rhoE "image:[[:space:]]*[\\"']?[^\\"'[:space:]]*postgres:[0-9][^\\"'[:space:]]*" "$CFG" 2>/dev/null | awk '{print $2}' | tr -d '\\"' | head -1)"`,
    `( cd "$INSTANCE" 2>/dev/null && p suricata_interfaces "$(stamusctl config get suricata.interfaces 2>/dev/null | tail -1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\\"' | xargs)" )`,
    // целостность конфигурации инстанса (как v4-проверки clearndr-update.sh):
    // compose-файл на месте и проект загружается docker compose.
    // Имя файла: docker-compose.yaml|yml или compose.yaml|yml (Compose Spec v2,
    // именно compose.yml создаёт stamusctl в новых версиях шаблона)
    `CF=`,
    `for cf in "$INSTANCE/config/docker-compose.yaml" "$INSTANCE/config/docker-compose.yml" "$INSTANCE/config/compose.yaml" "$INSTANCE/config/compose.yml"; do`,
    `  [ -f "$cf" ] && CF="$cf" && break`,
    `done`,
    `if [ -n "$CF" ]; then`,
    `  if docker compose version >/dev/null 2>&1; then`,
    `    if docker compose --project-directory "$INSTANCE/config" -f "$CF" config -q >/dev/null 2>&1; then`,
    `      p compose_ok 1`,
    `    else`,
    `      p compose_ok 0`,
    `      p compose_err "$(docker compose --project-directory "$INSTANCE/config" -f "$CF" config -q 2>&1 | head -2 | tr '\\n' ' ' | cut -c1-220)"`,
    `    fi`,
    `  else`,
    `    p compose_err "docker compose недоступен — проверка конфигурации пропущена"`,
    `  fi`,
    `else`,
    `  p compose_ok 0`,
    `  p compose_err "compose-файл не найден в $INSTANCE/config (docker-compose.yaml|yml, compose.yaml|yml) — стек неуправляем (восстановление: clearndr-repair-stack.sh)"`,
    `fi`,
    // предпроверки хоста (как preflight скрипта)
    `p max_map_count "$(sysctl -n vm.max_map_count 2>/dev/null || echo 0)"`,
    `p mem_avail_mb "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"`,
    `DR="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"`,
    `p docker_root "$DR"`,
    `p disk_free_mb "$(( $(df -Pk "$DR" 2>/dev/null | awk 'NR==2 {print $4}' ) / 1024 ))"`,
    // интеграция mikrocata2selks (MikroTik)
    `MK=0`,
    `ls /usr/local/bin/mikrocata*.py >/dev/null 2>&1 && MK=1`,
    `systemctl list-unit-files --no-legend 2>/dev/null | grep -q '^mikrocata' && MK=1`,
    `ls /etc/systemd/network/tzsp*.netdev >/dev/null 2>&1 && MK=1`,
    `p mikrocata "$MK"`,
    // контейнеры стека (имена <base>-<service>-<seed>)
    `docker ps -a --format 'CT\\t{{.Names}}\\t{{.Status}}' 2>/dev/null | grep -E -- '-(scirius|db|suricata|nginx|opensearch|fluentd|osd|evebox|arkime|rabbitmq|celery|cron|scout)-[A-Za-z0-9_]+\\s' || true`,
    // web UI + REST API
    `p web_http "$(curl -k -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH" 2>/dev/null || echo 000)"`,
    `if [ -n "$TOKEN" ]; then`,
    `  AB="$HEALTH"`,
    `  B="$(curl -k -s --max-time 15 -w '\\n%{http_code}' "$AB/rest/rules/source/" -H "Authorization: Token $TOKEN" 2>/dev/null || true)"`,
    `  AC="$(printf '%s' "$B" | tail -1)"`,
    `  # фолбэк: healthUrl (напр. публичный домен) может не проксировать /rest/ —`,
    `  # пробуем шлюз docker-моста: nginx стека слушает и на нём`,
    `  if [ "$AC" != "200" ]; then`,
    `    B2="$(curl -k -s --max-time 15 -w '\\n%{http_code}' "https://172.17.0.1/rest/rules/source/" -H "Authorization: Token $TOKEN" 2>/dev/null || true)"`,
    `    case "$(printf '%s' "$B2" | tail -1)" in`,
    `      200) AB="https://172.17.0.1"; B="$B2" ;;`,
    `    esac`,
    `  fi`,
    `  p api_http "$(printf '%s' "$B" | tail -1)"`,
    `  p api_sources "$(printf '%s' "$B" | head -n -1 | sed -n 's/.*"count"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' | head -1)"`,
    `  p api_base "$AB"`,
    `fi`,
    '',
  ].join('\n')
}

// ────────────────────────────── настройки ───────────────────────────────────

export async function loadUpdateSettings(): Promise<UpdateSettings> {
  const raw = await getSettings()
  const merged: UpdateSettings = { ...UPDATE_SETTINGS_DEFAULTS }
  for (const k of UPDATE_SETTING_KEYS) {
    const v = raw[k]
    if (v !== undefined && v !== null && v !== '') (merged as unknown as Record<string, string>)[k] = v
  }
  if (merged.updateMode !== 'local') merged.updateMode = 'ssh'
  if (merged.sudoMode !== 'sudo' && merged.sudoMode !== 'plain') merged.sudoMode = 'auto'
  return merged
}

/** Настройки для отдачи в UI: секреты маскируются */
export function maskSecrets(s: UpdateSettings): UpdateSettings & { sshKeySet: boolean } {
  return {
    ...s,
    sshKey: s.sshKey ? '********' : '',
    apiToken: s.apiToken ? '********' : '',
    sshKeySet: !!s.sshKey,
  }
}

// ────────────────────────────── исполнение команд ───────────────────────────

interface ExecRes { ok: boolean; stdout: string; stderr: string }

async function runLocal(cmd: string, timeoutMs: number): Promise<ExecRes> {
  try {
    const { stdout, stderr } = await execFileP('bash', ['-c', cmd], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.killed ? 'таймаут выполнения команды' : (err.stderr || err.message || 'ошибка выполнения'),
    }
  }
}

function sshArgs(cfg: UpdateSettings, remoteCmd: string): string[] {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=12',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
    '-p', cfg.sshPort || '22',
  ]
  if (cfg.sshKey) args.push('-i', '/tmp/clearndr-hub-key', '-o', 'IdentitiesOnly=yes')
  args.push(`${cfg.sshUser}@${cfg.sshHost}`, remoteCmd)
  return args
}

/** SSH-вызов с передачей stdin (base64-полезная нагрузка) */
async function runSsh(cfg: UpdateSettings, stdinData: string | null, remoteCmd: string, timeoutMs: number): Promise<ExecRes> {
  // ключ пишем во временный файл с правами 600 на каждый вызов (надёжно и без гонок)
  if (cfg.sshKey) {
    await fs.writeFile('/tmp/clearndr-hub-key', cfg.sshKey.replace(/\r\n/g, '\n'))
    await fs.chmod('/tmp/clearndr-hub-key', 0o600)
  }
  const args = sshArgs(cfg, remoteCmd)
  return new Promise((resolve) => {
    const child = execFileP('ssh', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }) as unknown as {
      child: { stdin: { write: (d: string) => void; end: () => void } }
      then: (
        fn: (v: { stdout: string; stderr: string }) => void,
        rej: (e: { stdout?: string; stderr?: string; message?: string; killed?: boolean }) => void,
      ) => void
    }
    if (stdinData !== null) {
      child.child.stdin.write(stdinData)
      child.child.stdin.end()
    }
    child.then(
      (v) => resolve({ ok: true, stdout: v.stdout ?? '', stderr: v.stderr ?? '' }),
      (e) =>
        resolve({
          ok: false,
          stdout: e.stdout ?? '',
          stderr: e.killed ? 'таймаут выполнения команды' : (e.stderr || e.message || 'ssh: ошибка'),
        }),
    )
  })
}

/** Выполнить shell-команду в выбранном режиме (ssh|local) */
export async function execOnHost(cfg: UpdateSettings, command: string, timeoutMs = 60_000): Promise<ExecRes> {
  if (cfg.updateMode === 'local') return runLocal(command, timeoutMs)
  // base64-обёртка: устойчива к любым кавычкам в команде
  const b64 = Buffer.from(command, 'utf8').toString('base64')
  return runSsh(cfg, null, `echo ${b64} | base64 -d | bash`, timeoutMs)
}

// ────────────────────────────── последний релиз ─────────────────────────────

/** Последний релиз шаблона Clear NDR (GitHub API; вызывается из хаба, хост не нужен).
 *  CLEARNDR_RELEASES_JSON — путь к локальному JSON с tag_name (offline-режим). */
export async function fetchLatestRelease(): Promise<LatestRelease | { tag: ''; error: string }> {
  if (process.env.CLEARNDR_RELEASES_JSON) {
    try {
      const j = JSON.parse(await fs.readFile(process.env.CLEARNDR_RELEASES_JSON, 'utf8')) as { tag_name?: string; name?: string; published_at?: string; html_url?: string }
      if (j.tag_name) return { tag: j.tag_name, name: j.name, publishedAt: j.published_at, url: j.html_url }
      return { tag: '', error: 'CLEARNDR_RELEASES_JSON: нет tag_name' }
    } catch (e) {
      return { tag: '', error: `CLEARNDR_RELEASES_JSON: ${(e as Error).message}` }
    }
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    const res = await fetch(TEMPLATES_API, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ndr-rules-hub' },
      cache: 'no-store',
    })
    clearTimeout(timer)
    if (!res.ok) return { tag: '', error: `GitHub API: HTTP ${res.status}` }
    const j = (await res.json()) as { tag_name?: string; name?: string; published_at?: string; html_url?: string }
    if (!j.tag_name) return { tag: '', error: 'GitHub API: ответ без tag_name' }
    return { tag: j.tag_name, name: j.name, publishedAt: j.published_at, url: j.html_url }
  } catch (e) {
    return { tag: '', error: (e as Error).message || 'GitHub недоступен' }
  }
}

// ────────────────────────────── probe хоста ─────────────────────────────────

/** Кэш probe на 20 секунд — UI поллит статус чаще, чем нужно ходить по SSH */
let probeCache: { at: number; key: string; value: HostProbe } | null = null

export async function probeHost(cfg: UpdateSettings, force = false): Promise<HostProbe> {
  const key = JSON.stringify([cfg.updateMode, cfg.sshHost, cfg.sshPort, cfg.sshUser, cfg.instanceDir, cfg.healthUrl, cfg.apiToken])
  if (!force && probeCache && probeCache.key === key && Date.now() - probeCache.at < 20_000) {
    return probeCache.value
  }
  const script = buildProbeScript({ instanceDir: cfg.instanceDir, healthUrl: cfg.healthUrl, apiToken: cfg.apiToken })
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  const res =
    cfg.updateMode === 'local'
      ? await runLocal(`echo ${b64} | base64 -d | bash`, 45_000)
      : await runSsh(cfg, null, `echo ${b64} | base64 -d | bash`, 45_000)
  const probe: HostProbe = {
    ok: res.ok,
    mode: cfg.updateMode,
    containers: [],
    ranAt: new Date().toISOString(),
    ...(res.ok ? parseProbeOutput(res.stdout) : {}),
  }
  if (!res.ok) probe.error = (res.stderr || '').trim().slice(0, 500) || 'не удалось выполнить проверку на хосте'
  probeCache = { at: Date.now(), key, value: probe }
  return probe
}

// ────────────────────────────── прогоны обновления ──────────────────────────

function remoteRunRoot(cfg: UpdateSettings): string {
  return `${cfg.instanceDir.replace(/\/+$/, '')}/.hub-update-runs`
}

async function runMetaPath(runId: string): Promise<string> {
  const dir = path.join(UPDATE_RUNS_DIR, runId)
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, 'meta.json')
}

async function writeMeta(meta: RunMeta): Promise<void> {
  const p = await runMetaPath(meta.runId)
  await fs.writeFile(p, JSON.stringify(meta, null, 2), { mode: 0o600 })
}

async function readMeta(runId: string): Promise<RunMeta | null> {
  try {
    const p = await runMetaPath(runId)
    return JSON.parse(await fs.readFile(p, 'utf8')) as RunMeta
  } catch {
    return null
  }
}

/** Список прогонов (локальные метаданные хаба), новые — первыми */
export async function listRuns(): Promise<RunMeta[]> {
  try {
    const dirs = await fs.readdir(UPDATE_RUNS_DIR)
    const metas: RunMeta[] = []
    for (const d of dirs) {
      const m = await readMeta(d)
      if (m) metas.push(m)
    }
    return metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  } catch {
    return []
  }
}

/** Запуск обновления: раннер на хосте, детач, лог на стороне хоста */
export async function startUpdate(cfg: UpdateSettings, opts: UpdateOptions): Promise<{ ok: boolean; error?: string; runId?: string; args?: string[] }> {
  // защита от параллельного запуска
  const runs = await listRuns()
  const active = runs.find((r) => !r.finishedAt)
  if (active) {
    // перепроверяем фактическое состояние: rc мог появиться, а мету никто не закрыл;
    // зависший прогон (процесс погиб при перезапуске контейнера хаба) реанимируется сам
    const st = await readRunStatus(cfg, active.runId)
    if (st.active) return { ok: false, error: `обновление уже выполняется (прогон ${active.runId}) — остановите его кнопкой «Прервать обновление»` }
  }

  let args: string[]
  try {
    args = buildUpdateArgs(opts)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const runId = `update-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  // каталог прогона: ssh — на хосте рядом с инстансом; local — в томе хаба
  const remoteDir = cfg.updateMode === 'local' ? path.join(UPDATE_RUNS_DIR, runId) : `${remoteRunRoot(cfg)}/${runId}`
  const meta: RunMeta = { runId, mode: cfg.updateMode, startedAt: new Date().toISOString(), options: opts, args, remoteDir }
  await writeMeta(meta)

  // 1) скрипт обязан существовать — синхронизируем из хаба, чтобы прогон всегда
  //    шёл кодом той же версии, что и интерфейс
  const sync = await syncScript(cfg)
  if (!sync.ok) {
    meta.finishedAt = new Date().toISOString()
    await writeMeta(meta)
    return { ok: false, error: `скрипт обновления не синхронизирован: ${sync.error}` }
  }

  const runner = buildRunnerScript({
    instanceDir: cfg.instanceDir,
    scriptPath: cfg.scriptPath,
    args,
    sudo: cfg.updateMode === 'local' ? '' : sudoPrefix(cfg.sudoMode, cfg.sshUser),
    runDir: remoteDir,
  })
  const rb64 = Buffer.from(runner, 'utf8').toString('base64')

  if (cfg.updateMode === 'local') {
    // local: лог, pid и rc — в каталоге прогона (том хаба); spawn detached даёт
    // раннеру собственную группу процессов — отменяется kill(-pid)
    const dir = remoteDir // = UPDATE_RUNS_DIR/runId
    const logPath = path.join(dir, 'log.txt')
    const rcPath = path.join(dir, 'rc')
    await fs.writeFile(path.join(dir, 'runner.sh'), runner.replace(/^cd .*$/m, `cd '${cfg.instanceDir}' 2>/dev/null || true`), { mode: 0o755 })
    const out = await fs.open(logPath, 'a')
    // detached даёт раннеру собственную группу процессов (pid == PGID);
    // дескрипторы файла лога передаём числами (fd), чтобы не держать FileHandle
    const spawnOpts: SpawnOptions = {
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
      cwd: cfg.instanceDir,
    }
    const child = spawn('bash', [path.join(dir, 'runner.sh')], spawnOpts)
    await fs.writeFile(path.join(dir, 'pid.txt'), String(child.pid ?? '')).catch(() => undefined)
    child.on('exit', async (code) => {
      await out.close().catch(() => undefined)
      // маркер отмены (cancelRun): остановленный прогон получает код 143
      let cancelledFlag = false
      try { await fs.access(path.join(dir, 'cancelled')); cancelledFlag = true } catch { /* нет маркера */ }
      let finalCode = code ?? 1
      if (cancelledFlag) finalCode = 143
      // rc пишет сам раннер (код скрипта); fallback — если раннер не дошёл до записи
      try {
        const rcRaw = parseInt((await fs.readFile(rcPath, 'utf8')).trim(), 10)
        if (Number.isFinite(rcRaw)) finalCode = rcRaw
      } catch {
        await fs.writeFile(rcPath, String(finalCode)).catch(() => undefined)
      }
      const m = await readMeta(runId)
      if (m && !m.finishedAt) {
        m.finishedAt = new Date().toISOString()
        m.exitCode = finalCode
        if (cancelledFlag) m.cancelled = true
        await writeMeta(m)
      }
    })
    child.unref()
    meta.logPath = logPath
    await writeMeta(meta)
    return { ok: true, runId, args }
  }

  // 2) ssh: каталог прогона + раннер + nohup setsid
  const r = await execOnHost(
    cfg,
    [
      `mkdir -p '${remoteDir}'`,
      `echo ${rb64} | base64 -d > '${remoteDir}/runner.sh'`,
      `chmod 700 '${remoteDir}/runner.sh'`,
      // setsid: раннер становится лидером собственной группы — по pid из файла
      // выполняется отмена (kill -- -pid); лог пишется на хосте
      `cd '${cfg.instanceDir}' && nohup setsid sh '${remoteDir}/runner.sh' >> '${remoteDir}/log' 2>&1 &`,
      `echo started`,
    ].join('\n'),
    30_000,
  )
  if (!r.ok || !r.stdout.includes('started')) {
    meta.finishedAt = new Date().toISOString()
    await writeMeta(meta)
    return { ok: false, error: `не удалось запустить обновление на хосте: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}` }
  }
  await logHubEvent('info', `Запущено обновление Clear NDR (${runId}): ${args.join(' ')}`)
  return { ok: true, runId, args }
}

/** Синхронизация скрипта на хост: обновлённый код из образа хаба → scriptPath */
export async function syncScript(cfg: UpdateSettings): Promise<{ ok: boolean; error?: string }> {
  const src = localScriptPath()
  let content: string
  try {
    content = await fs.readFile(src, 'utf8')
  } catch {
    return { ok: false, error: `скрипт не найден в хабе: ${src}` }
  }
  if (cfg.updateMode === 'local') {
    // в local-режиме скрипт кладём по scriptPath (если его ещё нет)
    try {
      await fs.access(cfg.scriptPath)
      return { ok: true }
    } catch {
      try {
        await fs.mkdir(path.dirname(cfg.scriptPath), { recursive: true })
        await fs.writeFile(cfg.scriptPath, content, { mode: 0o755 })
        return { ok: true }
      } catch (e) {
        return { ok: false, error: `${cfg.scriptPath} недоступен: ${(e as Error).message}` }
      }
    }
  }
  const sb64 = Buffer.from(content, 'utf8').toString('base64')
  const cmd = [
    `mkdir -p "$(dirname '${cfg.scriptPath}')"`,
    `echo ${sb64} | base64 -d > '${cfg.scriptPath}'`,
    `chmod 755 '${cfg.scriptPath}'`,
    `echo synced`,
  ].join('\n')
  const r = await execOnHost(cfg, cmd, 60_000)
  if (!r.ok || !r.stdout.includes('synced')) return { ok: false, error: (r.stderr || r.stdout || '').trim().slice(0, 400) || 'ошибка записи скрипта' }
  return { ok: true }
}

/** Статус прогона: активен/код выхода + хвост лога */
export async function readRunStatus(cfg: UpdateSettings, runId: string, tailBytes = 24_000): Promise<RunStatus> {
  const meta = await readMeta(runId)
  if (!meta) return { runId, active: false, log: 'прогон не найден' }
  const localRc = path.join(UPDATE_RUNS_DIR, runId, 'rc')
  if (cfg.updateMode === 'local') {
    let rc: string | null = null
    try { rc = (await fs.readFile(localRc, 'utf8')).trim() } catch { /* ещё работает */ }
    let log = ''
    try { log = await readTailFile(path.join(UPDATE_RUNS_DIR, runId, 'log.txt'), tailBytes) } catch { /* нет лога */ }
    let active = rc === null
    // реанимация зависшего прогона: rc нет, но процесса уже нет (или pid
    // переиспользован чужим процессом после пересоздания контейнера хаба)
    if (active) {
      const pid = await updatePid(runId)
      const startedMs = Date.parse(meta.startedAt || '') || 0
      const ageMs = startedMs > 0 ? Date.now() - startedMs : -1
      if (pid > 0 && (!pidAliveLocal(pid) || (ageMs >= 0 && !pidAliveForAge(pid, ageMs)))) {
        const reason = !pidAliveLocal(pid)
          ? `процесс прогона не найден (pid ${pid} завершился без записи кода — контейнер хаба перезапускался?) — прогон помечен остановленным`
          : `pid ${pid} принадлежит другому процессу (контейнер хаба пересоздавался, номер переиспользован) — прогон помечен остановленным`
        await finalizeInterruptedUpdate(runId, reason, !!meta.cancelled)
        rc = '143'
        active = false
        log += `\n[hub] ${reason}`
      } else if (pid === 0 && startedMs && Date.now() - startedMs > STALE_RUN_MS) {
        const reason = 'pid-файл не найден и прогон запущен более 3 минут назад — запуск не состоялся; прогон помечен остановленным'
        await finalizeInterruptedUpdate(runId, reason, !!meta.cancelled)
        rc = '143'
        active = false
        log += `\n[hub] ${reason}`
      }
    }
    await closeMetaIfNeeded(meta, active, rc)
    return { runId, active, exitCode: rc !== null ? parseInt(rc, 10) : undefined, cancelled: !!meta.cancelled, log, startedAt: meta.startedAt, finishedAt: meta.finishedAt }
  }
  const remoteDir = meta.remoteDir || `${remoteRunRoot(cfg)}/${runId}`
  const r = await execOnHost(
    cfg,
    [
      `tail -c ${tailBytes} '${remoteDir}/log' 2>/dev/null || true`,
      `printf 'RC:' ; cat '${remoteDir}/rc' 2>/dev/null || echo RUNNING`,
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
    // ssh не отработал — фактическое состояние неизвестно: считаем прогон живым,
    // но показываем причину, чтобы не висело «бесконечное обновление» без объяснений
    const active = true
    return {
      runId,
      active,
      exitCode: undefined,
      log: (log + (log ? '\n' : '') + `[hub] не удалось опросить хост: ${(r.stderr || '').trim().slice(0, 300)}`).trim(),
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
    }
  }
  // реанимация: rc нет, а процесса уже нет → пишем rc на хосте и финализируем
  if (rc === null) {
    const startedMs = Date.parse(meta.startedAt || '') || 0
    const dead = out.includes('PIDDEAD')
    const none = out.includes('PIDNONE')
    if (dead || (none && startedMs && Date.now() - startedMs > STALE_RUN_MS)) {
      const reason = dead
        ? 'процесс прогона не найден (pid завершился без записи кода) — прогон помечен остановленным'
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
  await closeMetaIfNeeded(meta, active, rc === null ? null : String(rc))
  return { runId, active, exitCode: rc ?? undefined, cancelled: !!meta.cancelled, log, startedAt: meta.startedAt, finishedAt: meta.finishedAt }
}

async function closeMetaIfNeeded(meta: RunMeta, active: boolean, rc: string | null): Promise<void> {
  if (active || rc === null || meta.finishedAt) return
  meta.finishedAt = new Date().toISOString()
  meta.exitCode = parseInt(rc, 10)
  await writeMeta(meta)
  await logHubEvent(meta.exitCode === 0 ? 'success' : 'error', `Обновление Clear NDR (${meta.runId}) завершено с кодом ${meta.exitCode}`)
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

/** Отмена прогона: TERM группе процессов раннера, при упорстве KILL; rc дописывается — иначе прогон оставался «выполняется» */
export async function cancelRun(cfg: UpdateSettings, runId: string): Promise<{ ok: boolean; error?: string }> {
  const meta = await readMeta(runId)
  if (!meta) return { ok: false, error: 'прогон не найден' }
  if (meta.finishedAt) return { ok: false, error: 'прогон уже завершён' }
  if (meta.mode === 'local') {
    // маркер отмены: exit-обработчик запишет код 143 и флаг cancelled
    await fs.writeFile(path.join(UPDATE_RUNS_DIR, runId, 'cancelled'), '1').catch(() => undefined)
    const pid = await updatePid(runId)
    const startedMs = Date.parse(meta.startedAt || '') || 0
    const ageMs = startedMs > 0 ? Date.now() - startedMs : -1
    // kill только если pid действительно принадлежит прогону
    if (pid > 0 && pidAliveLocal(pid) && (ageMs < 0 || pidAliveForAge(pid, ageMs))) {
      // pid.txt пишет хаб (child.pid), pid — сам раннер ($$ = лидер группы)
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
    } else if (pid > 0 && pidAliveLocal(pid)) {
      await fs.appendFile(path.join(UPDATE_RUNS_DIR, runId, 'log.txt'), '\n[hub] pid принадлежит другому процессу (переиспользован после пересоздания контейнера) — остановка без kill.\n').catch(() => undefined)
    }
    // если раннер не успел записать rc — дописываем и финализируем сами
    if (!(await updRcExists(runId))) {
      await fs.writeFile(path.join(UPDATE_RUNS_DIR, runId, 'rc'), '143').catch(() => undefined)
      await fs.appendFile(path.join(UPDATE_RUNS_DIR, runId, 'log.txt'), '\n[hub] Прогон остановлен пользователем.\n').catch(() => undefined)
    }
    const m = await readMeta(runId)
    if (m && !m.finishedAt) {
      m.finishedAt = new Date().toISOString()
      m.exitCode = 143
      m.cancelled = true
      await writeMeta(m)
      await logHubEvent('error', `Обновление Clear NDR (${runId}) остановлено пользователем`)
    }
    return { ok: true }
  }
  const remoteDir = meta.remoteDir || `${remoteRunRoot(cfg)}/${runId}`
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
  const m = await readMeta(runId)
  if (m && !m.finishedAt) {
    m.finishedAt = new Date().toISOString()
    m.exitCode = 143
    m.cancelled = true
    await writeMeta(m)
    await logHubEvent('error', `Обновление Clear NDR (${runId}) остановлено пользователем`)
  }
  return { ok: true }
}

// ───── зависшие/прерванные прогоны обновления (реанимация, как в clearndr-osd) ─────

const STALE_RUN_MS = 3 * 60 * 1000 // нет pid-файла вообще → через 3 мин считаем прогон прерванным

async function updatePid(runId: string): Promise<number> {
  for (const f of ['pid.txt', 'pid']) {
    try {
      const pid = parseInt((await fs.readFile(path.join(UPDATE_RUNS_DIR, runId, f), 'utf8')).trim(), 10)
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
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Жив ли процесс и принадлежит ли он этому прогону (как pidAliveForAge в
 * clearndr-osd.ts): сравниваем возраст процесса (/proc/<pid>/stat, поле 22)
 * с возрастом прогона — после пересоздания контейнера хаба номер pid может
 * достаться чужому процессу.
 */
function pidAliveForAge(pid: number, runAgeMs: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const uptime = parseFloat(readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)[0] || '0')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = parseFloat(rest[19] || '0')
    const aliveForS = uptime - startTicks / 100 // CLK_TCK (USER_HZ) = 100
    const ageS = runAgeMs / 1000
    if (!(aliveForS >= 0) || !(ageS >= 0)) return true
    return Math.abs(aliveForS - ageS) <= 120
  } catch {
    return true
  }
}

async function updRcExists(runId: string): Promise<boolean> {
  try { await fs.access(path.join(UPDATE_RUNS_DIR, runId, 'rc')); return true } catch { return false }
}

async function finalizeInterruptedUpdate(runId: string, reason: string, cancelled: boolean): Promise<void> {
  const dir = path.join(UPDATE_RUNS_DIR, runId)
  await fs.appendFile(path.join(dir, 'log.txt'), `\n[hub] ${reason}\n`).catch(() => undefined)
  await fs.writeFile(path.join(dir, 'rc'), '143').catch(() => undefined)
  const m = await readMeta(runId)
  if (m && !m.finishedAt) {
    m.finishedAt = new Date().toISOString()
    m.exitCode = 143
    m.cancelled = cancelled || m.cancelled || false
    await writeMeta(m)
    await logHubEvent('error', `Обновление Clear NDR (${runId}) прервано: ${reason}`)
  }
}

async function logHubEvent(level: string, message: string): Promise<void> {
  try {
    const { log } = await import('./service')
    await log(level, 'update', message)
  } catch {
    /* журнал не критичен */
  }
}
