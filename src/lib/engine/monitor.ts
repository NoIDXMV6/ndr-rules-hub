// ─────────────────────────────────────────────────────────────────────────────
// Системный мониторинг для вкладки «Обзор»: CPU, память, диски, сетевые
// интерфейсы, запущенные контейнеры, WireGuard-туннели.
// Всё читается из /proc и df — /proc в контейнере отражает ЯДРО ХОСТА,
// поэтому CPU/память/аптайм — это состояние сервера, а не контейнера.
// Диски: df видит монтирования контейнера (overlay = корневой диск хоста,
// /app/data = каталог данных на хосте) — этого достаточно для контроля места.
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { accessSync, constants as fsConstants } from 'fs'
import path from 'path'
import { wgStatus, WgStatus } from './vpn'

const execFileP = promisify(execFile)

const DATA_DIR = process.env.RULES_DATA_DIR || '/app/data'
const DOCKER_SOCKET = '/var/run/docker.sock'

// ── CPU ──────────────────────────────────────────────────────────────────────

export interface CpuInfo {
  usagePct: number
  load1: number
  load5: number
  load15: number
  cores: number
}

function parseProcStat(text: string): { idle: number; total: number } {
  const line = text.split('\n').find((l) => l.startsWith('cpu '))
  if (!line) return { idle: 0, total: 0 }
  const cols = line.trim().split(/\s+/).slice(1).map(Number)
  if (cols.length < 5) return { idle: 0, total: 0 }
  // user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (cols[3] || 0) + (cols[4] || 0) // idle + iowait
  const total = cols.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  return { idle, total }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Утилизация CPU за окно ~250 мс + loadavg + число ядер */
export async function readCpu(): Promise<CpuInfo> {
  const [loadRes, coresRes] = await Promise.all([readFile('/proc/loadavg', 'utf8').catch(() => ''), readFile('/proc/cpuinfo', 'utf8').catch(() => '')])
  const load = loadRes.split(/\s+/).slice(0, 3).map(Number)
  const cores = coresRes ? (coresRes.match(/^processor\s*:/gm) ?? []).length || 1 : 1
  const s1 = parseProcStat(await readFile('/proc/stat', 'utf8').catch(() => ''))
  await sleep(250)
  const s2 = parseProcStat(await readFile('/proc/stat', 'utf8').catch(() => ''))
  const dTotal = s2.total - s1.total
  const dIdle = s2.idle - s1.idle
  const usagePct = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0
  return {
    usagePct: Math.round(usagePct * 10) / 10,
    load1: load[0] ?? 0,
    load5: load[1] ?? 0,
    load15: load[2] ?? 0,
    cores,
  }
}

// ── Память ───────────────────────────────────────────────────────────────────

export interface MemInfo {
  totalMb: number
  freeMb: number
  availableMb: number
  usedMb: number
  usedPct: number
}

/** /proc/meminfo — состояние памяти ХОСТА */
export async function readMem(): Promise<MemInfo> {
  const text = await readFile('/proc/meminfo', 'utf8').catch(() => '')
  const get = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
    return m ? parseInt(m[1], 10) / 1024 : 0 // kB → MB
  }
  const totalMb = get('MemTotal')
  const freeMb = get('MemFree')
  const availableMb = get('MemAvailable') || freeMb
  const usedMb = Math.max(0, totalMb - availableMb)
  return {
    totalMb: Math.round(totalMb),
    freeMb: Math.round(freeMb),
    availableMb: Math.round(availableMb),
    usedMb: Math.round(usedMb),
    usedPct: totalMb > 0 ? Math.round((usedMb / totalMb) * 1000) / 10 : 0,
  }
}

// ── Диски ────────────────────────────────────────────────────────────────────

export interface DiskInfo {
  fs: string
  type: string
  mount: string
  totalMb: number
  usedMb: number
  freeMb: number
  usedPct: number
  /** true — том с данными хаба (БД, кэш, сборки) */
  isData: boolean
}

const FS_TYPE_RE = /^(overlay|ext[234]|xfs|btrfs|zfs|f2fs|jfs|reiserfs|vfat|ntfs|lustre)$/

