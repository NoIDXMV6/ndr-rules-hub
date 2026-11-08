import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// ВАЖНО: fetcher вычисляет CACHE_DIR из RULES_DATA_DIR при первом импорте,
// поэтому импортируем модуль динамически уже после установки env в tmpdir
let fetcher: typeof import('@/lib/engine/fetcher')
let dataDir: string
const tmpDirs: string[] = []
const HTML_PAGE = Buffer.from('<!DOCTYPE html><html><head><title>Snort - Network Intrusion Detection</title></head><body>marketing page</body></html>')

// фейковый код — настоящий oinkcode в тестах не используется
const CODE = '0123456789abcdef0123456789abcdef01234567'

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fetcher-net-'))
  tmpDirs.push(dataDir)
  process.env.RULES_DATA_DIR = dataDir
  fetcher = await import('@/lib/engine/fetcher')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true })
})

/** Собрать настоящий tar.gz с одним правилом */
async function makeGzip(): Promise<Buffer> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fetcher-src-'))
  tmpDirs.push(work)
  await fs.writeFile(path.join(work, 'a.rules'), 'alert tcp any any -> any any (msg:"NET-TEST"; sid:31; rev:1;)\n')
  const gz = path.join(work, 'pack.tar.gz')
  await execFileP('tar', ['-czf', gz, '-C', work, 'a.rules'])
  return fs.readFile(gz)
}

describe('fetcher: tarball по сети (fetch замокан)', () => {
  const cfg = (id: string): import('@/lib/engine/fetcher').FetchSourceCfg => ({
    id,
    name: 'net-src',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://snort.org/downloads/registered/snortrules-snapshot-3200.tar.gz',
    authType: 'oinkcode',
    extraJson: JSON.stringify({ oinkcode: CODE }),
    format: 'auto',
  })

  it('HTTP 200 + HTML вместо архива → внятная ошибка, а не «Command failed: tar …»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(HTML_PAGE), { status: 200, headers: { 'content-type': 'text/html' } })))
    const res = await fetcher.fetchSource(cfg('htmlsrc'))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('не gzip-содержимое')
    expect(res.error).toContain('Snort - Network Intrusion Detection')
    expect(res.error).not.toContain('Command failed')
    expect(res.error).not.toContain(CODE) // oinkcode не раскрывается
  })

  it('валидный tar.gz по сети → правила распарсены', async () => {
    const gz = await makeGzip()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(gz), { status: 200, headers: { 'content-type': 'application/octet-stream' } })))
    const res = await fetcher.fetchSource(cfg('gzsrc'))
    expect(res.ok).toBe(true)
    expect(res.usedCache).toBeFalsy()
    expect(res.rules.map((r) => r.sid)).toEqual([31])
  })

  it('плохой ответ при живом кэше → работаем от кэша с предупреждением', async () => {
    const gz = await makeGzip()
    await fs.mkdir(fetcher.CACHE_DIR, { recursive: true })
    await fs.writeFile(path.join(fetcher.CACHE_DIR, 'src-cachesrc.tar.gz'), gz)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(HTML_PAGE), { status: 200, headers: { 'content-type': 'text/html' } })))
    const res = await fetcher.fetchSource(cfg('cachesrc'))
    expect(res.ok).toBe(true)
    expect(res.usedCache).toBe(true)
    expect(res.cacheNote).toContain('кэш')
    expect(res.rules.map((r) => r.sid)).toEqual([31])
  })

  it('мусорный gzip (обрезан) → ошибка без уродливого «Command failed»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef])), { status: 200 })))
    const res = await fetcher.fetchSource(cfg('brokensrc'))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('tar не смог его распаковать')
    expect(res.error).not.toContain('Command failed')
  })
})
