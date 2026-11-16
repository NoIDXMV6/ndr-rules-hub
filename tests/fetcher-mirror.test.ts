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

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fetcher-mirror-'))
  tmpDirs.push(dataDir)
  process.env.RULES_DATA_DIR = dataDir
  fetcher = await import('@/lib/engine/fetcher')
})

afterAll(async () => {
  vi.unstubAllGlobals()
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true })
})

/** tar.gz с одним .rules-файлом; sub — раскладка с подкаталогом (как в GitHub-архиве pawpatrules) */
async function makeGzip(rules: string, sub = ''): Promise<Buffer> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'fetcher-mirror-src-'))
  tmpDirs.push(work)
  const dir = sub ? path.join(work, sub) : work
  if (sub) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'pack.rules'), rules)
  const gz = path.join(work, 'pack.tar.gz')
  if (sub) await execFileP('tar', ['-czf', gz, '-C', work, sub])
  else await execFileP('tar', ['-czf', gz, '-C', work, 'pack.rules'])
  return fs.readFile(gz)
}

/** ТайпError «fetch failed» с cause.code, как отдаёт undici при недоступном сервере */
function netFail(): Error {
  const e = new TypeError('fetch failed')
  ;(e as Error & { cause?: unknown }).cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
  return e
}

const RULE = (sid: number, msg: string) => `alert tcp any any -> any any (msg:"${msg}"; sid:${sid}; rev:1;)\n`

describe('fetcher: зеркала (extra.mirrorUrls)', () => {
  it('основной URL лежит (connect timeout) → зеркало отдаёт архив, правила из подкаталога распарсены', async () => {
    const gz = await makeGzip(RULE(41, 'MIRROR-OK'), 'repo-main')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      if (calls.length === 1) throw netFail()
      return new Response(new Uint8Array(gz), { status: 200 })
    }))
    const res = await fetcher.fetchSource({
      id: 'mirror-ok',
      name: 'mirror-ok',
      category: 'ruleset',
      kind: 'tarball',
      url: 'https://primary.example/rules.tar.gz',
      authType: 'none',
      extraJson: JSON.stringify({ mirrorUrls: ['https://mirror.example/rules.tar.gz'] }),
      format: 'auto',
    })
    expect(res.ok).toBe(true)
    expect(res.usedCache).toBeFalsy()
    expect(res.rules.map((r) => r.sid)).toEqual([41])
    expect(calls).toEqual(['https://primary.example/rules.tar.gz', 'https://mirror.example/rules.tar.gz'])
  })

  it('HTTP 500 основного → зеркало, в зеркальном URL подставлен %%AUTHKEY%%', async () => {
    const gz = await makeGzip(RULE(42, 'MIRROR-KEY'))
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      if (calls.length === 1) return new Response(new Uint8Array(Buffer.from('server error')), { status: 500 })
      return new Response(new Uint8Array(gz), { status: 200 })
    }))
    const res = await fetcher.fetchSource({
      id: 'mirror-key',
      name: 'mirror-key',
      category: 'ruleset',
      kind: 'tarball',
      url: 'https://primary.example/v2/files/exports/%%AUTHKEY%%/rules.tar.gz',
      authType: 'authkey',
      extraJson: JSON.stringify({ authKey: 'TESTKEY123', mirrorUrls: ['https://mirror.example/v2/files/exports/%%AUTHKEY%%/rules.tar.gz'] }),
      format: 'auto',
    })
    expect(res.ok).toBe(true)
    expect(res.rules.map((r) => r.sid)).toEqual([42])
    expect(calls).toEqual([
      'https://primary.example/v2/files/exports/TESTKEY123/rules.tar.gz',
      'https://mirror.example/v2/files/exports/TESTKEY123/rules.tar.gz',
    ])
  })

  it('основной и зеркало недоступны → ошибка перечисляет обе попытки', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw netFail()
    }))
    const res = await fetcher.fetchSource({
      id: 'mirror-both-fail',
      name: 'mirror-both-fail',
      category: 'ruleset',
      kind: 'tarball',
      url: 'https://primary.example/rules.tar.gz',
      authType: 'none',
      extraJson: JSON.stringify({ mirrorUrls: ['https://mirror.example/rules.tar.gz'] }),
      format: 'auto',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('зеркало недоступны')
    expect(res.error).toContain('primary.example')
    expect(res.error).toContain('mirror.example')
    expect(res.error).toContain('UND_ERR_CONNECT_TIMEOUT')
  })

  it('основной и зеркало недоступны, есть кэш → работаем от кэша с предупреждением', async () => {
    const gz = await makeGzip(RULE(43, 'CACHE-MIRROR'))
    await fs.mkdir(fetcher.CACHE_DIR, { recursive: true })
    await fs.writeFile(path.join(fetcher.CACHE_DIR, 'src-mirror-cache.tar.gz'), gz)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw netFail()
    }))
    const res = await fetcher.fetchSource({
      id: 'mirror-cache',
      name: 'mirror-cache',
      category: 'ruleset',
      kind: 'tarball',
      url: 'https://primary.example/rules.tar.gz',
      authType: 'none',
      extraJson: JSON.stringify({ mirrorUrls: ['https://mirror.example/rules.tar.gz'] }),
      format: 'auto',
    })
    expect(res.ok).toBe(true)
    expect(res.usedCache).toBe(true)
    expect(res.cacheNote).toContain('кэш')
    expect(res.rules.map((r) => r.sid)).toEqual([43])
  })

  it('plain ruleset (kind url) тоже поддерживает зеркала', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      if (calls.length === 1) return new Response(new Uint8Array(Buffer.from('nope')), { status: 404 })
      return new Response(new Uint8Array(Buffer.from(RULE(44, 'U-MIRROR'))), { status: 200 })
    }))
    const res = await fetcher.fetchSource({
      id: 'mirror-url',
      name: 'mirror-url',
      category: 'ruleset',
      kind: 'url',
      url: 'https://primary.example/rules.rules',
      authType: 'none',
      extraJson: JSON.stringify({ mirrorUrls: ['https://mirror.example/rules.rules'] }),
      format: 'auto',
    })
    expect(res.ok).toBe(true)
    expect(res.rules.map((r) => r.sid)).toEqual([44])
    expect(calls).toHaveLength(2)
  })

  it('повторная загрузка с другим архивом не смешивает старые .rules (destDir чистится)', async () => {
    const gz1 = await makeGzip(RULE(51, 'V1'))
    const gz2 = await makeGzip(RULE(52, 'V2'))
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      return new Response(new Uint8Array(n === 1 ? gz1 : gz2), { status: 200 })
    }))
    const cfg = {
      id: 'reuse-dir',
      name: 'reuse-dir',
      category: 'ruleset',
      kind: 'tarball' as const,
      url: 'https://primary.example/rules.tar.gz',
      authType: 'none',
      extraJson: null as string | null,
      format: 'auto',
    }
    const r1 = await fetcher.fetchSource(cfg)
    expect(r1.rules.map((r) => r.sid)).toEqual([51])
    const r2 = await fetcher.fetchSource(cfg)
    expect(r2.rules.map((r) => r.sid)).toEqual([52])
  })
})
