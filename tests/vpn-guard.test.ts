import { describe, it, expect, beforeAll, vi } from 'vitest'

// Защита WireGuard от повторного «up»: поднятый туннель нельзя поднять снова
// (раньше это сносило и поднимало его заново — web UI зависал). Мокаем
// child_process, чтобы не трогать реальные wg/wg-quick контейнера.

type ExecHandler = (cmd: string, args: string[]) => { stdout?: string; stderr?: string; fail?: boolean }

const calls: Array<{ cmd: string; args: string[] }> = []
let handler: ExecHandler = () => ({ stdout: '' })

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: (err: unknown, res?: { stdout: string; stderr: string }) => void) => {
    calls.push({ cmd, args })
    const r = handler(cmd, args)
    setImmediate(() => {
      if (r.fail) cb(new Error(r.stderr || 'mock fail'), { stdout: r.stdout ?? '', stderr: r.stderr ?? '' })
      else cb(null, { stdout: r.stdout ?? '', stderr: r.stderr ?? '' })
    })
  },
}))

const VALID_CONFIG = `[Interface]
PrivateKey = ABCDEF123=
Address = 10.66.66.2/32

[Peer]
PublicKey = FEDCBA654=
AllowedIPs = 10.0.0.0/24
Endpoint = vpn.example.com:51820
`

let vpn: typeof import('@/lib/engine/vpn')

beforeAll(async () => {
  process.env.WG_CONFIG_DIR = '/tmp/wg-test-nonexistent'
  vpn = await import('@/lib/engine/vpn')
})

function reset(h: ExecHandler): void {
  calls.length = 0
  handler = h
}

describe('wgUp: защита от повторного включения', () => {
  it('поднятый туннель: повторный up отклоняется (alreadyUp), wg-quick НЕ вызывается', async () => {
    reset((_cmd, args) => {
      // wg show interfaces → интерфейс уже есть
      if (args[0] === 'show' && args[1] === 'interfaces') return { stdout: 'wg0\n' }
      return { stdout: '' }
    })
    const r = await vpn.wgUp('wg0', VALID_CONFIG)
    expect(r.ok).toBe(false)
    expect(r.alreadyUp).toBe(true)
    expect(r.error).toContain('уже поднят')
    // ни wg-quick down, ни up, ни записи файла не должно было произойти
    const quick = calls.filter((c) => c.cmd === 'wg-quick')
    expect(quick).toEqual([])
  })

  it('опущенный туннель: up выполняется штатно (wg-quick up)', async () => {
    let up = false
    reset((_cmd, args) => {
      if (args[0] === 'show' && args[1] === 'interfaces') return { stdout: up ? 'wg0\n' : '' }
      if (args[0] === 'up') {
        up = true
        return { stdout: '# config\n' }
      }
      return { stdout: '' }
    })
    const r = await vpn.wgUp('wg0', VALID_CONFIG)
    expect(r.ok).toBe(true)
    expect(r.alreadyUp).toBeUndefined()
    expect(calls.some((c) => c.cmd === 'wg-quick' && c.args[0] === 'up')).toBe(true)
    expect(calls.some((c) => c.cmd === 'wg-quick' && c.args[0] === 'down')).toBe(false)
  })

  it('wgDown: интерфейс уже опущен — не ошибка («интерфейс уже был опущен»)', async () => {
    reset((_cmd, args) => {
      // wg-quick down падает (конфиг/интерфейса нет), wg show interfaces — пусто
      if (args[0] === 'down') return { fail: true, stderr: 'wg-quick: wg0 is not a WireGuard interface' }
      if (args[0] === 'show' && args[1] === 'interfaces') return { stdout: '' }
      if (args[0] === 'rule') return { stdout: '' }
      return { stdout: '' }
    })
    const r = await vpn.wgDown('wg0')
    expect(r.ok).toBe(true)
    expect(r.notes?.[0]).toContain('уже был опущен')
  })
})
