// ─────────────────────────────────────────────────────────────────────────────
// Загрузка источников: URL/архивы/локальные файлы + авторизация (oinkcode и др.)
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import { parseRuleText, ParsedRule } from './parser'
import { convertIpList, convertDomainList, convertUrlList, ConvertOptions } from './convert'
import { hashRule } from './build'

const execFileP = promisify(execFile)

export const DATA_DIR = process.env.RULES_DATA_DIR || path.join(process.cwd(), 'data')
export const CACHE_DIR = path.join(DATA_DIR, 'cache')
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports')

export interface FetchSourceCfg {
  id: string
  name: string
  category: string // ruleset | ip-list | domain-list | url-list
  kind: string // url | tarball | local
  url?: string | null
  authType: string // none | oinkcode | authkey | basic
  extraJson?: string | null
  format: string
}

export interface FetchResult {
  ok: boolean
  error?: string
  rules: ParsedRule[]
  sizeBytes: number
  usedCache?: boolean
  /** предупреждение при использовании кэша (показывается в логах и ответе API) */
  cacheNote?: string
}

interface ExtraCfg {
  oinkcode?: string
  authKey?: string
  basicUser?: string
  basicPassword?: string
  // конвертеры
  sidStart?: number
  action?: string
  proto?: string
  msgPrefix?: string
  perRule?: number
  maxRules?: number
  classtype?: string
  // для tarball: glob подкаталога с .rules
  subPath?: string
  // для tarball: не перекачивать архив чаще N минут (0/нет — перекачивать всегда;
  // у snort.org лимит — не чаще раза в 15 минут)
  cacheTtlMinutes?: number
}

