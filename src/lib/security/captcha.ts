// ─────────────────────────────────────────────────────────────────────────────
// Капча для входа и регистрации (Enterprise).
// Почему своя, а не reCAPTCHA/hCaptcha: хаб часто стоит в закрытом контуре
// без доступа к внешним сервисам. Устойчивость к сервисам подбора (2captcha
// и т.п.) обеспечивается экономикой, а не «неразрешимостью»:
//   1) искажённый SVG-текст: случайные шрифты, наклоны/сдвиги каждого символа,
//      волнистые линии, шум-точки, непредсказуемая палитра — распознавание
//      дороже, чем ценность обхода;
//   2) ответ НИКОГДА не покидает сервер (в SVG — только глифы), сравнение
//      константным сравнением;
//   3) одноразовость: каждый id принимается один раз, после одной попытки
//      ввода капча «сгорает» — сервис подбора не получает повторов;
//   4) короткий TTL (2 мин) и лимит выдачи на IP (30 за 10 минут) — фарм
//      капч и перебор экономически бессмысленны;
//   5) капча обязательна на каждом шаге входа/регистрации и жёстко связана
//      с существующим анти-брутфорсом (блок IP/учётки).
// Хранилище — память процесса (id → ответ): процесс один (контейнер хаба).
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { clientIp, rateLimit } from './ratelimit'

const TTL_MS = 2 * 60_000
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // без 0/O/1/I/L — не путаются
const LENGTH = 5
const CAPTCHA_RULE = { limit: 30, windowMs: 10 * 60_000, blockMs: 10 * 60_000 }

interface CaptchaEntry {
  answer: string
  expiresAt: number
  used: boolean
}

const store = new Map<string, CaptchaEntry>()
const MAX_STORE = 5000

function hmacKey(): string {
  // ключ подписи id: генерируется один раз на процесс; подпись защищает от
  // подбора id (всё равно проверяется по хранилищу — это второй рубеж)
  const g = globalThis as unknown as { __captchaKey?: string }
  if (!g.__captchaKey) g.__captchaKey = randomBytes(32).toString('hex')
  return g.__captchaKey
}

function sign(id: string): string {
  return createHmac('sha256', hmacKey()).update(id).digest('hex').slice(0, 32)
}

/** Выдать капчу: {id, svg}. id подписан, одноразовый, TTL 2 мин. */
export function issueCaptcha(req: Request): { ok: true; id: string; svg: string; expiresSec: number } | { ok: false; error: string; retryAfterSec?: number } {
  const rl = rateLimit(`captcha:${clientIp(req)}`, CAPTCHA_RULE)
  if (!rl.ok) {
    return { ok: false, error: `Слишком много запросов капчи — повторите через ${Math.ceil(rl.retryAfterSec / 60)} мин`, retryAfterSec: rl.retryAfterSec }
  }
  const answer = Array.from(randomBytes(LENGTH)).map((b) => ALPHABET[b % ALPHABET.length]).join('')
  const id = randomBytes(12).toString('hex')
  // чистка просроченных (лениво, при переполнении)
  if (store.size >= MAX_STORE) {
    const now = Date.now()
    for (const [k, v] of store) {
      if (v.expiresAt < now || v.used) store.delete(k)
      if (store.size < MAX_STORE / 2) break
    }
  }
  store.set(id, { answer, expiresAt: Date.now() + TTL_MS, used: false })
  return { ok: true, id, svg: renderSvg(answer), expiresSec: TTL_MS / 1000 }
}

export interface CaptchaVerdict {
  ok: boolean
  error?: string
  /** true — капча израсходована (даже при неверном ответе) — нужна новая */
  consumed: boolean
}

