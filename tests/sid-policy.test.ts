import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mergeSources, hashRule, renderFinalFile, SourceRules, BuiltRule } from '@/lib/engine/build'
import { SidMapper, remapToClearndrBlock, hashSlot, SID_BLOCK_START, SID_BLOCK_END } from '@/lib/engine/sidmap'

function mkRule(sid: number, rev: number, content: string) {
  return `alert tcp any any -> any any (msg:"${content}"; content:"${content}"; sid:${sid}; rev:${rev};)`
}

function src(name: string, priority: number, rules: Array<[number, number, string]>): SourceRules {
  return {
    sourceId: name,
    sourceName: name,
    priority,
    rules: rules.map(([sid, rev, content]) => ({
      sid, rev, raw: mkRule(sid, rev, content), action: 'alert', proto: 'tcp',
      contentHash: hashRule(mkRule(sid, rev, content)), suricataOk: true, compatNotes: null,
    })),
  }
}

let mapDir = ''
let mapPath = ''

beforeAll(async () => {
  mapDir = await fs.mkdtemp(join(tmpdir(), 'sidmap-test-'))
  mapPath = join(mapDir, 'sidmap.json')
})

afterAll(async () => {
  await fs.rm(mapDir, { recursive: true, force: true })
})

describe('sidmap: детерминированный remap в clearndr-блок', () => {
  it('совпадает с python-конвейером (scripts/resid.py) — значение из SID-MAP.csv', () => {
    // python: md5("Talos Snort 2.9 (конвертировано в Suricata)|42588") → sid 1000000536
    const key = 'Talos Snort 2.9 (конвертировано в Suricata)|42588'
    expect(hashSlot(key)).toBe(1_000_000_536)
  })

  it('стабилен: тот же ключ → тот же SID, повторно и между экземплярами', async () => {
    const m1 = new SidMapper(mapPath)
    await m1.load()
    const a1 = m1.get('Src A', 3)
    const a2 = m1.get('Src A', 3)
    expect(a1).toBe(a2)
    await m1.save()

    const m2 = new SidMapper(mapPath) // новый экземпляр, загрузка с диска
    await m2.load()
    expect(m2.get('Src A', 3)).toBe(a1)
  })

  it('все SID в блоке 1e9..1.1e9 и не конфликтуют при коллизии хеша (probing)', async () => {
    const m = new SidMapper(join(mapDir, 'probe.json'))
    await m.load()
    const seen = new Set<number>()
    for (let i = 0; i < 5000; i++) {
      const s = m.get('bulk-source', i)
      expect(s).toBeGreaterThanOrEqual(SID_BLOCK_START)
      expect(s).toBeLessThanOrEqual(SID_BLOCK_END)
      expect(seen.has(s)).toBe(false)
      seen.add(s)
    }
  })

  it('гейт: дубликат SID после remap роняет сборку', async () => {
    const p = join(mapDir, 'dup.json')
    // заранее занимаем слот, куда remap попытается положить правило B
    await fs.writeFile(p, JSON.stringify({ block: [SID_BLOCK_START, SID_BLOCK_END], map: { 'srcB|5': 1_000_000_000 } }))
    const m = new SidMapper(p)
    await m.load()
    const rules: BuiltRule[] = [
      { sid: 1_000_000_000, rev: 1, raw: mkRule(1_000_000_000, 1, 'in-block'), sourceName: 'srcA' },
      { sid: 5, rev: 1, raw: mkRule(5, 1, 'collides'), sourceName: 'srcB' },
    ]
    expect(() => remapToClearndrBlock(rules, m)).toThrow(/дубликат SID/)
  })
})

describe('конвейер build+remap: уникальность SID итогового набора', () => {
  it('исходные SID 3/33/1000000 из перекрывающихся источников → уникальные SID ≥ 1e9', async () => {
    const sources = [
      src('Talos Snort 2.9 (конвертировано в Suricata)', 1, [[3, 2, 'cnc-a'], [33, 1, 'cnc-b'], [1000000, 4, 'et-x']]),
      src('[локальный архив] snortrules-snapshot-3200.tar.gz', 2, [[3, 1, 'cnc-a'], [33, 3, 'cnc-b2']]),
    ]
    const { rules } = mergeSources(sources, { sidStrategy: 'highest-rev', contentDedup: true })
    const m = new SidMapper(join(mapDir, 'pipeline.json'))
    await m.load()
    const res = remapToClearndrBlock(rules, m)
    expect(res.renumbered).toBe(rules.length)
    const sids = rules.map((r) => r.sid)
    expect(new Set(sids).size).toBe(sids.length) // уникальность
    for (const s of sids) {
      expect(s).toBeGreaterThanOrEqual(SID_BLOCK_START)
      expect(s).toBeLessThanOrEqual(SID_BLOCK_END)
    }
    // в raw заменено значение sid, старый SID отсутствует как опция
    for (const r of rules) {
      expect(r.raw).toContain(`sid:${r.sid};`)
      expect(r.raw).not.toMatch(/sid:(3|33|1000000);/)
    }
  })

  it('renderFinalFile: парсинг итогового файла даёт 0 дубликатов SID', async () => {
    const sources = [
      src('s1', 1, [[3, 1, 'x'], [33, 1, 'y']]),
      src('s2', 2, [[3, 2, 'x2'], [7, 1, 'z']]),
    ]
    const { rules } = mergeSources(sources)
    const m = new SidMapper(join(mapDir, 'render.json'))
    await m.load()
    remapToClearndrBlock(rules, m)
    const content = renderFinalFile(rules, { sources: ['s1', 's2'] })
    const sids = [...content.matchAll(/\bsid\s*:\s*(\d+)\s*;/g)].map((x) => parseInt(x[1], 10))
    expect(sids.length).toBe(rules.length)
    expect(new Set(sids).size).toBe(sids.length)
    expect(Math.min(...sids)).toBeGreaterThanOrEqual(SID_BLOCK_START)
  })

  it('remap идемпотентен: SID уже в блоке не меняются', async () => {
    const m = new SidMapper(join(mapDir, 'idem.json'))
    await m.load()
    const rules: BuiltRule[] = [
      { sid: 1_000_000_042, rev: 1, raw: mkRule(1_000_000_042, 1, 'already'), sourceName: 'src' },
      { sid: 33, rev: 1, raw: mkRule(33, 1, 'low'), sourceName: 'src' },
    ]
    const r1 = remapToClearndrBlock(rules, m)
    expect(r1.renumbered).toBe(1)
    expect(r1.unchanged).toBe(1)
    const r2 = remapToClearndrBlock(rules, m)
    expect(r2.renumbered).toBe(0)
    expect(r2.unchanged).toBe(2)
  })
})
