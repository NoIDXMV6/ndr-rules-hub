// ─────────────────────────────────────────────────────────────────────────────
// Управление WireGuard (wg-quick) — конфиги, up/down, статус, проверка
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process'
import { promisify } from 'util'
import { accessSync, constants as fsConstants } from 'fs'
import { mkdir, writeFile, chmod } from 'fs/promises'

const execFileP = promisify(execFile)
const WG_DIR = process.env.WG_CONFIG_DIR || '/etc/wireguard'

/** Запуск команды с захвом stdout/stderr — без выброса исключений */
async function runCmd(
  cmd: string,
  args: string[],
  timeout = 30_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout })
    return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; code?: string }
    const stderr = err.stderr ?? (err.code === 'ENOENT' ? `${cmd}: команда не найдена` : err.message ?? String(e))
    return { ok: false, stdout: err.stdout ?? '', stderr }
  }
}

/** Список поднятых WireGuard-интерфейсов (wg show interfaces) */
async function wgInterfaces(): Promise<string[]> {
  const r = await runCmd('wg', ['show', 'interfaces'], 10_000)
  return r.ok ? r.stdout.trim().split(/\s+/).filter(Boolean) : []
}

/** Убрать «полуподнятый» интерфейс от прошлой неудачной попытки wg-quick */
async function cleanStaleInterface(iface: string): Promise<void> {
  if (!(await wgInterfaces()).includes(iface)) return
  // сначала штатно (wg-quick сам убирает маршруты/правила из конфига),
  // при неудаче — грубо, ip link del
  await runCmd('wg-quick', ['down', `${WG_DIR}/${iface}.conf`], 20_000)
  if ((await wgInterfaces()).includes(iface)) await runCmd('ip', ['link', 'del', iface], 10_000)
}