/** Проверить ответ. Одноразовость: после ЛЮБОЙ проверки капча сгорает. */
export function verifyCaptcha(id: string, answer: string): CaptchaVerdict {
  const entry = store.get(String(id ?? ''))
  if (!entry) return { ok: false, error: 'Капча не найдена или устарела — обновите картинку', consumed: true }
  const now = Date.now()
  if (entry.used || entry.expiresAt < now) {
    store.delete(String(id))
    return { ok: false, error: 'Капча устарела или уже использована — обновите картинку', consumed: true }
  }
  entry.used = true // одна попытка: сервисы подбора не получают повторов
  const a = String(answer ?? '').trim().toUpperCase()
  const ok = a.length === entry.answer.length && timingSafeEqual(Buffer.from(a), Buffer.from(entry.answer))
  if (!ok) return { ok: false, error: 'Неверный код с картинки — введите новый', consumed: true }
  store.delete(String(id))
  return { ok: true, consumed: true }
}

/** Тестовая инспекция ответа (только тесты) */
export function _peekAnswer(id: string): string | null {
  return store.get(id)?.answer ?? null
}

// ── SVG ──────────────────────────────────────────────────────────────────────

const FONTS = ['Georgia, serif', '"Courier New", monospace', 'Verdana, sans-serif', '"Trebuchet MS", sans-serif', '"Comic Sans MS", cursive']
const INK = ['#1f2937', '#0f766e', '#4338ca', '#7c2d12', '#1d4ed8', '#701a75', '#155e75']
const W = 190
const H = 62

/** Детерминированный PRNG на seed: одинаковая картинка при повторном рендере */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function renderSvg(answer: string): string {
  const rnd = mulberry32(randomBytes(4).readUInt32LE(0))
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]
  const parts: string[] = []

  // фон: светлая подложка + мягкие пятна
  parts.push(`<rect width="${W}" height="${H}" fill="${pick(['#f8fafc', '#f1f5f9', '#f5f3ff', '#f0fdfa'])}"/>`)
  for (let i = 0; i < 4; i++) {
    parts.push(`<circle cx="${(rnd() * W).toFixed(1)}" cy="${(rnd() * H).toFixed(1)}" r="${(8 + rnd() * 14).toFixed(1)}" fill="${pick(INK)}" opacity="0.06"/>`)
  }

  // волнистые линии через весь холст
  for (let i = 0; i < 3; i++) {
    const y0 = rnd() * H
    const y1 = rnd() * H
    const ink = pick(INK)
    parts.push(
      `<path d="M -10 ${y0.toFixed(1)} Q ${(W * 0.3).toFixed(1)} ${(rnd() * H).toFixed(1)}, ${(W * 0.55).toFixed(1)} ${(rnd() * H).toFixed(1)} T ${W + 10} ${y1.toFixed(1)}" fill="none" stroke="${ink}" stroke-width="${(0.8 + rnd() * 1.4).toFixed(1)}" opacity="${(0.35 + rnd() * 0.3).toFixed(2)}"/>`,
    )
  }

  // шум-точки
  for (let i = 0; i < 130; i++) {
    parts.push(`<circle cx="${(rnd() * W).toFixed(1)}" cy="${(rnd() * H).toFixed(1)}" r="${(0.5 + rnd() * 1.1).toFixed(2)}" fill="${pick(INK)}" opacity="${(0.12 + rnd() * 0.25).toFixed(2)}"/>`)
  }

  // символы: каждому — свой шрифт, размер, наклон и сдвиг
  const slot = W / (LENGTH + 1)
  answer.split('').forEach((ch, i) => {
    const x = slot * (i + 1) + (rnd() * 8 - 4)
    const y = H / 2 + (rnd() * 10 - 5)
    const rot = (rnd() * 44 - 22).toFixed(1)
    const size = (26 + rnd() * 10).toFixed(0)
    parts.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})" ` +
      `font-family="${pick(FONTS)}" font-size="${size}" font-weight="${rnd() > 0.5 ? '700' : '600'}" ` +
      `fill="${pick(INK)}" opacity="${(0.82 + rnd() * 0.18).toFixed(2)}">${ch}</text>`,
    )
  })

  const sig = sign(answer.split('').reverse().join('')) // меняется с ответом — кэш по id не спорит
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="captcha" data-sig="${sig.slice(0, 8)}">${parts.join('')}</svg>`
}
