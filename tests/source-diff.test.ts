import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Диф обновления правил по источникам:
//  1) после загрузки источника — сколько правил добавлено/изменено/удалено vs
//     предыдущей версии (и «без изменений», когда переимпорт не требуется);
//  2) после сборки — как изменился итоговый набор vs предыдущий файл экспорта
//     (изменений нет — переимпортировать в Clear NDR/Suricata не требуется).

const ROOT = path.resolve(__dirname, '..')

// режимы управляемого фетчера (сети нет):
//  'rules'  — все источники получают remoteRules (список задаёт тест);
//  'replay' — каждый источник «загружает» то, что у него уже лежит в БД
//             (обновление без фактических изменений upstream — диф обязан быть нулевым)
let mode: 'rules' | 'replay' = 'rules'
let remoteRules: Array<{ sid: number; raw: string }> = []
vi.mock('@/lib/engine/fetcher', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/engine/fetcher')>()
  return {
    ...orig,
    fetchSource: async (cfg: { id: string }) => {
      if (mode === 'replay') {
        const { db: dbref } = await import('@/lib/db')
        const rows = await dbref.rule.findMany({ where: { sourceId: cfg.id } })
        return {
          ok: true,
          rules: rows.map((r) => ({
            action: r.action, proto: r.proto, srcIp: '$HOME_NET', srcPort: 'any', dstIp: '$EXTERNAL_NET', dstPort: 'any',
            sid: r.sid as number | null, rev: r.rev, msg: r.msg, classtype: r.clsType, raw: r.raw, suricataOk: r.suricataOk, compatNotes: r.compatNotes, format: 'snort2' as const,
          })),
          sizeBytes: 100,
        }
      }
      return {
        ok: true,
        rules: remoteRules.map((r) => ({
          action: 'alert', proto: 'tcp', srcIp: '$HOME_NET', srcPort: 'any', dstIp: '$EXTERNAL_NET', dstPort: 'any',
          sid: r.sid as number | null, rev: 1, msg: null, classtype: null, raw: r.raw, suricataOk: true, compatNotes: null, format: 'snort2' as const,
        })),
        sizeBytes: 100,
      }
    },
  }
})

let work: string
let db: import('@prisma/client').PrismaClient
let svc: typeof import('@/lib/engine/service')

// маркер — и в msg, и в content: hashRule канонизирует msg прочь, поэтому
// «изменение» правила обязано менять content, иначе правила схлопнет content-дедуп
const rule = (sid: number, marker: string) =>
  `alert tcp $HOME_NET any -> $EXTERNAL_NET any (msg:"TEST ${sid} ${marker}"; content:"mark-${sid}-${marker}"; sid:${sid}; rev:1;)`