function applyAuth(url: string, cfg: FetchSourceCfg, extra: ExtraCfg): string {
  if (cfg.authType === 'oinkcode' && extra.oinkcode) {
    // https://www.snort.org/reg-rules/<file>.tar.gz → редиректит на /rules/<file>?oinkcode=
    const sep = url.includes('?') ? '&' : '?'
    if (url.includes('snort.org/reg-rules/')) return `${url}/${extra.oinkcode}`
    return `${url}${sep}oinkcode=${extra.oinkcode}`
  }
  if (cfg.authType === 'authkey' && extra.authKey) {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}auth-key=${extra.authKey}`
  }
  return url
}

async function httpGet(url: string, extra: ExtraCfg): Promise<{ status: number; body: Buffer; finalUrl: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'User-Agent': 'clearndr-rules-hub/1.0 (rules updater)',
      ...(cfg_basic(extra)),
    },
  })
  const body = Buffer.from(await res.arrayBuffer())
  return { status: res.status, body, finalUrl: res.url }
}
function cfg_basic(extra: ExtraCfg): Record<string, string> {
  if (extra.basicUser && extra.basicPassword) {
    const token = Buffer.from(`${extra.basicUser}:${extra.basicPassword}`).toString('base64')
    return { Authorization: `Basic ${token}` }
  }
  return {}
}

/** Вытащить человекочитаемую причину из тела ответа (snort.org отвечает ["Invalid oinkcode"], другие — текстом/HTML) */
export function bodyReason(body: Buffer): string | null {
  const t = body.toString('utf8').slice(0, 2000).trim()
  if (!t) return null
  const json = t.match(/\[\s*"([^"\\]{3,200})"\s*\]/)
  if (json) return json[1]
  const plain = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return plain ? plain.slice(0, 140) : null
}

/** Подпись oinkcode для ошибок: видно, задан ли он и какова длина, без раскрытия значения */
export function oinkcodeFingerprint(extra: ExtraCfg): string {
  const c = (extra.oinkcode ?? '').trim()
  if (!c) return 'oinkcode НЕ задан — запрос ушёл без него (укажите код в «Настройки» или в extra источника)'
  return `отправлен oinkcode ${c.slice(0, 4)}…${c.slice(-4)} (${c.length} симв.)`
}

/** Понятная ошибка для snort.org (422 = «Invalid oinkcode», 403/429 — лимиты) */
export function snortFetchError(status: number, body: Buffer, extra: ExtraCfg, url: string): string {
  const reason = bodyReason(body)
  let msg = `snort.org: HTTP ${status} при загрузке ${url}`
  if (reason) msg += ` — «${reason}»`
  msg += `; ${oinkcodeFingerprint(extra)}`
  if (status === 422) {
    msg += '. HTTP 422 у snort.org — почти всегда «Invalid oinkcode»: проверьте код в «Настройки» '
      + '(берётся на snort.org → Preferences → Oinkcode, 40 hex-символов, без пробелов) и повторите «Обновить»'
  } else if (status === 403) {
    msg += '. Отказ: неверный oinkcode либо превышен лимит загрузок (registered — не чаще раза в 15 минут) — повторите позже'
  } else if (status === 429) {
    msg += '. Слишком частые запросы — подождите 15-30 минут'
  }
  return msg
}

async function extractTarball(tarPath: string, destDir: string, subPath?: string): Promise<string[]> {
  await fs.mkdir(destDir, { recursive: true })
  await execFileP('tar', ['-xzf', tarPath, '-C', destDir], { timeout: 180_000 })
  // ищем .rules файлы (опционально только в указанном подкаталоге архива)
  const found: string[] = []
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.name.endsWith('.rules')) {
        if (subPath) {
          const rel = path.relative(destDir, p).split(path.sep)
          if (!rel.includes(subPath)) continue
        }
        found.push(p)
      }
    }
  }
  await walk(destDir)
  return found.sort()
}

/** Разобрать ранее скачанный архив (кэш): null — архива нет или он не читается */
async function extractCached(tarPath: string, destDir: string, subPath?: string): Promise<{ rules: ParsedRule[]; sizeBytes: number } | null> {
  const st = await fs.stat(tarPath).catch(() => null)
  if (!st) return null
  try {
    const found = await extractTarball(tarPath, destDir, subPath)
    let rules: ParsedRule[] = []
    let size = 0
    for (const f of found) {
      const t = await fs.readFile(f, 'utf8')
      size += t.length
      rules.push(...parseRuleText(t))
    }
    return { rules, sizeBytes: size }
  } catch {
    return null
  }
}

/** Загрузить и разобрать один источник */
export async function fetchSource(cfg: FetchSourceCfg, opts: { maxRules?: number } = {}): Promise<FetchResult> {
  let extra: ExtraCfg = {}
  try {
    extra = cfg.extraJson ? (JSON.parse(cfg.extraJson) as ExtraCfg) : {}
  } catch {
    /* ignore */
  }

  try {
    // ── локальный файл/каталог (загруженные архивы)
    if (cfg.kind === 'local') {
      const p = cfg.url ?? ''
      let rules: ParsedRule[] = []
      let size = 0
      const st = await fs.stat(p).catch(() => null)
      if (!st) return { ok: false, error: `локальный путь не найден: ${p}`, rules: [], sizeBytes: 0 }
      if (st.isDirectory()) {
        const files: string[] = []
        async function walk(dir: string) {
          for (const e of await fs.readdir(dir, { withFileTypes: true })) {
            const fp = path.join(dir, e.name)
            if (e.isDirectory()) await walk(fp)
            else if (e.name.endsWith('.rules')) files.push(fp)
          }
        }
        await walk(p)
        for (const f of files.sort()) {
          const t = await fs.readFile(f, 'utf8')
          size += t.length
          rules.push(...parseRuleText(t))
        }
      } else if (p.endsWith('.tar.gz') || p.endsWith('.tgz')) {
        const destDir = path.join(CACHE_DIR, `local-${cfg.id}`)
        const found = await extractTarball(p, destDir, extra.subPath)
        for (const f of found) {
          const t = await fs.readFile(f, 'utf8')
          size += t.length
          rules.push(...parseRuleText(t))
        }
      } else {
        const t = await fs.readFile(p, 'utf8')
        size = t.length
        rules = parseRuleText(t)
      }
      return { ok: true, rules, sizeBytes: size }
    }

    // ── сетевые источники
    if (!cfg.url) return { ok: false, error: 'не задан URL', rules: [], sizeBytes: 0 }
    const url = applyAuth(cfg.url, cfg, extra)
    const isSnort = /snort\.org/i.test(cfg.url)

    if (cfg.kind === 'tarball') {
      const tarPath = path.join(CACHE_DIR, `src-${cfg.id}.tar.gz`)
      const destDir = path.join(CACHE_DIR, `src-${cfg.id}`)

      // свежий кэш (extra.cacheTtlMinutes, по умолчанию 0 = выкл): не дёргаем
      // источник чаще лимита (у snort.org registered — раз в 15 минут)
      const ttl = Number(extra.cacheTtlMinutes ?? 0)
      const st = await fs.stat(tarPath).catch(() => null)
      if (ttl > 0 && st && Date.now() - st.mtimeMs < ttl * 60_000) {
        const cached = await extractCached(tarPath, destDir, extra.subPath)
        if (cached) {
          return {
            ok: true, rules: cached.rules, sizeBytes: cached.sizeBytes, usedCache: true,
            cacheNote: `использован свежий кэш архива от ${st.mtime.toISOString()} (cacheTtlMinutes=${ttl})`,
          }
        }
      }

      const res = await httpGet(url, extra)
      if (res.status !== 200) {
        const errText = isSnort
          ? snortFetchError(res.status, res.body, extra, cfg.url)
          : `HTTP ${res.status} при загрузке ${cfg.url}${bodyReason(res.body) ? ` — «${bodyReason(res.body)}»` : ''}`
        // запасной путь: ранее скачанный архив — работаем от него, источник помечаем предупреждением
        const cached = await extractCached(tarPath, destDir, extra.subPath)
        if (cached) {
          return {
            ok: true, rules: cached.rules, sizeBytes: cached.sizeBytes, usedCache: true,
            cacheNote: `${errText} — использован кэш архива от ${st?.mtime.toISOString() ?? '—'}`,
          }
        }
        return { ok: false, error: errText, rules: [], sizeBytes: res.body.length }
      }
      await fs.mkdir(CACHE_DIR, { recursive: true })
      await fs.writeFile(tarPath, res.body)
      const found = await extractTarball(tarPath, destDir, extra.subPath)
      let rules: ParsedRule[] = []
      let size = 0
      for (const f of found) {
        const t = await fs.readFile(f, 'utf8')
        size += t.length
        rules.push(...parseRuleText(t))
      }
      return { ok: true, rules, sizeBytes: size }
    }

    // ruleset / список — обычный текст
    const res = await httpGet(url, extra)
    if (res.status !== 200) {
      const errText = isSnort
        ? snortFetchError(res.status, res.body, extra, cfg.url)
        : `HTTP ${res.status} при загрузке ${cfg.url}${bodyReason(res.body) ? ` — «${bodyReason(res.body)}»` : ''}`
      return { ok: false, error: errText, rules: [], sizeBytes: res.body.length }
    }
    const text = res.body.toString('utf8')
    if (cfg.category === 'ip-list') {
      const conv = convertIpList(text, convOpts(extra, cfg))
      return { ok: true, rules: conv.map((r) => toParsed(r)), sizeBytes: text.length }
    }
    if (cfg.category === 'domain-list') {
      const conv = convertDomainList(text, convOpts(extra, cfg))
      return { ok: true, rules: conv.map((r) => toParsed(r)), sizeBytes: text.length }
    }
    if (cfg.category === 'url-list') {
      const conv = convertUrlList(text, convOpts(extra, cfg))
      return { ok: true, rules: conv.map((r) => toParsed(r)), sizeBytes: text.length }
    }
    return { ok: true, rules: parseRuleText(text), sizeBytes: text.length }
  } catch (e) {
    return { ok: false, error: `ошибка загрузки: ${(e as Error).message}`, rules: [], sizeBytes: 0 }
  }
}

function convOpts(extra: ExtraCfg, cfg: FetchSourceCfg): ConvertOptions {
  return {
    sidStart: extra.sidStart ?? 1100000,
    action: extra.action,
    proto: extra.proto,
    msgPrefix: extra.msgPrefix ?? cfg.name,
    perRule: extra.perRule,
    maxRules: extra.maxRules,
    classtype: extra.classtype,
  }
}

function toParsed(r: { sid: number; rev: number; raw: string; suricataOk: boolean; compatNotes: string | null }): ParsedRule {
  return {
    action: 'alert',
    proto: 'converted',
    srcIp: '',
    srcPort: '',
    dstIp: '',
    dstPort: '',
    sid: r.sid,
    rev: r.rev,
    msg: r.raw.match(/\bmsg\s*:\s*"([^"]*)"/i)?.[1] ?? null,
    classtype: null,
    raw: r.raw,
    suricataOk: r.suricataOk,
    compatNotes: r.compatNotes,
    format: 'suricata',
  }
}

export function ruleHash(raw: string): string {
  return hashRule(raw)
}
