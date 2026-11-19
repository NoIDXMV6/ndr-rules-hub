import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mergeSources, hashRule, renderFinalFile, SourceRules, BuiltRule, REASSIGN_BLOCK_START, REASSIGN_BLOCK_END } from '@/lib/engine/build'
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

describe('sidConflict: reassign — проигравший при конфликте SID остаётся с новым SID', () => {
  it('кросс-источниковый конфликт, разные детекты: оба правила в сборке, у проигравшего временный SID', () => {
    const sources = [
      src('s1', 1, [[5000, 3, 'alpha']]),
      src('s2', 2, [[5000, 1, 'beta']]),
    ]
    // историческое поведение (drop): остаётся победитель по rev
    const dropped = mergeSources(sources, { sidStrategy: 'highest-rev' })
    expect(dropped.rules.length).toBe(1)

    const { rules, stats } = mergeSources(sources, { sidStrategy: 'highest-rev', sidConflict: 'reassign' })
    expect(rules.length).toBe(2)
    expect(stats.reassigned).toBe(1)
    // проигравший не считается «отброшенным дубликатом SID»
    expect(stats.duplicateBySid).toBe(0)
    const winner = rules.find((r) => r.sid === 5000)!
    expect(winner.sourceName).toBe('s1') // rev 3 > rev 1
    const loser = rules.find((r) => r.sid !== 5000)!
    expect(loser.sourceName).toBe('s2')
    expect(loser.sid).toBeGreaterThanOrEqual(REASSIGN_BLOCK_START)
    expect(loser.sid).toBeLessThanOrEqual(REASSIGN_BLOCK_END)
    expect(loser.raw).toContain(`sid:${loser.sid};`)
    expect(loser.raw).not.toContain('sid:5000;')
    const sids = rules.map((r) => r.sid)
    expect(new Set(sids).size).toBe(sids.length)
    // аудит переназначений
    expect(stats.sidsReassigned).toEqual([{ sid: 5000, newSid: loser.sid, source: 's2', rev: 1 }])
    // perSource: оба источника сохранили по правилу
    expect(stats.perSource['s1'].kept).toBe(1)
    expect(stats.perSource['s2'].kept).toBe(1)
  })

  it('тот же sid и ОДИНАКОВЫЙ детект: проигравший отбрасывается даже при reassign', () => {
    const sources = [
      src('s1', 1, [[5000, 3, 'same']]),
      src('s2', 2, [[5000, 1, 'same']]),
    ]
    const { rules, stats } = mergeSources(sources, { sidStrategy: 'highest-rev', sidConflict: 'reassign' })
    expect(rules.length).toBe(1)
    expect(stats.reassigned).toBe(0)
    expect(stats.duplicateBySid).toBe(1)
  })

  it('вытесненный чемпион (третий источник с высшим rev) тоже переназначается', () => {
    const sources = [
      src('s1', 1, [[7000, 1, 'old']]),
      src('s2', 2, [[7000, 5, 'new']]),
      src('s3', 3, [[7000, 2, 'mid']]),
    ]
    const { rules, stats } = mergeSources(sources, { sidStrategy: 'highest-rev', sidConflict: 'reassign' })
    expect(rules.length).toBe(3)
    expect(stats.reassigned).toBe(2)
    expect(rules.find((r) => r.sourceName === 's2')!.sid).toBe(7000) // rev 5 — победитель
    const losers = rules.filter((r) => r.sourceName !== 's2')
    expect(losers[0].sid).not.toBe(losers[1].sid)
    for (const l of losers) {
      expect(l.sid).toBeGreaterThanOrEqual(REASSIGN_BLOCK_START)
      expect(l.raw).toContain(`sid:${l.sid};`)
    }
    // баланс perSource: каждый источник сохранил своё правило
    expect(stats.perSource['s1'].kept).toBe(1)
    expect(stats.perSource['s2'].kept).toBe(1)
    expect(stats.perSource['s3'].kept).toBe(1)
  })

  it('два разных правила под одним SID в ОДНОМ источнике (случай remap-гейта) — оба остаются', () => {
    const sources = [src('s1', 1, [[9000, 1, 'x'], [9000, 2, 'y']])]
    const { rules, stats } = mergeSources(sources, { sidStrategy: 'highest-rev', sidConflict: 'reassign' })
    expect(rules.length).toBe(2)
    expect(stats.reassigned).toBe(1)
    // rev 2 ('y') побеждает и держит исходный sid
    const keeper = rules.find((r) => r.sid === 9000)!
    expect(keeper.raw).toContain('msg:"y"')
    const moved = rules.find((r) => r.sid !== 9000)!
    expect(moved.raw).toContain('msg:"x"')
    expect(moved.sid).toBeGreaterThanOrEqual(REASSIGN_BLOCK_START)
  })

  it('новый SID детерминирован, стабилен и не совпадает ни с одним входным SID', () => {
    const mk = () => [
      src('s1', 1, [[6000, 2, 'aaa'], [6001, 1, 'bbb']]),
      src('s2', 2, [[6000, 1, 'ccc'], [6001, 5, 'ddd']]),
    ]
    const a = mergeSources(mk(), { sidConflict: 'reassign' })
    const b = mergeSources(mk(), { sidConflict: 'reassign' })
    expect(a.rules.length).toBe(4)
    expect(a.stats.reassigned).toBe(2)
    expect(a.rules.map((r) => r.sid)).toEqual(b.rules.map((r) => r.sid))
    const inputSids = new Set([6000, 6001])
    for (const r of a.rules) {
      if (r.sid >= REASSIGN_BLOCK_START) expect(inputSids.has(r.sid)).toBe(false)
    }
  })

  it('смена rev/msg/metadata не меняет назначенный SID (contentHash снимает их)', () => {
    const v1 = [src('s1', 1, [[8000, 3, 'one']]), src('s2', 2, [[8000, 1, 'two']])]
    // rev вырос, msg дополнен — детект тот же: mkRule кладёт content в msg,
    // поэтому проверяем именно стабильность ключа на равном содержимом
    const r1 = mergeSources(v1, { sidConflict: 'reassign' })
    const v2 = [src('s1', 1, [[8000, 9, 'one']]), src('s2', 2, [[8000, 2, 'two']])]
    const r2 = mergeSources(v2, { sidConflict: 'reassign' })
    const l1 = r1.rules.find((r) => r.sid !== 8000)!
    const l2 = r2.rules.find((r) => r.sid !== 8000)!
    expect(l1.sid).toBe(l2.sid)
  })

  it('конвейер build+remap: переназначенные правила получают свои слоты в clearndr-блоке', async () => {
    // критический случай: ДВА разных правила под одним sid в ОДНОМ источнике —
    // раньше remap упал бы на дубликате ключа «источник|sid», теперь ключи разные
    const sources = [
      src('s1', 1, [[8000, 3, 'one']]),
      src('s2', 2, [[8000, 1, 'two']]),
      src('s3', 3, [[9000, 1, 'q1'], [9000, 2, 'q2']]),
    ]
    const { rules } = mergeSources(sources, { sidStrategy: 'highest-rev', sidConflict: 'reassign' })
    expect(rules.length).toBe(4) // 8000: winner+loser, 9000: winner+loser
    const m = new SidMapper(join(mapDir, 'reassign.json'))
    await m.load()
    const res = remapToClearndrBlock(rules, m)
    expect(res.renumbered).toBe(4)
    const sids = rules.map((r) => r.sid)
    expect(new Set(sids).size).toBe(sids.length)
    for (const s of sids) {
      expect(s).toBeGreaterThanOrEqual(SID_BLOCK_START)
      expect(s).toBeLessThanOrEqual(SID_BLOCK_END)
    }
    // стабильность финальных SID: та же карта, повторный remap идемпотентен
    const res2 = remapToClearndrBlock(rules, m)
    expect(res2.renumbered).toBe(0)
    expect(res2.unchanged).toBe(4)
    // в raw нет временных SID reassign-блока
    for (const r of rules) {
      expect(r.sid).toBeGreaterThanOrEqual(SID_BLOCK_START)
      expect(r.raw).toContain(`sid:${r.sid};`)
      expect(r.raw).not.toMatch(/sid:2\d{9};/)
    }
  })

  it('renderFinalFile: шапка сообщает о переназначенных SID', () => {
    const sources = [
      src('s1', 1, [[5000, 3, 'alpha']]),
      src('s2', 2, [[5000, 1, 'beta']]),
    ]
    const { rules, stats } = mergeSources(sources, { sidConflict: 'reassign' })
    const content = renderFinalFile(rules, { sources: ['s1', 's2'], stats })
    expect(content).toContain('Проигравшим при конфликте SID назначен новый SID: 1')
    // итоговый файл по-прежнему без дубликатов SID
    const sids = [...content.matchAll(/\bsid\s*:\s*(\d+)\s*;/g)].map((x) => parseInt(x[1], 10))
    expect(new Set(sids).size).toBe(sids.length)
  })
})
