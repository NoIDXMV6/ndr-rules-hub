// ─────────────────────────────────────────────────────────────────────────────
// Загрузка источников: URL/архивы/локальные файлы + авторизация (oinkcode и др.)
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import { parseRuleText, ParsedRule } from './parser'
import { convertIpList, convertDomainList, convertUrlList, convertHashList, convertZeekIntel, convertMispJson, ConvertOptions } from './convert'
import { hashRule } from './build'
import { maybeGunzip, parseRstFeedCsv } from './rst'

const execFileP = promisify(execFile)

export const DATA_DIR = process.env.RULES_DATA_DIR || path.join(process.cwd(), 'data')
export const CACHE_DIR = path.join(DATA_DIR, 'cache')
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports')

export interface FetchSourceCfg {
  id: string
  name: string
  category: string // ruleset | ip-list | domain-list | url-list | zeek-intel | misp
  kind: string // url | tarball | local
  url?: string | null
  authType: string // none | oinkcode | authkey | basic | misp | rstkey (RST Cloud: ключ в заголовке X-Api-Key)
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

export interface ExtraCfg {
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
  // переопределение User-Agent (некоторые серверы блокируют не-браузерные UA,
  // например ptrules.com отвечает 403 на clearndr-rules-hub/…)
  userAgent?: string
  // MISP: ключ REST API (заголовок Authorization). Подставляется из настройки
  // «MISP API Key» для источников с авторизацией «misp»
  mispAuthKey?: string
  // Open NRD (Stamus Networks): код лицензии — сегмент пути URL (%%OPENNRD%%).
  // Подставляется из настройки «Open NRD» («Токены источников») для источников
  // с авторизацией «opennrd»
  openNrdCode?: string
  // RST Cloud (api.rstcloud.net): API-ключ в заголовке X-Api-Key.
  // Подставляется из настройки «RST Cloud» («Токены источников») для источников
  // с авторизацией «rstkey». Ключ общий для фидов и IoC Lookup.
  rstApiKey?: string
  // RST Threat Feed: тип фида (ip | domain | url | hash) — CSV-ответ
  // разбирается в список индикаторов (колонка фида) до конвертации
  rstFeed?: string
  // RST Threat Feed: пропускать записи с fp_alarm=true (например, домены
  // под сикхоулом исследователей — трафик на них доброкачественный)
  skipFpAlarm?: boolean
  // RST Threat Feed: минимальный балл score_total (0..100); 0 — без фильтра
  minScore?: number
  // RST Threat Feed: предохранитель по ЧИСЛУ ИНДИКАТОРОВ (строк фида);
  // 0/нет — без ограничения (для чанкованных IP-фидов ограничение правил —
  // отдельная опция maxRules конвертера)
  maxValues?: number
  // резервные URL (зеркала): если основной URL недоступен (сетевая ошибка,
  // HTTP != 200, не-архив), пробуются зеркала по очереди — например, архив
  // GitHub-репозитория, когда официальный сайт источника лежит (PAW Patrules)
  mirrorUrls?: string[]
}

// ── Определение провайдера по URL ────────────────────────────────────────────

/** ET Pro (Proofpoint, rules.emergingthreatspro.com): у набора СВОЙ oinkcode,
 *  он НЕ совпадает с oinkcode snort.org — глобальный снортовский код к нему
 *  не подставляется (иначе источник «молча» ходил со чужим кодом). */
export function isEtProUrl(url?: string | null): boolean {
  if (!url) return false
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return h === 'emergingthreatspro.com' || h.endsWith('.emergingthreatspro.com')
  } catch {
    return false
  }
}

/** snort.org (зарегистрированные/подписочные наборы): официальное ограничение
 *  частоты загрузок — не чаще 1 раза в 15 минут (suricata-update проверяет то
 *  же: «Last download less than 15 minutes ago»); при нарушении сервер отвечает
 *  403 и может заблокировать oinkcode. */
export function isSnortOrgUrl(url?: string | null): boolean {
  if (!url) return false
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return h === 'snort.org' || h.endsWith('.snort.org')
  } catch {
    return false
  }
}

/** Open NRD (Stamus Networks, ti.stamus-networks.io): фиды новых доменов
 *  (newly registered domains) — код лицензии в сегменте пути. */
export function isStamusOpenNrdUrl(url?: string | null): boolean {
  if (!url) return false
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return h === 'ti.stamus-networks.io' || h.endsWith('.stamus-networks.io')
  } catch {
    return false
  }
}

/** Минимальный интервал между загрузками snort.org (официальный лимит) */
export const SNORT_MIN_FETCH_INTERVAL_MS = 15 * 60 * 1000

