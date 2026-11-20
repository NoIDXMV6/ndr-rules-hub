import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Автоматическое поднятие WireGuard-туннеля (v1.33.0):
//  • при старте контейнера (instrumentation.ts → maybeAutoUpVpn, один раз на
//    процесс) проверяется доступность конфигурации и туннель поднимается;
//  • профиль: сначала active (последний поднятый), затем первый сохранённый;
//  • некорректный конфиг / отсутствие профиля — запись в журнал, wgUp не вызывается;
//  • туннель уже поднят (рестарт процесса без пересоздания контейнера) — не трогаем;
//  • успех/неудача — журнал и уведомление Telegram/Gotify (scope «vpn»);
//  • результат сохраняется в профиль (lastStatusJson.autoUp).
// Слой wg (wg-quick/wg) замокан — бинарники в тестовом окружении не нужны.

const ROOT = path.resolve(__dirname, '..')

// ── мок слоя WireGuard: parseWgConfig реальный, wgStatus/wgUp — моки ─────────
const wgUpMock = vi.fn()
const wgStatusMock = vi.fn()
vi.mock('@/lib/engine/vpn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/vpn')>()
  return {
    ...actual,
    wgUp: (...args: unknown[]) => wgUpMock(...args),
    wgStatus: (...args: unknown[]) => wgStatusMock(...args),
  }
})

// ── мок уведомлений: проверяем вызовы notifyEvent ────────────────────────────
const notifyMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/engine/notify', () => ({
  notifyEvent: (...args: unknown[]) => notifyMock(...args),
}))

let work: string
let db: import('@prisma/client').PrismaClient
let autoup: typeof import('@/lib/engine/vpn-autoup')

const GOOD_CFG_WG7 = `# InterfaceName: wg7
[Interface]
PrivateKey = ABCDEF0123456789abcdef0123456789abcdef012345=
Address = 10.66.66.2/32

[Peer]
PublicKey = FEDCBA9876543210FEDCBA9876543210FEDCBA987654=
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
PersistentKeepalive = 25
`

const GOOD_CFG_WG3 = `# InterfaceName: wg3
[Interface]
PrivateKey = 0123456789abcdef0123456789abcdef0123456789=
Address = 10.66.66.3/32

[Peer]
PublicKey = 9876543210fedcba9876543210fedcba9876543210=
AllowedIPs = 10.0.0.0/8
Endpoint = vpn2.example.com:51820
`

const BAD_CFG = '[Interface]\nPrivateKey = AAA=\n' // нет [Peer]

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value, updatedAt: new Date() }, update: { value, updatedAt: new Date() } })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-wg-autoup-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  autoup = await import('@/lib/engine/vpn-autoup')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

beforeEach(() => {
  wgUpMock.mockReset()
  wgStatusMock.mockReset()
  notifyMock.mockClear()
  wgStatusMock.mockResolvedValue({ available: true, interfaces: [] })
  wgUpMock.mockResolvedValue({ ok: true, output: 'wg0 up' })
})

