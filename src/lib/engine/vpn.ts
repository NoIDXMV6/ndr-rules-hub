// ─────────────────────────────────────────────────────────────────────────────
// Управление WireGuard (wg-quick) — конфиги, up/down, статус, проверка
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process'
import { promisify } from 'util'
import { accessSync, constants as fsConstants } from 'fs'
import { mkdir, writeFile, chmod, readFile } from 'fs/promises'

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

// ── Full-tunnel и доступность web UI ─────────────────────────────────────────
// wg-quick для AllowedIPs 0.0.0.0/0 добавляет policy routing («не fwmark →
// таблица 51820»), который заворачивает в туннель ВСЁ, включая ответные пакеты
// входящих соединений к web-интерфейсу (port-mapping 3080→3000): ответы уходят
// в wg0 и теряются — «web UI недоступен при поднятом туннеле». Лечение —
// стандартный приём wg-easy: правило «трафик с собственного адреса контейнера
// → основная таблица» с приоритетом ВЫШЕ правил wg-quick. Ответные пакеты (у
// них src = адрес контейнера на eth0) идут наружу через eth0, а весь исходящий
// трафик контейнера (src на момент маршрутизации ещё не выбран) — в туннель.
const EXCL_PRIO = '100'

const isFullTunnelConfig = (cfg: string): boolean =>
  /^\s*AllowedIPs\s*=\s*.*\b0\.0\.0\.0\/0\b/m.test(cfg)

interface ServiceAddrs {
  v4?: string
  v6?: string
}

/** Собственные глобальные адреса контейнера (интерфейс default-маршрута) */
async function serviceAddresses(): Promise<ServiceAddrs> {
  const out: ServiceAddrs = {}
  const def = await runCmd('ip', ['-4', 'route', 'show', 'default'], 5_000)
  const dev = def.stdout.match(/\bdev\s+(\S+)/)?.[1]
  const iface = dev && dev !== 'wg0' ? dev : 'eth0'
  const a4 = await runCmd('ip', ['-4', '-o', 'addr', 'show', 'dev', iface, 'scope', 'global'], 5_000)
  out.v4 = a4.stdout.match(/\binet\s+(\S+)/)?.[1]?.split('/')[0]
  const a6 = await runCmd('ip', ['-6', '-o', 'addr', 'show', 'dev', iface, 'scope', 'global'], 5_000)
  out.v6 = a6.stdout.match(/\binet6\s+(\S+)/)?.[1]?.split('/')[0]
  return out
}

/** Добавить исключение маршрутизации (идемпотентно) — вызывается после up */
async function excludeServiceTraffic(addrs: ServiceAddrs, notes: string[]): Promise<void> {
  const apply = async (family: '-4' | '-6', addr: string): Promise<void> => {
    // идемпотентность: повторный up не должен плодить дубли правил
    await runCmd('ip', [family, 'rule', 'del', 'from', addr, 'lookup', 'main', 'priority', EXCL_PRIO], 5_000)
    const r = await runCmd('ip', [family, 'rule', 'add', 'from', addr, 'lookup', 'main', 'priority', EXCL_PRIO], 5_000)
    if (r.ok) {
      notes.push(
        `full-tunnel: трафик с адреса ${addr} (в т.ч. ответы web UI) направлен по основной таблице ` +
        `(ip ${family} rule from ${addr} lookup main prio ${EXCL_PRIO}) — web UI останется доступным, остальной трафик пойдёт через туннель`,
      )
    } else {
      notes.push(
        `не удалось добавить исключение маршрутизации для ${addr}: ${(r.stderr || '').trim()} — ` +
        'web UI может стать недоступен, пока туннель поднят (см. README, «Full-tunnel и доступность web UI»)',
      )
    }
  }
  if (addrs.v4) await apply('-4', addrs.v4)
  if (addrs.v6) await apply('-6', addrs.v6)
}

/** Убрать наши policy-правила (prio 100 → main с конкретным from) — при down */
async function removeServiceExclusion(): Promise<void> {
  for (const family of ['-4', '-6'] as const) {
    const show = await runCmd('ip', [family, 'rule', 'show'], 5_000)
    if (!show.ok) continue
    for (const line of show.stdout.split('\n')) {
      const m = line.match(new RegExp(`^${EXCL_PRIO}:\\s+from (\\S+) lookup main(?:\\s|$)`))
      if (m && m[1] !== 'all') {
        await runCmd('ip', [family, 'rule', 'del', 'from', m[1], 'lookup', 'main', 'priority', EXCL_PRIO], 5_000)
      }
    }
  }
}

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
  // Для full-tunnel конфигов wg-quick выставляет src_valid_mark=1, но запись
  // в /proc/sys в контейнере read-only (особенно ядра 6.8+). Поэтому в образе
  // wg-quick пропатчен (upstream ac74ed6): запись только если значение ≠ 1.
  // Значит проверяем САМО ЗНАЧЕНИЕ: 1 (выставлен docker при создании) — ОК;
  // 0 + доступная запись — тоже ОК (wg-quick выставит сам); иначе — предупреждение
  try {
    const v = (await readFile('/proc/sys/net/ipv4/conf/all/src_valid_mark', 'utf8')).trim()
    t.srcValidMark = v === '1'
  } catch {
    t.srcValidMark = false
  }
  if (!t.srcValidMark) {
    try {
      accessSync('/proc/sys/net/ipv4/conf/all/src_valid_mark', fsConstants.W_OK)
      // файл доступен на записи (вне docker или privileged) — wg-quick сам выставит
      t.srcValidMark = true
    } catch {
      t.srcValidMark = false
    }
  }
  if (!t.srcValidMark) {
    t.notes.push('net.ipv4.conf.all.src_valid_mark = 0 и записать его нельзя — full-tunnel (AllowedIPs 0.0.0.0/0) не поднимется. Проверьте, что в docker-compose.yml есть «net.ipv4.conf.all.src_valid_mark=1» в sysctls и контейнер пересоздан (docker compose up -d --force-recreate); на хосте: sysctl -w net.ipv4.conf.all.src_valid_mark=1 — см. README')
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
  // адреса контейнера захватываем ДО подъёма туннеля, пока таблица main чиста;
  // для full-tunnel они понадобятся, чтобы исключить трафик web UI из туннеля
  const fullTunnel = isFullTunnelConfig(config)
  const svcAddrs = fullTunnel ? await serviceAddresses() : {}
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
    // туннель поднялся (полностью или «наполовину») — при full-tunnel сразу
    // исключаем собственный трафик контейнера из туннеля, иначе ответ на
    // этот самый запрос не дойдёт до браузера и web UI «умрёт»
    if (ifaceUp && fullTunnel) await excludeServiceTraffic(svcAddrs, notes)
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
  // wg-quick удаляет только СВОИ правила; наши исключения (prio 100 → main,
  // см. excludeServiceTraffic) убираем сами — в любом исходе down
  await removeServiceExclusion()
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
