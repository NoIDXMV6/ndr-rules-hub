import { describe, it, expect } from 'vitest'
import { parseWgConfig } from '@/lib/engine/vpn'
import { fetchSource, FetchSourceCfg } from '@/lib/engine/fetcher'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

describe('vpn: parseWgConfig', () => {
  const valid = `[Interface]
PrivateKey = ABCDEF123=
Address = 10.66.66.2/32

[Peer]
PublicKey = FEDCBA654=
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
`

  it('принимает корректный конфиг', () => {
    const r = parseWgConfig(valid)
    expect(r.ok).toBe(true)
    expect(r.iface).toBe('wg0')
    expect(r.peers).toBe(1)
    expect(r.endpoint).toBe('vpn.example.com:51820')
  })

  it('понимает комментарий с именем интерфейса', () => {
    const r = parseWgConfig(`# InterfaceName: wg-office\n${valid}`)
    expect(r.ok).toBe(true)
    expect(r.iface).toBe('wg-office')
  })

  it('отклоняет конфиг без [Interface]', () => {
    expect(parseWgConfig('[Peer]\nPublicKey = x=').ok).toBe(false)
  })

  it('отклоняет конфиг без PrivateKey', () => {
    expect(parseWgConfig('[Interface]\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = x=\n').ok).toBe(false)
  })

  it('отклоняет конфиг без [Peer]', () => {
    expect(parseWgConfig('[Interface]\nPrivateKey = x=\n').ok).toBe(false)
  })
})

describe('fetcher: локальные файлы и архивы', () => {
  let tmpDir: string
  const created: string[] = []

  const mk = async (rel: string, content: string) => {
    const p = path.join(tmpDir, rel)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, content)
    created.push(p)
    return p
  }

  it('читает каталог с .rules файлами', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-hub-'))
    await mk('a.rules', 'alert tcp any any -> any any (msg:"A"; sid:11; rev:1;)\n')
    await mk('sub/b.rules', 'alert udp any any -> any any (msg:"B"; sid:12; rev:1;)\n')
    const cfg: FetchSourceCfg = { id: 't1', name: 'local-dir', category: 'ruleset', kind: 'local', url: tmpDir, authType: 'none', format: 'auto' }
    const res = await fetchSource(cfg)
    expect(res.ok).toBe(true)
    expect(res.rules.length).toBe(2)
    expect(res.rules.map((r) => r.sid).sort()).toEqual([11, 12])
  })

  it('читает tar.gz архив с .rules внутри', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-hub-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-src-'))
    await fs.writeFile(path.join(workDir, 'one.rules'), 'alert tcp any any -> any any (msg:"ONE"; sid:21; rev:1;)\nalert tcp any any -> any any (msg:"TWO"; sid:22; rev:2;)\n')
    await fs.writeFile(path.join(workDir, 'README.txt'), 'not a rules file')
    await new Promise<void>((resolve, reject) => {
      const { execFile } = require('child_process')
      execFile('tar', ['-czf', path.join(tmpDir, 'pack.tar.gz'), '-C', workDir, '.'], (e: Error | null) => (e ? reject(e) : resolve()))
    })
    const cfg: FetchSourceCfg = { id: 't2', name: 'local-tar', category: 'ruleset', kind: 'local', url: path.join(tmpDir, 'pack.tar.gz'), authType: 'none', format: 'auto' }
    const res = await fetchSource(cfg)
    expect(res.ok).toBe(true)
    expect(res.rules.length).toBe(2)
    expect(res.rules.map((r) => r.sid).sort()).toEqual([21, 22])
  })

  it('ошибка для несуществующего пути', async () => {
    const cfg: FetchSourceCfg = { id: 't3', name: 'missing', category: 'ruleset', kind: 'local', url: '/nonexistent/path.rules', authType: 'none', format: 'auto' }
    const res = await fetchSource(cfg)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('не найден')
  })
})

describe('fetcher: конвертеры списков по сети', () => {
  it('ip-list по URL конвертируется (надёжный публичный список)', async () => {
    const cfg: FetchSourceCfg = {
      id: 'net-ip',
      name: 'spamhaus-drop',
      category: 'ip-list',
      kind: 'url',
      url: 'https://www.spamhaus.org/drop/drop.txt',
      authType: 'none',
      extraJson: JSON.stringify({ sidStart: 1900100, msgPrefix: 'TEST-DROP', maxRules: 20 }),
      format: 'auto',
    }
    const res = await fetchSource(cfg)
    expect(res.ok).toBe(true)
    expect(res.rules.length).toBeGreaterThan(0)
    expect(res.rules.length).toBeLessThanOrEqual(20)
    expect(res.rules[0].raw).toContain('sid:1900100;')
  }, 60_000)
})
