import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { utimes } from 'fs/promises'

const execFileP = promisify(execFile)

// Системный мониторинг (/proc, df, docker) и автоочистка диска:
//  - monitor: память/CPU/диски/сеть читаются из /proc хоста; docker без сокета
//    честно сообщает о монтировании;
//  - cleanup: кандидаты OpenSearch (префиксы/возраст/лимит), dry-run ничего не
//    удаляет, реальный прогон удаляет только старое и разрешённое, активные
//    логи и новые файлы не трогаются, большие файлы — отчёт/удаление.

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let monitor: typeof import('@/lib/engine/monitor')
let cleanup: typeof import('@/lib/engine/cleanup')

/** Файл с указанным возрастом (дней) */
async function mkOld(dir: string, name: string, sizeKb: number, ageDays: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const p = path.join(dir, name)
  await fs.writeFile(p, Buffer.alloc(sizeKb * 1024, 'x'))
  const past = new Date(Date.now() - ageDays * 24 * 3600 * 1000)
  await utimes(p, past, past)
  return p
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value, updatedAt: new Date() }, update: { value, updatedAt: new Date() } })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-system-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  monitor = await import('@/lib/engine/monitor')
  cleanup = await import('@/lib/engine/cleanup')
  // ES-шаг по умолчанию выключен: большинство тестов не должны ждать сетевых
  // проб OpenSearch; в тесте честного отказа включается явно
  await setSetting('cleanupOsEnabled', 'false')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('monitor: чтение /proc и df', () => {
  it('память: итог/свободно/проценты согласованы', async () => {
    const m = await monitor.readMem()
    expect(m.totalMb).toBeGreaterThan(0)
    expect(m.usedMb).toBeGreaterThanOrEqual(0)
    expect(m.usedMb).toBeLessThanOrEqual(m.totalMb)
    expect(m.usedPct).toBeGreaterThanOrEqual(0)
    expect(m.usedPct).toBeLessThanOrEqual(100)
  })

  it('CPU: проценты в диапазоне 0..100, ядра >= 1, load читается', async () => {
    const c = await monitor.readCpu()
    expect(c.usagePct).toBeGreaterThanOrEqual(0)
    expect(c.usagePct).toBeLessThanOrEqual(100)
    expect(c.cores).toBeGreaterThanOrEqual(1)
    expect(c.load1).toBeGreaterThanOrEqual(0)
  })

  it('диски: df возвращает хотя бы один том с монтированием', async () => {
    const disks = await monitor.readDisks()
    expect(disks.length).toBeGreaterThan(0)
    for (const d of disks) {
      expect(d.mount.startsWith('/')).toBe(true)
      expect(d.totalMb).toBeGreaterThan(0)
      expect(d.usedPct).toBeGreaterThanOrEqual(0)
    }
  })

  it('сеть: интерфейсы с счётчиками rx/tx', async () => {
    const net = await monitor.readNet()
    expect(net.length).toBeGreaterThan(0)
    for (const n of net) expect(n.iface).not.toBe('lo')
  })

  it('docker: без смонтированного сокета — available:false и подсказка', async () => {
    const c = await monitor.readContainers()
    expect(c.available).toBe(false)
    expect(c.list).toEqual([])
    expect(c.hint).toContain('docker.sock')
  })

  it('readSystemStats собирает сводку с аптаймом и wg', async () => {
    const s = await monitor.readSystemStats()
    expect(s.uptimeSec).toBeGreaterThan(0)
    expect(s.wg).toBeDefined()
    expect(s.ts).toBeTruthy()
  })
})

describe('cleanup: кандидаты OpenSearch', () => {
  const mk = (index: string, createdMs: number, sizeBytes: number) => ({ index, createdMs, sizeBytes })
  const NOW = Date.now()
  const DAY = 24 * 3600 * 1000

  it('фильтр: префиксы, возраст, лимит; системные индексы исключены', () => {
    const indices = [
      mk('.kibana_1', NOW - 60 * DAY, 1024), // системный — никогда
      mk('logstash-2025.01.01', NOW - 30 * DAY, 5e9), // старый, префикс ок
      mk('ndr-logstash-2025.02.01', NOW - 20 * DAY, 1e9), // старый, префикс ок
      mk('logstash-2025.03.01', NOW - 1 * DAY, 1e9), // свежий — не трогаем
      mk('suricata-old', NOW - 100 * DAY, 2e9), // старый, префикс ок
      mk('security-other', NOW - 100 * DAY, 9e9), // префикс НЕ разрешён
      mk('logstash-nodate', 0, 3e9), // без даты создания — не трогаем
    ]
    const picked = cleanup.pickOsCandidates(indices, ['logstash-', 'ndr-', 'suricata-'], 14, 2)
    // самые старые первыми (suricata-old — 100 дней), лимит 2
    expect(picked.map((x) => x.index)).toEqual(['suricata-old', 'logstash-2025.01.01'])
    // без лимита забирает и ndr-индекс
    const all = cleanup.pickOsCandidates(indices, ['logstash-', 'ndr-', 'suricata-'], 14, 50)
    expect(all.map((x) => x.index)).toEqual(['suricata-old', 'logstash-2025.01.01', 'ndr-logstash-2025.02.01'])
  })
})