describe('autoUpVpn: проверка конфигурации и подъём туннеля', () => {
  it('переключатель выключен (wgAutoUp=false) — подъёма нет, wgUp не вызывается', async () => {
    await setSetting('wgAutoUp', 'false')
    await db.vpnProfile.deleteMany()
    await db.vpnProfile.create({ data: { name: 'wg7', config: GOOD_CFG_WG7 } })
    const r = await autoup.autoUpVpn('start')
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe(true)
    expect(r.detail).toContain('выключен')
    expect(wgUpMock).not.toHaveBeenCalled()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('конфигурация не найдена (нет профилей) — подсказка в журнал, wgUp не вызывается', async () => {
    await setSetting('wgAutoUp', 'true')
    await db.vpnProfile.deleteMany()
    const r = await autoup.autoUpVpn('start')
    expect(r.skipped).toBe(true)
    expect(r.detail).toContain('не найдена')
    expect(wgUpMock).not.toHaveBeenCalled()
  })

  it('конфиг некорректен (нет [Peer]) — ошибка, уведомление, wgUp не вызывается', async () => {
    await setSetting('wgAutoUp', 'true')
    await db.vpnProfile.deleteMany()
    const p = await db.vpnProfile.create({ data: { name: 'wg7', config: BAD_CFG } })
    const r = await autoup.autoUpVpn('manual')
    expect(r.ok).toBe(false)
    expect(r.skipped).toBeUndefined()
    expect(r.detail).toContain('некорректна')
    expect(wgUpMock).not.toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalledWith('vpn', 'error', 'Автоподнятие туннеля: конфигурация недоступна', expect.stringContaining('некорректна'))
    // до wgUp дело не дошло — статус профиля не тронут (lastStatusJson не записан)
    const row = await db.vpnProfile.findUnique({ where: { id: p.id } })
    expect(row?.lastStatusJson).toBeNull()
  })

  it('туннель уже поднят (рестарт процесса без пересоздания контейнера) — wgUp не вызывается', async () => {
    await setSetting('wgAutoUp', 'true')
    await db.vpnProfile.deleteMany()
    await db.vpnProfile.create({ data: { name: 'wg7', config: GOOD_CFG_WG7 } })
    wgStatusMock.mockResolvedValue({ available: true, interfaces: [{ name: 'wg7', peers: [] }] })
    const r = await autoup.autoUpVpn('start')
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe(true)
    expect(r.detail).toContain('уже поднят')
    expect(wgUpMock).not.toHaveBeenCalled()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('успех: туннель поднят, уведомление «vpn»/success, профиль помечен активным', async () => {
    await setSetting('wgAutoUp', 'true')
    await db.vpnProfile.deleteMany()
    const p = await db.vpnProfile.create({ data: { name: 'wg7', config: GOOD_CFG_WG7 } })
    const r = await autoup.autoUpVpn('start')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('поднят автоматически')
    expect(r.detail).toContain('при старте контейнера')
    // интерфейс берётся из конфига (# InterfaceName: wg7), не из имени профиля
    expect(wgUpMock).toHaveBeenCalledWith('wg7', GOOD_CFG_WG7)
    expect(notifyMock).toHaveBeenCalledWith('vpn', 'success', expect.stringContaining('поднят'), expect.any(String))
    const row = await db.vpnProfile.findUnique({ where: { id: p.id } })
    expect(row?.active).toBe(true)
    const status = JSON.parse(row?.lastStatusJson ?? '{}')
    expect(status.ok).toBe(true)
    expect(status.autoUp).toBe(true)
    expect(status.action).toBe('up')
  })

  it('неудача wg-quick: ошибка в результате, уведомление error, профиль active=false', async () => {
    await setSetting('wgAutoUp', 'true')
    await db.vpnProfile.deleteMany()
    const p = await db.vpnProfile.create({ data: { name: 'wg3', config: GOOD_CFG_WG3 } })
    wgUpMock.mockResolvedValue({ ok: false, error: 'sysctl: command not found', notes: ['в контейнере нет утилиты «sysctl»'] })
    const r = await autoup.autoUpVpn('manual')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('не удалось')
    expect(r.detail).toContain('sysctl')
    expect(wgUpMock).toHaveBeenCalledWith('wg3', GOOD_CFG_WG3)
    expect(notifyMock).toHaveBeenCalledWith('vpn', 'error', 'Не удалось поднять туннель wg3 автоматически', expect.stringContaining('sysctl: command not found'))
    const row = await db.vpnProfile.findUnique({ where: { id: p.id } })
    expect(row?.active).toBe(false)
    expect(row?.lastStatusJson).toContain('sysctl')
  })
})

describe('autoUpVpn: выбор профиля для подъёма', () => {
  it('сначала active (последний поднятый), затем первый сохранённый', async () => {
    await setSetting('wgAutoUp', 'true')
    await db.vpnProfile.deleteMany()
    const older = await db.vpnProfile.create({ data: { name: 'wg7', config: GOOD_CFG_WG7, createdAt: new Date('2026-01-01T00:00:00Z') } })
    const newer = await db.vpnProfile.create({ data: { name: 'wg3', config: GOOD_CFG_WG3, createdAt: new Date('2026-02-01T00:00:00Z') } })
    // 1) нет active — берётся первый созданный (wg7)
    await autoup.autoUpVpn('manual')
    expect(wgUpMock).toHaveBeenLastCalledWith('wg7', GOOD_CFG_WG7)
    // 2) wg3 помечен active (последний поднятый) — берётся он
    await db.vpnProfile.update({ where: { id: newer.id }, data: { active: true } })
    await db.vpnProfile.update({ where: { id: older.id }, data: { active: false } })
    await autoup.autoUpVpn('manual')
    expect(wgUpMock).toHaveBeenLastCalledWith('wg3', GOOD_CFG_WG3)
  })
})

describe('maybeAutoUpVpn: один прогон на процесс (старт контейнера)', () => {
  it('двойной вызов даёт одну попытку подъёма; проверка выполняется после паузы', async () => {
    await setSetting('wgAutoUp', 'true')
    await db.vpnProfile.deleteMany()
    await db.vpnProfile.create({ data: { name: 'wg7', config: GOOD_CFG_WG7 } })
    vi.useFakeTimers()
    try {
      autoup.maybeAutoUpVpn()
      autoup.maybeAutoUpVpn() // второй вызов — гард, попытки не добавляет
      expect(wgUpMock).not.toHaveBeenCalled() // ещё рано: пауза после старта
      await vi.runAllTimersAsync()
    } finally {
      vi.useRealTimers()
    }
    // цепочка autoUpVpn (БД/wgUp) асинхронна и не привязана к таймеру — ждём её завершения
    await vi.waitFor(() => expect(wgUpMock).toHaveBeenCalledTimes(1))
    expect(wgUpMock).toHaveBeenCalledWith('wg7', GOOD_CFG_WG7)
  })
})
