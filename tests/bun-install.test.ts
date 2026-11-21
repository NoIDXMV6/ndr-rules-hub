import { describe, it, expect, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import http from 'http'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// scripts/bun-install.sh — этап deps docker build. Инциденты:
//   v1.27.0 — bun install на npmjs.org висел 23196с без вывода (сеть хоста);
//   v1.36.1 — зеркало npm-mirror.gitverse.ru деградировало (~16с на манифест
//             /next ~31 МБ): установка не укладывалась в предохранитель,
//             единственный заданный реестр не оставлял сборке шансов.
// Скрипт обязан: предпроверять зеркала лёгким запросом, исключать не ответившие,
// ставить деградировавшие (медленнее порога) в конец очереди, сортировать по
// скорости, падать с диагностикой только если не сработало ни одно зеркало.

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'bun-install.sh')

type Stub = { url: string; server: http.Server; close: () => Promise<void> }

/** HTTP-заглушка «зеркала»: delayMs — пауза перед ответом, status — код */
function stubRegistry(delayMs: number, status: number): Promise<Stub> {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end('{"stub":true}')
      }, delayMs)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

const stubs: Stub[] = []
afterAll(async () => {
  for (const s of stubs) await s.close()
})

function runScript(env: Record<string, string>) {
  return execFileP('sh', [SCRIPT], {
    cwd: path.dirname(SCRIPT),
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  })
}

const ORDER_RE = /\[deps\]\s+(\d)\.\s+(\S+)/g

/** порядок попыток из вывода скрипта: [['1','url'], …] */
function parseOrder(stdout: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const m of stdout.matchAll(ORDER_RE)) out.push([m[1], m[2]])
  return out
}

describe('scripts/bun-install.sh — предпроверка и порядок зеркал (hermetic)', () => {
  it('исключает не ответившее, деградировавшее ставит в конец, быстрое — первым', async () => {
    const dead = await stubRegistry(0, 500) // HTTP 500 → «нет ответа»
    const slow = await stubRegistry(3500, 200) // 3500мс > порога 3000мс
    const fast = await stubRegistry(10, 200)
    stubs.push(dead, slow, fast)
    // в списке заведомо НЕудачный порядок: битое, медленное, быстрое
    const list = `${dead.url} ${slow.url} ${fast.url}`
    const { stdout } = await runScript({
      BUN_REGISTRIES: list,
      BUN_INSTALL_TIMEOUT: '60',
      DRY_RUN: '1',
    })
    // битое исключено с объяснением
    expect(stdout).toContain(`${dead.url} — нет ответа`)
    expect(stdout).toContain('— исключено')
    // порядок: быстрое первым, деградировавшее последним, битого нет
    const order = parseOrder(stdout)
    expect(order).toHaveLength(2)
    expect(order[0][1]).toBe(fast.url)
    expect(order[1][1]).toBe(slow.url)
    expect(stdout).toContain('порядок попыток (2)')
    expect(stdout).toContain('DRY_RUN: установка не выполнялась')
  }, 30_000)

  it('NPM_REGISTRY предпроверяется первым (приоритет явной настройки)', async () => {
    const slow = await stubRegistry(3500, 200)
    const fast = await stubRegistry(10, 200)
    stubs.push(slow, fast)
    const { stdout } = await runScript({
      BUN_REGISTRIES: `${fast.url} ${slow.url}`,
      NPM_REGISTRY: slow.url,
      DRY_RUN: '1',
    })
    const iSlow = stdout.indexOf(`[deps]   ${slow.url} —`)
    const iFast = stdout.indexOf(`[deps]   ${fast.url} —`)
    expect(iSlow).toBeGreaterThanOrEqual(0)
    expect(iFast).toBeGreaterThan(iSlow)
  }, 30_000)

  it('все зеркала не ответили → FAIL с диагностикой, код 1', async () => {
    const dead1 = await stubRegistry(0, 500)
    const dead2 = await stubRegistry(0, 503)
    stubs.push(dead1, dead2)
    await expect(
      runScript({ BUN_REGISTRIES: `${dead1.url} ${dead2.url}` })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('ни одно из зеркал не отвечает'),
    })
  }, 30_000)
})

// Реальная установка требует сети до registry.npmjs.org — только по явному
// RUN_NET_TESTS=1 (как в CI-дискреции прочих сетевых проверок).
const RUN_NET = process.env.RUN_NET_TESTS === '1'

describe.skipIf(!RUN_NET)('scripts/bun-install.sh — реальный фолбэк (сеть)', () => {
  it('битое NPM_REGISTRY → установка через дефолтное зеркало', async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'bun-install-'))
    try {
      await fs.writeFile(
        path.join(work, 'package.json'),
        JSON.stringify({ name: 'bun-install-fallback-test', version: '1.0.0', dependencies: { ms: '2.1.3' } })
      )
      const execInWork = (env: Record<string, string>) =>
        execFileP('sh', [SCRIPT], { cwd: work, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 })
      // 1) создаём bun.lock обычной установкой
      await execFileP('bun', ['install'], { cwd: work })
      // 2) скрипт: основное зеркало битое → предпроверка исключает → успех
      //    через дефолтных кандидатов
      const { stdout } = await execInWork({
        NPM_REGISTRY: 'https://bun-install.invalid',
        BUN_INSTALL_TIMEOUT: '300',
      })
      expect(stdout).toContain('https://bun-install.invalid — нет ответа')
      expect(stdout).toContain('OK: зависимости установлены с ')
      const lock = await fs.readFile(path.join(work, 'bun.lock'), 'utf8')
      expect(lock).toContain('"ms@2.1.3"')
    } finally {
      await fs.rm(work, { recursive: true, force: true })
    }
  }, 180_000)
})