async function makeSource(): Promise<string> {
  const s = await db.source.create({
    data: {
      name: `Diff Source ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'ruleset',
      kind: 'url',
      url: 'https://example.test/rules',
      format: 'auto',
      authType: 'none',
      enabled: true,
      priority: 100,
    },
  })
  return s.id
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-diff-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  svc = await import('@/lib/engine/service')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('диф загрузки источника (fetchSourceById)', () => {
  it('первая загрузка: все правила «добавлено», диф сохраняется в Source', async () => {
    const id = await makeSource()
    remoteRules = [{ sid: 1001, raw: rule(1001, 'a') }, { sid: 1002, raw: rule(1002, 'a') }, { sid: 1003, raw: rule(1003, 'a') }]
    const r = await svc.fetchSourceById(id)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(3)
    expect(r.diff).toEqual({ added: 3, changed: 0, removed: 0, unchanged: false })
    const row = await db.source.findUnique({ where: { id } })
    expect(row?.diffAdded).toBe(3)
    expect(row?.diffChanged).toBe(0)
    expect(row?.diffRemoved).toBe(0)
  })

  it('повторная загрузка того же контента: unchanged — обновлять Suricata не требуется', async () => {
    const id = await makeSource()
    remoteRules = [{ sid: 2001, raw: rule(2001, 'x') }, { sid: 2002, raw: rule(2002, 'x') }]
    await svc.fetchSourceById(id)
    const r2 = await svc.fetchSourceById(id)
    expect(r2.diff).toEqual({ added: 0, changed: 0, removed: 0, unchanged: true })
    const row = await db.source.findUnique({ where: { id } })
    expect(row?.diffAdded).toBe(0)
    expect(row?.diffChanged).toBe(0)
    expect(row?.diffRemoved).toBe(0)
  })

  it('частичные изменения: +1 добавлено, ~1 изменено, −1 удалено', async () => {
    const id = await makeSource()
    remoteRules = [{ sid: 3001, raw: rule(3001, 'v1') }, { sid: 3002, raw: rule(3002, 'v1') }, { sid: 3003, raw: rule(3003, 'v1') }]
    await svc.fetchSourceById(id)
    // 3001 изменился (новый content), 3002 исчез, 3003 остался, 3004 новый
    remoteRules = [{ sid: 3001, raw: rule(3001, 'v2') }, { sid: 3003, raw: rule(3003, 'v1') }, { sid: 3004, raw: rule(3004, 'v1') }]
    const r = await svc.fetchSourceById(id)
    expect(r.diff).toEqual({ added: 1, changed: 1, removed: 1, unchanged: false })
    const row = await db.source.findUnique({ where: { id } })
    expect(row?.diffAdded).toBe(1)
    expect(row?.diffChanged).toBe(1)
    expect(row?.diffRemoved).toBe(1)
  })

  it('fetchAllSources агрегирует диф: «обновление без изменений» — нулевой диф по всем источникам', async () => {
    // replay: каждый источник получает ровно своё текущее содержимое из БД —
    // все включённые источники (в том числе созданные предыдущими тестами) без изменений
    mode = 'replay'
    try {
      const res = await svc.fetchAllSources('manual')
      expect(res.ok).toBeGreaterThanOrEqual(2)
      expect(res.changesTotal).toBe(0)
      expect(res.diff).toEqual({ added: 0, changed: 0, removed: 0 })
      expect(res.unchangedSources).toBe(res.ok)
    } finally {
      mode = 'rules'
    }
  })
})

describe('диф сборки (buildFinal) vs предыдущей сборки', () => {
  it('первая сборка — сравнить не с чем; повторная без изменений — unchanged', async () => {
    const id = await makeSource()
    remoteRules = [{ sid: 5001, raw: rule(5001, 'k') }, { sid: 5002, raw: rule(5002, 'k') }]
    await svc.fetchSourceById(id)

    const b1 = await svc.buildFinal('manual')
    expect(b1.ok).toBe(true)
    expect(b1.changes).toBeNull() // первая сборка
    expect(b1.unchanged).toBe(false)

    const b2 = await svc.buildFinal('manual')
    expect(b2.ok).toBe(true)
    expect(b2.changes).toEqual({ added: 0, changed: 0, removed: 0 })
    expect(b2.unchanged).toBe(true)
  })

  it('после изменения источника сборка показывает +/~/− против предыдущего набора', async () => {
    const id = await makeSource()
    remoteRules = [{ sid: 6001, raw: rule(6001, 'v1') }, { sid: 6002, raw: rule(6002, 'v1') }]
    await svc.fetchSourceById(id)
    const b1 = await svc.buildFinal('manual')
    expect(b1.ok).toBe(true)

    // 6001 изменился, 6002 удалён, 6003 добавлен
    remoteRules = [{ sid: 6001, raw: rule(6001, 'v2') }, { sid: 6003, raw: rule(6003, 'v1') }]
    await svc.fetchSourceById(id)
    const b2 = await svc.buildFinal('manual')
    expect(b2.ok).toBe(true)
    expect(b2.changes).toEqual({ added: 1, changed: 1, removed: 1 })
    expect(b2.unchanged).toBe(false)

    // диф попал в statsJson последней сборки (для бейджа на вкладке «Сборка»)
    const last = await db.build.findFirst({ orderBy: { createdAt: 'desc' } })
    const stats = JSON.parse(last?.statsJson ?? '{}') as { changes?: { added: number; changed: number; removed: number } }
    expect(stats.changes).toEqual({ added: 1, changed: 1, removed: 1 })
  })
})
