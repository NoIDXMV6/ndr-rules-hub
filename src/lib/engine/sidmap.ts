// ─────────────────────────────────────────────────────────────────────────────
// Политика SID: перенос в свободный clearndr-блок 1 000 000 000..1 099 999 999
// Зеркало scripts/resid.py: та же формула md5("source|sid")[:8] % 1e8 + 1e9,
// тот же линейный probing и тот же файл data/sidmap.json — python-конвейер
// (make_final_files.py) и сервисный build выдают ИДЕНТИЧНЫЕ SID.
//
// Зачем: Snort резервирует 0..999999, ET — 1..2.2M, Suricata events — 2.2..2.3M,
// публичные сеты — 10..900M. Импорт «чужих» SID в Clear NDR падает
// ("The source contains conflicting SID (33) in same source").
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import type { BuiltRule } from './build'

export const SID_BLOCK_START = 1_000_000_000
export const SID_BLOCK_SIZE = 100_000_000
export const SID_BLOCK_END = SID_BLOCK_START + SID_BLOCK_SIZE - 1

export const SIDMAP_PATH = path.join(process.cwd(), 'data', 'sidmap.json')

export function hashSlot(key: string): number {
  const h = createHash('md5').update(key, 'utf8').digest('hex')
  return SID_BLOCK_START + (parseInt(h.slice(0, 8), 16) % SID_BLOCK_SIZE)
}

export class SidMapper {
  private map = new Map<string, number>()
  private used = new Set<number>()
  private loaded = false

  constructor(private mapPath: string = SIDMAP_PATH) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.mapPath, 'utf8')
      const d = JSON.parse(raw) as { map: Record<string, number> }
      for (const [k, v] of Object.entries(d.map ?? {})) {
        this.map.set(k, v)
        this.used.add(v)
      }
    } catch {
      /* файла ещё нет — начинаем с пустой карты */
    }
    this.loaded = true
  }

  /** Новый SID для source|orig_sid: стабильный, детерминированный, вне коллизий */
  get(source: string, origSid: number): number {
    if (!this.loaded) throw new Error('SidMapper.load() не вызван')
    const key = `${source}|${origSid}`
    const known = this.map.get(key)
    if (known !== undefined) return known
    let cand = hashSlot(key)
    while (this.used.has(cand)) {
      cand++
      if (cand > SID_BLOCK_END) throw new Error('clearndr SID block исчерпан')
    }
    this.used.add(cand)
    this.map.set(key, cand)
    return cand
  }

  async save(): Promise<void> {
    if (!this.loaded || this.map.size === 0) return
    const obj: Record<string, number> = {}
    for (const [k, v] of this.map) obj[k] = v
    await fs.mkdir(path.dirname(this.mapPath), { recursive: true })
    const tmp = this.mapPath + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ block: [SID_BLOCK_START, SID_BLOCK_END], map: obj }))
    await fs.rename(tmp, this.mapPath)
  }

  get size(): number {
    return this.map.size
  }
}

export interface RemapResult {
  renumbered: number
  unchanged: number
  minSid: number
  maxSid: number
}

/** Перенумеровать все правила с sid вне clearndr-блока; бросить ошибку при дубликатах */
export function remapToClearndrBlock(rules: BuiltRule[], mapper: SidMapper): RemapResult {
  let renumbered = 0
  let unchanged = 0
  for (const r of rules) {
    if (r.sid >= SID_BLOCK_START && r.sid <= SID_BLOCK_END) {
      unchanged++
      continue
    }
    const newSid = mapper.get(r.sourceName, r.sid)
    r.raw = r.raw.replace(/\bsid\s*:\s*\d+\s*;/, `sid:${newSid};`)
    if (!r.raw.includes(`sid:${newSid};`)) throw new Error(`опция sid не найдена в правиле: ${r.raw.slice(0, 120)}`)
    r.sid = newSid
    renumbered++
  }
  // жёсткий гейт: уникальность и диапазон
  const seen = new Set<number>()
  let min = Infinity
  let max = -Infinity
  for (const r of rules) {
    if (seen.has(r.sid)) throw new Error(`дубликат SID ${r.sid} после remap`)
    seen.add(r.sid)
    if (r.sid < SID_BLOCK_START || r.sid > SID_BLOCK_END) {
      throw new Error(`SID ${r.sid} вне clearndr-блока ${SID_BLOCK_START}..${SID_BLOCK_END}`)
    }
    if (r.sid < min) min = r.sid
    if (r.sid > max) max = r.sid
  }
  return { renumbered, unchanged, minSid: min, maxSid: max }
}