/** Убрать строки DNS= из конфига (fallback, если в системе нет resolvconf) */
function stripDnsLines(cfg: string): string {
  return cfg
    .split('\n')
    .filter((l) => !/^\s*DNS\s*=/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

const isResolvconfError = (s: string) => /resolvconf|resolv\.conf/i.test(s)

export interface WgTools {
  wgQuick: boolean
  wg: boolean
  tunDevice: boolean
  netAdmin: boolean
  sysctl: boolean
  srcValidMark: boolean
  notes: string[]
}

/** Проверка доступности инструментов WireGuard в системе/контейнере */
export async function checkWgTools(): Promise<WgTools> {
  const t: WgTools = { wgQuick: false, wg: false, tunDevice: false, netAdmin: false, sysctl: false, srcValidMark: false, notes: [] }
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
  t.sysctl = await which('sysctl')
  // /dev/net/tun проверяем средствами Node (F_OK), без внешнего `test`:
  // нет зависимости от PATH и подпроцессов
  try {
    accessSync('/dev/net/tun', fsConstants.F_OK)
    t.tunDevice = true
  } catch {
    t.tunDevice = false
  }
  if (!t.wg) t.notes.push('Утилита wg не установлена (в контейнере: apt install wireguard-tools)')
  if (!t.sysctl) t.notes.push('Нет sysctl (пакет procps) — full-tunnel конфиги (AllowedIPs 0.0.0.0/0) не поднимутся: wg-quick упадёт с «sysctl: command not found»')
  // /proc/sys/net/ipv4/conf/all/src_valid_mark должна быть доступна на запись:
  // wg-quick пишет её для full-tunnel конфигов, а Docker монтирует /proc/sys ro —
  // лечится строкой в sysctls docker-compose.yml. Linux access(W_OK) вернёт
  // ошибку и на ro-маунте (EROFS), и при нехватке прав (EACCES) — обе ситуации ловим
  try {
    accessSync('/proc/sys/net/ipv4/conf/all/src_valid_mark', fsConstants.W_OK)
    t.srcValidMark = true
  } catch {
    t.srcValidMark = false
  }
  if (!t.srcValidMark) {
    t.notes.push('Нет прав на запись net.ipv4.conf.all.src_valid_mark — full-tunnel (AllowedIPs 0.0.0.0/0) не поднимется. Добавьте «net.ipv4.conf.all.src_valid_mark=1» в sysctls docker-compose.yml и пересоздайте контейнер (docker compose up -d --force-recreate)')
  }
  if (!t.tunDevice) t.notes.push('Нет /dev/net/tun — WireGuard-туннели недоступны (на загрузку правил не влияет). Нужно: device /dev/net/tun + cap NET_ADMIN — см. README, раздел «Нет /dev/net/tun»')
  // проверка прав: ip link add требует NET_ADMIN; пробный интерфейс сразу удаляем
  const delProbe = () => execFileP('ip', ['link', 'del', 'wg-hub-probe']).catch(() => undefined)
  try {
    await execFileP('ip', ['link', 'add', 'wg-hub-probe', 'type', 'wireguard'], { timeout: 10_000 })
    t.netAdmin = true
    await delProbe()
  } catch (e) {
    const msg = ((e as { stderr?: string; code?: string }).stderr ?? String(e))
    if (msg.includes('Operation not permitted') || msg.includes('EPERM')) {
      t.netAdmin = false
      t.notes.push('Нет прав NET_ADMIN — проверьте cap_add: [NET_ADMIN] в docker-compose.yml и пересоздайте контейнер (docker compose up -d --force-recreate)')
    } else if (msg.includes('Operation not supported') || msg.includes('No such device')) {
      // права ни при чём: на хосте Docker не загружен модуль ядра wireguard
      t.netAdmin = true
      t.notes.push('Модуль ядра wireguard не загружен на хосте Docker (sudo modprobe wireguard) — без него wg-quick up не поднимет туннель')
    } else if (msg.includes('File exists')) {
      // пробник остался от предыдущей проверки — права есть, прибираем
      t.netAdmin = true
      await delProbe()
    } else {
      t.netAdmin = true
    }
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
export async function wgUp(name: string, config: string): Promise<{ ok: boolean; error?: string; output?: string; notes?: string[] }> {
  const parsed = parseWgConfig(config)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const iface = parsed.iface ?? 'wg0'
  const confPath = `${WG_DIR}/${iface}.conf`
  const notes: string[] = []
  try {
    // ВАЖНО: раньше тут был execFile('tee', [path], { input: config }) — но у
    // execFile НЕТ опции input (она есть только у spawnSync/execSync), опция
    // молча игнорировалась и в файл писался ПУСТОЙ конфиг, из-за чего wg-quick
    // не мог поднять туннель. Пишем файл средствами Node.
    await mkdir(WG_DIR, { recursive: true })
    await writeFile(confPath, config, { mode: 0o600 })
    await chmod(confPath, 0o600)
    // прошлая неудачная попытка могла оставить интерфейс — иначе wg-quick
    // ответит «wg0 already exists as a WireGuard interface»
    await cleanStaleInterface(iface)

    let res = await runCmd('wg-quick', ['up', confPath])
    if (!res.ok && isResolvconfError(res.stderr + res.stdout)) {
      // чаще всего в контейнере нет resolvconf, а в конфиге есть строка DNS=:
      // поднимаем без неё — DNS контейнером управляет Docker, и с AllowedIPs
      // 0.0.0.0/0 запросы к внешним DNS всё равно пойдут через туннель
      notes.push('строка DNS= проигнорирована: resolvconf недоступен (в образ добавьте openresolv — см. README)')
      await writeFile(confPath, stripDnsLines(config), { mode: 0o600 })
      await chmod(confPath, 0o600)
      await cleanStaleInterface(iface)
      res = await runCmd('wg-quick', ['up', confPath])
    }

    const trace = (res.stderr || res.stdout).trim()
    const ifaceUp = (await wgInterfaces()).includes(iface)
    if (ifaceUp && !res.ok) {
      notes.push('wg-quick завершился с ошибкой, но интерфейс создан — проверьте handshake ниже')
      return { ok: true, notes, output: trace || undefined }
    }
    if (!res.ok) {
      // «X: command not found» — в контейнере нет утилиты, на которую
      // ссылается конфиг/штатные шаги wg-quick: называем её и пакет
      const missing = (res.stderr + res.stdout).match(/(\S+): command not found/)?.[1]
      if (missing) {
        const pkg = missing === 'sysctl' ? 'procps' : missing === 'resolvconf' ? 'openresolv' : '—'
        notes.push(`в контейнере нет утилиты «${missing}» (пакет ${pkg}) — установите её в образ и пересоберите: docker compose up -d --build`)
      }
      // «permission denied on key» — /proc/sys в контейнере read-only:
      // нужен sysctl в docker-compose.yml, бинарник тут не поможет
      if (/permission denied on key/i.test(res.stderr + res.stdout)) {
        notes.push('Docker не даёт писать sysctl изнутри контейнера — добавьте «net.ipv4.conf.all.src_valid_mark=1» в sysctls docker-compose.yml и пересоздайте контейнер (docker compose up -d --force-recreate)')
      }
      return { ok: false, error: trace || 'wg-quick up завершился с ошибкой (подробности в логах контейнера)', notes }
    }
    return { ok: true, notes: notes.length ? notes : undefined, output: trace || undefined }
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    return { ok: false, error: err.stderr || err.message || 'wg-quick up failed' }
  }
}

export async function wgDown(name: string): Promise<{ ok: boolean; error?: string; notes?: string[] }> {
  const iface = name.replace(/\.conf$/, '')
  const res = await runCmd('wg-quick', ['down', `${WG_DIR}/${iface}.conf`])
  if (res.ok) return { ok: true }
  // интерфейса могло уже не быть — повторный down не ошибка
  if (!(await wgInterfaces()).includes(iface)) {
    return { ok: true, notes: ['интерфейс уже был опущен'] }
  }
  const del = await runCmd('ip', ['link', 'del', iface], 10_000)
  if (del.ok) {
    return { ok: true, notes: ['wg-quick down завершился ошибкой, интерфейс удалён напрямую (ip link del)'] }
  }
  return { ok: false, error: (res.stderr || res.stdout).trim() || 'wg-quick down failed' }
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