/** Гейт частоты загрузок snort.org: считаем от последней ПОПЫТКИ (lastFetchAt
 *  обновляется и при ошибке — запрос к snort.org уже ушёл и учтён их лимитом). */
export function snortRateGate(
  lastFetchAt: Date | null | undefined,
  now = Date.now(),
): { blocked: boolean; retryAfterSec: number; elapsedMin: number } {
  if (!lastFetchAt) return { blocked: false, retryAfterSec: 0, elapsedMin: 0 }
  const elapsed = now - lastFetchAt.getTime()
  const elapsedMin = Math.max(0, Math.floor(elapsed / 60_000))
  if (elapsed >= SNORT_MIN_FETCH_INTERVAL_MS) return { blocked: false, retryAfterSec: 0, elapsedMin }
  return { blocked: true, retryAfterSec: Math.ceil((SNORT_MIN_FETCH_INTERVAL_MS - elapsed) / 1000), elapsedMin }
}

export function applyAuth(url: string, cfg: FetchSourceCfg, extra: ExtraCfg): string {
  if (cfg.authType === 'oinkcode' && extra.oinkcode) {
    const code = extra.oinkcode.trim()
    if (code) {
      // ET Pro (и прочие path-based oinkcode-схемы): плейсхолдер %%OINKCODE%%
      // в seed-URL заменяется на код, например
      //   https://rules.emergingthreats.net/%%OINKCODE%%/suricata-7.0/emerging-all.rules
      if (url.includes('%%OINKCODE%%')) return url.replaceAll('%%OINKCODE%%', code)
      // Каноническая форма авторизации snort.org — oinkcode как сегмент пути:
      //   https://www.snort.org/reg-rules/<файл>.tar.gz/<oinkcode>
      // Ссылки из личного кабинета (https://snort.org/downloads/registered/<файл>.tar.gz)
      // oinkcode в query НЕ принимают: отдают HTML-страницу с HTTP 200, которая раньше
      // сохранялась как «архив» и ломала tar («not in gzip format»).
      // Поэтому такие URL приводим к канонической reg-rules-форме.
      const dl = url.match(/^https?:\/\/(?:www\.)?snort\.org\/downloads\/(?:registered|subscribed)\/([^/?#]+)/i)
      if (dl) return `https://www.snort.org/reg-rules/${dl[1]}/${code}`
      if (/^https?:\/\/(?:www\.)?snort\.org\/reg-rules\//i.test(url)) return `${url.split('?')[0]}/${code}`
      const sep = url.includes('?') ? '&' : '?'
      return `${url}${sep}oinkcode=${code}`
    }
  }
  if (cfg.authType === 'authkey' && extra.authKey) {
    const key = extra.authKey.trim()
    if (key) {
      // abuse.ch (ThreatFox/URLhaus, с 10.2026): ключ — сегмент пути выгрузки,
      // в seed-URL он помечен плейсхолдером %%AUTHKEY%%:
      //   https://threatfox-api.abuse.ch/v2/files/exports/%%AUTHKEY%%/threatfox_suricata.rules
      if (url.includes('%%AUTHKEY%%')) return url.replaceAll('%%AUTHKEY%%', key)
      // прочие провайдеры — ключ в query (обратная совместимость)
      const sep = url.includes('?') ? '&' : '?'
      return `${url}${sep}auth-key=${key}`
    }
  }
  // Open NRD (Stamus Networks): код лицензии — сегмент пути, в seed-URL он
  // помечен плейсхолдером %%OPENNRD%% (код выдаётся бесплатно по форме на сайте)
  if (cfg.authType === 'opennrd' && extra.openNrdCode) {
    const code = extra.openNrdCode.trim()
    if (code && url.includes('%%OPENNRD%%')) return url.replaceAll('%%OPENNRD%%', encodeURIComponent(code))
  }
  return url
}

/** Скрыть Auth-Key в URL перед логированием (ключ — сегмент пути у abuse.ch v2, ET Pro — %%OINKCODE%%) */
export function maskAuthKey(url: string): string {
  return url
    .replace(/\/v2\/files\/exports\/([^/]+)\//i, '/v2/files/exports/***/')
    .replace(/([?&]auth-key=)[^&]+/i, '$1***')
    .replace(/\/%%OINKCODE%%|\/[0-9a-f]{16,}(?=\/)/i, '/***')
}

/** У настоящего tar.gz первые два байта — 0x1f 0x8b (magic gzip) */
export function isGzip(body: Buffer): boolean {
  return body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b
}

async function httpGet(url: string, extra: ExtraCfg, cfg?: FetchSourceCfg): Promise<{ status: number; body: Buffer; finalUrl: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'User-Agent': extra.userAgent || 'clearndr-rules-hub/1.0 (rules updater)',
      ...cfg_basic(extra),
      // MISP: ключ REST API передаётся заголовком Authorization (без «Bearer»):
      //   Authorization: <authkey>
      ...(cfg?.authType === 'misp' && extra.mispAuthKey ? { Authorization: extra.mispAuthKey.trim() } : {}),
      // RST Cloud: ключ передаётся заголовком X-Api-Key (редирект на хранилище
      // фидов — pre-signed S3 — заголовок не наследует: undici снимает его
      // при cross-origin редиректе)
      ...(cfg?.authType === 'rstkey' && extra.rstApiKey ? { 'X-Api-Key': extra.rstApiKey.trim() } : {}),
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
  const head = body.subarray(0, 4000)
  // бинарное тело (gzip/тар и т.п.) расшифровке не подлежит — не выдаём бинарный мусор за «причину»
  let ctrl = 0
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) ctrl++
  if (head.length > 0 && ctrl / head.length > 0.1) return null
  const t = head.toString('utf8').trim()
  if (!t) return null
  // HTML-страница — обычно достаточно заголовка
  const title = t.match(/<title[^>]*>([\s\S]{3,200}?)<\/title>/i)
  if (title) return title[1].replace(/\s+/g, ' ').trim()
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

/** Ошибка «HTTP 200, но это не gzip-архив»: snort.org отдал HTML-страницу (лимит/неверная ссылка) и т.п. */
export function notArchiveError(status: number, body: Buffer, extra: ExtraCfg, url: string, isSnort: boolean): string {
  const reason = bodyReason(body)
  const hex = body.subarray(0, 8).toString('hex').match(/../g)?.join(' ') ?? ''
  let msg = `${isSnort ? 'snort.org' : 'источник'}: HTTP ${status} при загрузке ${url}, но получено не gzip-содержимое`
  msg += ` (первые байты: ${hex || 'пусто'}${reason ? `; страница: «${reason}»` : ''})`
  if (isSnort) {
    msg += '. Как правило это HTML-страница snort.org: лимит загрузок (registered — не чаще раза в 15 минут, '
      + 'community — ограничение по IP) либо ссылка из личного кабинета /downloads/… вместо канонической '
      + 'формы /reg-rules/<файл>/<oinkcode> (ссылки /downloads/… приводятся к ней автоматически)'
    msg += `; ${oinkcodeFingerprint(extra)}`
  }
  return msg
}

/** Человекочитаемая причина сетевого сбоя Node fetch («fetch failed», причина — в cause.code) */
export function netErrText(e: unknown, url: string): string {
  const err = e as Error & { cause?: { code?: string; message?: string } }
  let msg = err.message || 'ошибка загрузки'
  if (/fetch failed/i.test(msg)) {
    const code = err.cause?.code ?? ''
    const cause = err.cause?.message ?? ''
    msg = `сервер источника недоступен (fetch failed${code ? `, причина: ${code}` : ''}${cause ? ` — ${cause}` : ''})`
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET' || /timeout|ETIMEDOUT|ECONNRESET/i.test(`${code} ${cause}`)) {
      msg += ' — TCP-соединение не получило ответа: сервер источника перегружен/временно лежит; повторите «Обновить» позже. Для tarball-источников после первой удачной загрузки работает кэш-фолбэк'
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(`${code} ${cause}`)) {
      msg += ' — домен не резолвится: проверьте URL источника и DNS'
    } else if (/CERT|TLS|SSL/i.test(`${code} ${cause}`)) {
      msg += ' — ошибка TLS-рукопожатия: сертификат сервера недействителен или цепочка неполна'
    }
    msg += `; URL: ${maskAuthKey(url)}`
  }
  return msg
}

/** Все URL (основной + зеркала) не ответили: сводная ошибка по попыткам */
export function allAttemptsError(attemptErrors: string[], candidates: string[]): string {
  if (attemptErrors.length === 0) return 'источник недоступен'
  if (attemptErrors.length === 1) return attemptErrors[0]
  const mirrors = candidates.length - 1
  return `основной URL и ${mirrors > 1 ? 'зеркала' : 'зеркало'} недоступны (${attemptErrors.length} попытки):\n- ${attemptErrors.join('\n- ')}`
}

/** Короткая причина отказа tar (без «Command failed: tar -xzf /путь/...») */
function tarErrDetail(e: unknown): string {
  const err = e as { stderr?: unknown; message?: string }
  const raw = typeof err.stderr === 'string' ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : ''
  const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean)
  if (lines.length) return lines.slice(0, 3).join('; ')
  return (err.message ?? '').replace(/^Command failed:\s*/i, '').split('\n')[0].slice(0, 200)
}

async function extractTarball(tarPath: string, destDir: string, subPath?: string, exts: string[] = ['.rules']): Promise<string[]> {
  // чистим прошлую распаковку: при смене архива (обновление/зеркало с другой
  // структурой) старые файлы не должны смешиваться с новыми
  await fs.rm(destDir, { recursive: true, force: true })
  await fs.mkdir(destDir, { recursive: true })
  await execFileP('tar', ['-xzf', tarPath, '-C', destDir], { timeout: 180_000 })
  // ищем файлы нужных расширений (опционально только в указанном подкаталоге архива)
  const found: string[] = []
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (exts.some((ext) => e.name.toLowerCase().endsWith(ext))) {
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
async function extractCached(tarPath: string, destDir: string, subPath?: string, exts: string[] = ['.rules']): Promise<{ rules: ParsedRule[]; sizeBytes: number } | null> {
  const st = await fs.stat(tarPath).catch(() => null)
  if (!st) return null
  try {
    const found = await extractTarball(tarPath, destDir, subPath, exts)
    let rules: ParsedRule[] = []
    let size = 0
    for (const f of found) {
      const t = await fs.readFile(f, 'utf8')
      size += t.length
      rules.push(...parseArchiveText(t, f))
    }
    return { rules, sizeBytes: size }
  } catch {
    return null
  }
}

/** Разбор файла из архива — экспортирован для тестов:
 *  .rules — правила; текстовые списки (.txt/.list/.dat/.csv) — конвертация
 *  в правила по содержимому (Open NRD: список новых доменов → DNS-правила) */
export function parseArchiveText(text: string, fileName: string): ParsedRule[] {
  if (fileName.toLowerCase().endsWith('.rules')) return parseRuleText(text)
  // список индикаторов (по умолчанию домены; ip-листы тоже распознаются):
  // строки-домены/IP/URL без синтаксиса правил
  if (/^\s*alert\s+\w+\s/m.test(text)) return parseRuleText(text)
  const looksLikeIp = /^[\s]*\d{1,3}(?:\.\d{1,3}){3}[\s/$]/m.test(text)
  const conv = looksLikeIp ? convertIpList(text, { sidStart: 1100000 }) : convertDomainList(text, { sidStart: 1100000 })
  return conv.map((r) => toParsed(r))
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
    // основной URL + зеркала (extra.mirrorUrls): побеждает первый удачный ответ;
    // зеркальные URL тоже проходят applyAuth (плейсхолдер %%AUTHKEY%% и т.п.)
    const mirrors = (extra.mirrorUrls ?? []).map((m) => String(m).trim()).filter(Boolean)
    const candidates = [cfg.url, ...mirrors]
    const isSnort = /snort\.org/i.test(cfg.url)
    const attemptErrors: string[] = []

    if (cfg.kind === 'tarball') {
      const tarPath = path.join(CACHE_DIR, `src-${cfg.id}.tar.gz`)
      const destDir = path.join(CACHE_DIR, `src-${cfg.id}`)
      // расширения файлов внутри архива: .rules для наборов правил; для списков
      // (Open NRD и др.) — текстовые файлы со списками доменов/IP
      const listExts = ['.txt', '.list', '.dat', '.csv']
      const exts = cfg.category === 'ruleset' ? ['.rules'] : ['.rules', ...listExts]

      // свежий кэш (extra.cacheTtlMinutes, по умолчанию 0 = выкл): не дёргаем
      // источник чаще лимита (у snort.org registered — раз в 15 минут)
      const ttl = Number(extra.cacheTtlMinutes ?? 0)
      const st = await fs.stat(tarPath).catch(() => null)
      if (ttl > 0 && st && Date.now() - st.mtimeMs < ttl * 60_000) {
        const cached = await extractCached(tarPath, destDir, extra.subPath, exts)
        if (cached) {
          return {
            ok: true, rules: cached.rules, sizeBytes: cached.sizeBytes, usedCache: true,
            cacheNote: `использован свежий кэш архива от ${st.mtime.toISOString()} (cacheTtlMinutes=${ttl})`,
          }
        }
      }

      for (const cand of candidates) {
        let res: Awaited<ReturnType<typeof httpGet>>
        try {
          res = await httpGet(applyAuth(cand, cfg, extra), extra, cfg)
        } catch (e) {
          attemptErrors.push(netErrText(e, cand))
          continue
        }
        if (res.status !== 200) {
          attemptErrors.push(isSnort
            ? snortFetchError(res.status, res.body, extra, cand)
            : `HTTP ${res.status} при загрузке ${cand}${bodyReason(res.body) ? ` — «${bodyReason(res.body)}»` : ''}`)
          continue
        }
        // HTTP 200, но тело — не gzip (HTML-страница лимита/ошибки, ссылка из личного кабинета и т.п.):
        // раньше такое сохранялось как .tar.gz и ломало tar («not in gzip format»)
        if (!isGzip(res.body)) {
          attemptErrors.push(notArchiveError(res.status, res.body, extra, cand, isSnort))
          continue
        }
        await fs.mkdir(CACHE_DIR, { recursive: true })
        await fs.writeFile(tarPath, res.body)
        let found: string[]
        try {
          found = await extractTarball(tarPath, destDir, extra.subPath, exts)
        } catch (te) {
          return { ok: false, error: `архив скачан (${res.body.length} байт), но tar не смог его распаковать: ${tarErrDetail(te)}`, rules: [], sizeBytes: res.body.length }
        }
        let rules: ParsedRule[] = []
        let size = 0
        for (const f of found) {
          const t = await fs.readFile(f, 'utf8')
          size += t.length
          rules.push(...parseArchiveText(t, f))
        }
        return { ok: true, rules, sizeBytes: size }
      }

      // все URL недоступны: запасной путь — ранее скачанный архив,
      // работаем от него, источник помечаем предупреждением
      const cached = await extractCached(tarPath, destDir, extra.subPath, exts)
      if (cached) {
        return {
          ok: true, rules: cached.rules, sizeBytes: cached.sizeBytes, usedCache: true,
          cacheNote: `${attemptErrors[attemptErrors.length - 1] ?? 'источник недоступен'} — использован кэш архива от ${st?.mtime.toISOString() ?? '—'}`,
        }
      }
      return { ok: false, error: allAttemptsError(attemptErrors, candidates), rules: [], sizeBytes: 0 }
    }

    // ruleset / список — обычный текст
    for (const cand of candidates) {
      let res: Awaited<ReturnType<typeof httpGet>>
      try {
        res = await httpGet(applyAuth(cand, cfg, extra), extra, cfg)
      } catch (e) {
        attemptErrors.push(netErrText(e, cand))
        continue
      }
      if (res.status !== 200) {
        attemptErrors.push(isSnort
          ? snortFetchError(res.status, res.body, extra, cand)
          : `HTTP ${res.status} при загрузке ${cand}${bodyReason(res.body) ? ` — «${bodyReason(res.body)}»` : ''}`)
        continue
      }
      // RST Threat Feed и gzip-фиды: тело может быть gzip-файлом — распаковываем;
      // CSV-фид RST разбирается в колонку индикаторов до конвертации
      let text = maybeGunzip(res.body).toString('utf8')
      if (extra.rstFeed) {
        const parsed = parseRstFeedCsv(text, extra.rstFeed, { skipFpAlarm: extra.skipFpAlarm, minScore: extra.minScore, maxValues: extra.maxValues ?? 0 })
        text = parsed.values.join('\n')
      }
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
      if (cfg.category === 'hash-list') {
        const conv = convertHashList(text, convOpts(extra, cfg))
        return { ok: true, rules: conv.map((r) => toParsed(r)), sizeBytes: text.length }
      }
      // Zeek intel (TSV, Intel::ADDR/DOMAIN/URL) — конвертация в правила
      if (cfg.category === 'zeek-intel') {
        const conv = convertZeekIntel(text, convOpts(extra, cfg))
        return { ok: true, rules: conv.map((r) => toParsed(r)), sizeBytes: text.length }
      }
      // MISP attributes (JSON, restSearch) — конвертация в правила
      if (cfg.category === 'misp') {
        const conv = convertMispJson(text, convOpts(extra, cfg))
        return { ok: true, rules: conv.map((r) => toParsed(r)), sizeBytes: text.length }
      }
      return { ok: true, rules: parseRuleText(text), sizeBytes: text.length }
    }
    return { ok: false, error: allAttemptsError(attemptErrors, candidates), rules: [], sizeBytes: 0 }
  } catch (e) {
    // Node fetch сводит все сетевые сбои к «fetch failed»; причина — в cause.code
    return { ok: false, error: netErrText(e, cfg.url ?? ''), rules: [], sizeBytes: 0 }
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
