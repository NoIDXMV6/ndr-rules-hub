// ─────────────────────────────────────────────────────────────────────────────
// Управление WireGuard (wg-quick) — конфиги, up/down, статус, проверка
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)
const WG_DIR = process.env.WG_CONFIG_DIR || '/etc/wireguard'

export interface WgTools {
  wgQuick: boolean
  wg: boolean
  tunDevice: boolean
  netAdmin: boolean
  notes: string[]
}

/** Проверка доступности инструментов WireGuard в системе/контейнере */
export async function checkWgTools(): Promise<WgTools> {
  const t: WgTools = { wgQuick: false, wg: false, tunDevice: false, netAdmin: false, notes: [] }
  const which = async (cmd: string) => {
    try {
      await execFileP('which', [cmd])
      return true
    } catch {
      return false
    }
  }
  t.wg = await which('wg')
  t.wgQuick = await which('wg-quick')
  try {
    const st = await execFileP('test', ['-e', '/dev/net/tun'])
    t.tunDevice = st.exitCode === 0
  } catch {
    t.tunDevice = false
  }
  if (!t.wg) t.notes.push('Утилита wg не установлена (в контейнере: apk add wireguard-tools-wg-quick / apt install wireguard-tools)')
  if (!t.tunDevice) t.notes.push('Нет /dev/net/tun — WireGuard-туннели недоступны (на загрузку правил не влияет). Нужно: device /dev/net/tun + cap NET_ADMIN — см. README, раздел «Нет /dev/net/tun»')
  try {
    // проверка прав: ip link add требует NET_ADMIN
    const r = await execFileP('ip', ['link', 'add', 'wg-test-nonexistent', 'type', 'wireguard'])
    t.netAdmin = true
    void r
  } catch (e) {
    const msg = (e as { stderr?: string; code?: number }).stderr ?? String(e)
    t.netAdmin = !msg.includes('Operation not permitted') && !msg.includes('not found')
  }
  return t
}

export function parseWgConfig(config: string): { ok: boolean; error?: string; iface?: string; peers?: number; endpoint?: string } {
  const cfg = config.trim()
  const stripped = cfg.replace(/^\s*#.*$/gm, '').trim() // убираем комментарии
  if (!stripped.startsWith('[Interface]')) return { ok: false, error: 'Конфиг должен начинаться с секции [Interface]' }
  if (!/^\s*PrivateKey\s*=/m.test(stripped)) return { ok: false, error: 'Отсутствует PrivateKey в [Interface]' }
  const ifaceMatch = cfg.match(/^#\s*InterfaceName\s*[:=]\s*(\S+)/m)
  const iface = ifaceMatch?.[1] ?? 'wg0'
  const peers = (stripped.match(/^\s*\[Peer\]/gm) ?? []).length
  const endpoint = stripped.match(/^\s*Endpoint\s*=\s*(\S+)/m)?.[1]
  if (peers === 0) return { ok: false, error: 'Отсутствует секция [Peer]' }
  return { ok: true, iface, peers, endpoint }
}

/** Применить конфиг: сохраняет файл и поднимает туннель (wg-quick up) */
export async function wgUp(name: string, config: string): Promise<{ ok: boolean; error?: string }> {
  const parsed = parseWgConfig(config)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const iface = parsed.iface ?? 'wg0'
  try {
    await execFileP('mkdir', ['-p', WG_DIR])
    await execFileP('tee', [`${WG_DIR}/${iface}.conf`], { input: config })
    await execFileP('chmod', ['600', `${WG_DIR}/${iface}.conf`])
    const { stderr } = await execFileP('wg-quick', ['up', `${WG_DIR}/${iface}.conf`], { timeout: 30_000 })
    return { ok: true, error: stderr || undefined }
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    return { ok: false, error: err.stderr || err.message || 'wg-quick up failed' }
  }
}

export async function wgDown(name: string): Promise<{ ok: boolean; error?: string }> {
  const iface = name.replace(/\.conf$/, '')
  try {
    await execFileP('wg-quick', ['down', `${WG_DIR}/${iface}.conf`], { timeout: 30_000 })
    return { ok: true }
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    return { ok: false, error: err.stderr || err.message || 'wg-quick down failed' }
  }
}

export interface WgStatus {
  available: boolean
  error?: string
  interfaces: Array<{
    name: string
    publicKey?: string
    listeningPort?: string
    peers: Array<{
      publicKey?: string
      endpoint?: string
      allowedIps?: string
      latestHandshake?: string
      transferRx?: string
      transferTx?: string
      online: boolean
    }>
  }>
}

/** Текущий статус: вывод `wg show all dump` */
export async function wgStatus(): Promise<WgStatus> {
  try {
    const { stdout } = await execFileP('wg', ['show', 'all', 'dump'], { timeout: 15_000 })
    const ifaces: WgStatus['interfaces'] = []
    let cur: WgStatus['interfaces'][number] | null = null
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const cols = line.split('\t')
      if (cols.length === 5) {
        // строка интерфейса: iface privkey pubkey fwmark port
        cur = { name: cols[0], publicKey: cols[2] || undefined, listeningPort: cols[4] || undefined, peers: [] }
        ifaces.push(cur)
      } else if (cols.length >= 8 && cur) {
        // строка пира: iface pubkey endpoint allowed-ips handshake rx tx keepalive
        const handshake = parseInt(cols[4], 10)
        const online = Number.isFinite(handshake) && handshake > 0 && Date.now() / 1000 - handshake < 180
        cur.peers.push({
          publicKey: cols[1] || undefined,
          endpoint: cols[2] === '(none)' ? undefined : cols[2],
          allowedIps: cols[3] || undefined,
          latestHandshake: handshake > 0 ? new Date(handshake * 1000).toISOString() : 'нет',
          transferRx: cols[5] || undefined,
          transferTx: cols[6] || undefined,
          online,
        })
      }
    }
    return { available: true, interfaces: ifaces }
  } catch (e) {
    const err = e as { code?: string; stderr?: string }
    if (err.code === 'ENOENT') {
      return { available: false, error: 'wg не установлена', interfaces: [] }
    }
    return { available: false, error: err.stderr || `wg exit ${err.code ?? '?'}`, interfaces: [] }
  }
}

export interface WgFullTestResult {
  tools: WgTools
  configOk?: { ok: boolean; error?: string; iface?: string; peers?: number; endpoint?: string }
  status: WgStatus
}

/** Полная проверка: наличие инструментов, статус, разбор конфига */
export async function wgFullTest(config?: string): Promise<WgFullTestResult> {
  const tools = await checkWgTools()
  const status = await wgStatus()
  const result: WgFullTestResult = { tools, status }
  if (config) result.configOk = parseWgConfig(config)
  return result
}