/** df -kPT: реальные файловые системы, смонтированные в контейнере */
export async function readDisks(): Promise<DiskInfo[]> {
  let out = ''
  try {
    const r = await execFileP('df', ['-kPT'], { timeout: 10_000 })
    out = r.stdout
  } catch {
    return []
  }
  const dataMount = path.resolve(DATA_DIR)
  const disks: DiskInfo[] = []
  for (const line of out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 7) continue
    const [fs, type, totalKb, usedKb, availKb, , mount] = cols
    const total = parseInt(totalKb, 10)
    if (!Number.isFinite(total) || total <= 0) continue
    // исключаем псевдо-ФС; squashfs — read-only снапшоты, места не контролируют
    if (!FS_TYPE_RE.test(type) || type === 'squashfs') continue
    if (!mount.startsWith('/')) continue
    const used = parseInt(usedKb, 10)
    const free = parseInt(availKb, 10)
    if (!Number.isFinite(used) || !Number.isFinite(free)) continue
    disks.push({
      fs,
      type,
      mount,
      totalMb: Math.round(total / 1024),
      usedMb: Math.round(used / 1024),
      freeMb: Math.round(free / 1024),
      usedPct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
      isData: path.resolve(mount) === dataMount || dataMount.startsWith(path.resolve(mount) + '/'),
    })
  }
  // один mountpoint на том: overlay может дублироваться (bind-монтирования того же диска)
  const seen = new Set<string>()
  return disks
    .sort((a, b) => (b.isData ? 1 : 0) - (a.isData ? 1 : 0) || b.usedMb - a.usedMb)
    .filter((d) => {
      const key = d.isData ? `data:${d.mount}` : d.mount
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// ── Сетевые интерфейсы ───────────────────────────────────────────────────────

export interface NetIface {
  iface: string
  rxBytes: number
  txBytes: number
  up: boolean
}

const HIDDEN_IFACE_RE = /^(lo|veth\S*|br-\S+|docker0|dummy\S*|tun\S*0*[1-9]\d*$)/

/** /proc/net/dev: счётчики rx/tx по интерфейсам (скорость клиент считает дельтой) */
export async function readNet(): Promise<NetIface[]> {
  const text = await readFile('/proc/net/dev', 'utf8').catch(() => '')
  const out: NetIface[] = []
  for (const line of text.split('\n').slice(2)) {
    const m = line.match(/^\s*(\S+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/)
    if (!m) continue
    const [, iface, rx, tx] = m
    if (HIDDEN_IFACE_RE.test(iface)) continue
    out.push({ iface, rxBytes: parseInt(rx, 10), txBytes: parseInt(tx, 10), up: true })
  }
  // интерфейсы, у которых трафика ноль с загрузки (down): оставляем wg* и eth*/ens*
  return out.filter((i) => i.iface.startsWith('wg') || /^eth|^ens|^eno|^enp/.test(i.iface) || i.rxBytes + i.txBytes > 0)
}

// ── Контейнеры ───────────────────────────────────────────────────────────────

export interface ContainersInfo {
  available: boolean
  error?: string
  hint?: string
  list: Array<{ name: string; image: string; status: string; state: string; up: boolean; isHub: boolean }>
}

/** docker ps через смонтированный сокет; без сокета — честное сообщение */
export async function readContainers(): Promise<ContainersInfo> {
  try {
    accessSync(DOCKER_SOCKET, fsConstants.F_OK)
  } catch {
    return {
      available: false,
      error: '/var/run/docker.sock не смонтирован в контейнер хаба',
      hint: 'Добавьте в docker-compose.yml: volumes: - /var/run/docker.sock:/var/run/docker.sock:ro — и пересоздайте контейнер (docker compose up -d --force-recreate)',
      list: [],
    }
  }
  try {
    const r = await execFileP('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}'], { timeout: 15_000 })
    const hubName = process.env.HOSTNAME || ''
    const list = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, image, status, state] = line.split('\t')
        return {
          name,
          image: image ?? '—',
          status: status ?? '—',
          state: state ?? 'unknown',
          up: state === 'running',
          isHub: name === hubName || image.startsWith('ndr-rules-hub'),
        }
      })
    return { available: true, list }
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: string }
    return {
      available: false,
      error: err.code === 'ENOENT' ? 'docker CLI не установлен в контейнере' : (err.stderr || err.message || 'docker ps failed').trim(),
      hint: 'Проверьте монтирование /var/run/docker.sock и права на сокет',
      list: [],
    }
  }
}

// ── Аптайм ───────────────────────────────────────────────────────────────────

export async function readUptimeSec(): Promise<number> {
  const text = await readFile('/proc/uptime', 'utf8').catch(() => '')
  return Math.round(parseFloat(text.split(/\s+/)[0]) || 0)
}

// ── Сводка для /api/system ───────────────────────────────────────────────────

export interface SystemStats {
  ts: string
  uptimeSec: number
  cpu: CpuInfo
  mem: MemInfo
  disks: DiskInfo[]
  net: NetIface[]
  containers: ContainersInfo
  wg: WgStatus
}

export async function readSystemStats(): Promise<SystemStats> {
  const [uptimeSec, cpu, mem, disks, net, containers, wg] = await Promise.all([
    readUptimeSec(),
    readCpu(),
    readMem(),
    readDisks(),
    readNet(),
    readContainers(),
    wgStatus(),
  ])
  return { ts: new Date().toISOString(), uptimeSec, cpu, mem, disks, net, containers, wg }
}