describe('cleanup: кэш хаба и каталоги логов', () => {
  it('dry-run только перечисляет; реальный прогон удаляет старое, сохраняя новое и активные файлы', async () => {
    const cacheDir = path.join(work, 'cache')
    const oldCache = await mkOld(cacheDir, 'snort-rules.tar.gz', 2048, 30)
    const newCache = await mkOld(cacheDir, 'fresh-rules.tar.gz', 512, 0)
    const logsDir = path.join(work, 'host-logs')
    const oldLog = await mkOld(logsDir, 'eve.2025-01-01.json.gz', 1024, 30)
    const active = await mkOld(logsDir, 'eve.json', 4096, 30) // «активный», но помечен старым — не трогается
    const newLog = await mkOld(logsDir, 'eve.2025-03-01.json.gz', 256, 0)
    // каталоги логов заданы явно (пусто — шаг пропускается с «no-dirs»)
    await setSetting('cleanupLogDirs', logsDir)

    // dry-run: ничего не удалено
    const dry = await cleanup.runCleanup({ dryRun: true })
    expect(dry.dryRun).toBe(true)
    const dryCache = dry.actions.find((a) => a.cleaner === 'cache')!
    expect(dryCache.freedBytes).toBeGreaterThanOrEqual(2048 * 1024)
    expect(dryCache.items?.join('\n')).toContain('snort-rules.tar.gz')
    const dryLogs = dry.actions.find((a) => a.cleaner === 'logs')!
    expect(dryLogs.freedBytes).toBeGreaterThanOrEqual(1024 * 1024)
    for (const f of [oldCache, newCache, oldLog, active, newLog]) {
      await expect(fs.access(f)).resolves.toBeUndefined()
    }

    // реальный прогон: старые удалены, новое и активные живы
    const real = await cleanup.runCleanup({ dryRun: false, triggeredBy: 'manual' })
    const realCache = real.actions.find((a) => a.cleaner === 'cache')!
    expect(realCache.freedBytes).toBeGreaterThan(0)
    const realLogs = real.actions.find((a) => a.cleaner === 'logs')!
    expect(realLogs.freedBytes).toBeGreaterThan(0)
    await expect(fs.access(oldCache)).rejects.toThrow()
    await expect(fs.access(oldLog)).rejects.toThrow()
    await expect(fs.access(newCache)).resolves.toBeUndefined()
    await expect(fs.access(newLog)).resolves.toBeUndefined()
    await expect(fs.access(active)).resolves.toBeUndefined()
    // отчёт прогона сохранён в настройках
    const row = await db.setting.findUnique({ where: { key: 'cleanupLastRunJson' } })
    expect(row).toBeTruthy()
    expect(JSON.parse(row!.value).freedBytes).toBeGreaterThan(0)
  })

  it('OpenSearch недоступен — шаг честно падает с перечнем попыток, остальные шаги работают', async () => {
    await setSetting('cleanupOsEnabled', 'true')
    await setSetting('cleanupOsUrl', 'http://127.0.0.1:1')
    try {
      const report = await cleanup.runCleanup({ dryRun: true })
      const os = report.actions.find((a) => a.cleaner === 'opensearch')!
      expect(os.ok).toBe(false)
      expect(os.detail).toContain('OpenSearch не найден')
      expect(os.detail).toContain('127.0.0.1:1')
    } finally {
      await setSetting('cleanupOsEnabled', 'false')
    }
  }, 60_000)

  it('большой файл: по умолчанию отчёт, с включённым удалением — удаляется', async () => {
    const filesDir = path.join(work, 'dumps')
    const big = await mkOld(filesDir, 'dump-old.bin', 2048, 30) // 2 МБ
    await setSetting('cleanupFilesEnabled', 'true')
    await setSetting('cleanupFileDirs', filesDir)
    await setSetting('cleanupLargeFileMb', '1')
    await setSetting('cleanupFileKeepDays', '7')
    await setSetting('cleanupFilesDelete', 'false')

    const rep1 = await cleanup.runCleanup({ dryRun: true })
    const f1 = rep1.actions.find((a) => a.cleaner === 'files')!
    expect(f1.items?.join('\n')).toContain('dump-old.bin')
    expect(f1.detail).toContain('только отчёт')
    await expect(fs.access(big)).resolves.toBeUndefined()

    await setSetting('cleanupFilesDelete', 'true')
    const rep2 = await cleanup.runCleanup({ dryRun: false })
    const f2 = rep2.actions.find((a) => a.cleaner === 'files')!
    expect(f2.freedBytes).toBeGreaterThan(0)
    await expect(fs.access(big)).rejects.toThrow()

    // прибирайся: выключить поиск больших файлов и логи (не влияет на другие тесты)
    await setSetting('cleanupFilesEnabled', 'false')
    await setSetting('cleanupLogDirs', '')
  }, 60_000)
})

describe('cleanup: пороги и уведомления', () => {
  it('cleanupTick без включённых каналов/порогов — просто ничего не запускает', async () => {
    const r = await cleanup.cleanupTick('manual')
    expect(r.ran).toBe(false)
    expect(r.report).toBeUndefined()
  })

  it('getCleanupSettings возвращает дефолты и разбор списков', async () => {
    const cfg = await cleanup.getCleanupSettings()
    expect(cfg.triggerPct).toBe(90)
    expect(cfg.osPrefixes).toContain('logstash-')
    expect(cfg.autoEnabled).toBe(false)
    expect(cfg.schedule).toBeTruthy()
  })
})
