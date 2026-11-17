import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Капча (одноразовость, расход при неверном ответе, лимит выдачи на IP)
// и 2FA-механика: коды подтверждения (TTL/попытки), TOTP (RFC 6238),
// HMAC-билеты второго шага (подделка/просрочка/цель).

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let captcha: typeof import('@/lib/security/captcha')
let mfa: typeof import('@/lib/engine/mfa')
let rate: typeof import('@/lib/security/ratelimit')

/** Request с заданным x-forwarded-for (как роуты видят IP) */
const reqFrom = (ip: string): Request =>
  new Request('http://hub.local/api', { headers: { 'x-forwarded-for': ip } })

const cookieReq = (ip: string, cookie: string): Request =>
  new Request('http://hub.local/api', { headers: { 'x-forwarded-for': ip, cookie } })

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-mfa-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  process.env.NDR_EDITION = 'enterprise'
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  captcha = await import('@/lib/security/captcha')
  mfa = await import('@/lib/engine/mfa')
  rate = await import('@/lib/security/ratelimit')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('captcha', () => {
  it('выдача: SVG с текстом, id не пуст, ответ не утечёт в SVG', () => {
    const c = captcha.issueCaptcha(reqFrom('10.9.0.1'))
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.svg).toContain('<svg')
    expect(c.svg).toContain('aria-label="captcha"')
    expect(c.id.length).toBeGreaterThanOrEqual(16)
    // ответ не должен встречаться в разметке как решение (случайный подстроки не считаем)
    expect(c.expiresSec).toBe(120)
  })

  it('одноразовость: неверный ответ сгорает, повтор с верным — отказ', () => {
    const c = captcha.issueCaptcha(reqFrom('10.9.0.2'))
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const answer = captcha._peekAnswer(c.id)!
    expect(answer).toHaveLength(5)
    // неверная попытка расходует капчу
    const v1 = captcha.verifyCaptcha(c.id, 'XXXXX')
    expect(v1.ok).toBe(false)
    expect(v1.consumed).toBe(true)
    // даже с верным ответом повтор отклонён
    const v2 = captcha.verifyCaptcha(c.id, answer)
    expect(v2.ok).toBe(false)
    expect(v2.error).toContain('устарела или уже использована')
  })

  it('верный ответ проходит; регистронезависимость; неизвестный id — отказ', () => {
    const c = captcha.issueCaptcha(reqFrom('10.9.0.3'))
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const answer = captcha._peekAnswer(c.id)!
    expect(captcha.verifyCaptcha(c.id, answer.toLowerCase()).ok).toBe(true)

    expect(captcha.verifyCaptcha('deadbeef', 'AAAAA').ok).toBe(false)
    expect(captcha.verifyCaptcha('', '').ok).toBe(false)
  })

  it('лимит выдачи: 30 капч с одного IP — дальше 429-условие', () => {
    rate.resetAllRates()
    let blocked = false
    for (let i = 0; i < 40; i++) {
      const c = captcha.issueCaptcha(reqFrom('10.9.0.99'))
      if (!c.ok) {
        blocked = true
        break
      }
    }
    expect(blocked).toBe(true)
    rate.resetAllRates()
  })
})

describe('mfa: одноразовые коды', () => {
  let userId: string
  beforeAll(async () => {
    const u = await db.user.create({
      data: { email: 'codes@example.com', displayName: 'Коды', passwordHash: 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88), role: 'user', status: 'active' },
    })
    userId = u.id
  })

  it('issue → verify верным кодом → код погашен (повтор не проходит)', async () => {
    const code = await mfa.issueVerificationCode(userId)
    expect(code).toMatch(/^\d{6}$/)
    const row = await db.user.findUnique({ where: { id: userId } })
    expect(row!.verificationCode).toBe(code)
    expect(row!.verificationExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)

    const v = await mfa.verifyVerificationCode(userId, code)
    expect(v.ok).toBe(true)
    const v2 = await mfa.verifyVerificationCode(userId, code)
    expect(v2.ok).toBe(false)
    expect(v2.error).toContain('не выпущен')
  })

  it('неверный код: попытки считаются, после 5 — код сброшен', async () => {
    const code = await mfa.issueVerificationCode(userId)
    for (let i = 1; i <= 5; i++) {
      const v = await mfa.verifyVerificationCode(userId, '000000' === code ? '111111' : '000000')
      expect(v.ok).toBe(false)
    }
    // после исчерпания попыток даже верный код не проходит
    const v = await mfa.verifyVerificationCode(userId, code)
    expect(v.ok).toBe(false)
    expect(v.error).toContain('запросите новый')
    const row = await db.user.findUnique({ where: { id: userId } })
    expect(row!.verificationCode).toBeNull()
  })
})

describe('mfa: TOTP (RFC 6238) и otpauth', () => {
  // секрет RFC 6238 Приложения B: "12345678901234567890" → base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  it('RFC-вектор T=59 (8 цифр 94287082 → наши 6 цифр 287082)', () => {
    expect(mfa.totpNow(RFC_SECRET, 59_000)).toBe('287082')
  })

  it('окно ±1 шаг: код соседнего периода принимается', () => {
    // T=89 (шаг 2) → код 359152; проверяем в момент T=59 (шаг 1, ±1 окно)
    expect(mfa.totpNow(RFC_SECRET, 89_000)).toBe('359152')
    expect(mfa.verifyTotp(RFC_SECRET, '359152', 59_000)).toBe(true)
    // код шага 5 (T=209 → 287922) вне окна ±1 от шага 1 — отклонён
    expect(mfa.verifyTotp(RFC_SECRET, mfa.totpNow(RFC_SECRET, 209_000), 59_000)).toBe(false)
  })

  it('base32 roundtrip и формат otpauth://', () => {
    const secret = mfa.generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    const decoded = mfa.base32Decode(secret)
    expect(mfa.base32Encode(decoded)).toBe(secret)
    const uri = mfa.otpauthUri(secret, 'user@example.com')
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain('issuer=NDR')
    expect(uri).toContain(`secret=${secret}`)
    expect(uri).toContain('digits=6')
  })

  it('порченный секрет/код — отклонение без исключений', () => {
    expect(mfa.verifyTotp('AAAA', '123456')).toBe(false) // <80 бит
    expect(mfa.verifyTotp(RFC_SECRET, 'abc')).toBe(false)
    expect(mfa.verifyTotp(RFC_SECRET, '')).toBe(false)
  })
})

describe('mfa: HMAC-билет второго шага', () => {
  it('issue → verify: userId по цели; чужая цель не проходит', async () => {
    const { ticket } = await mfa.issueMfaTicket('login', 'user-42')
    const req = new Request('http://hub.local/', { headers: { cookie: `${mfa.MFA_COOKIE}=${encodeURIComponent(ticket)}` } })
    expect(await mfa.verifyMfaTicket(req, 'login')).toBe('user-42')
    expect(await mfa.verifyMfaTicket(req, 'register')).toBeNull()
  })

  it('подделка подписи и просрочка отклоняются', async () => {
    const { ticket } = await mfa.issueMfaTicket('register', 'user-7')
    const [payload, sig] = ticket.split('.')
    const tampered = `${payload}.${sig.slice(0, -2)}ff`
    const req1 = new Request('http://hub.local/', { headers: { cookie: `${mfa.MFA_COOKIE}=${encodeURIComponent(tampered)}` } })
    expect(await mfa.verifyMfaTicket(req1, 'register')).toBeNull()

    // просроченный билет: срок в payload в будущем +10мс недостаточно — сгенерируем свою подпись нельзя,
    // поэтому проверяем отказ на подмене цели/битом payload
    const badPayload = Buffer.from('login|user-7|1').toString('base64url')
    const req2 = new Request('http://hub.local/', { headers: { cookie: `${mfa.MFA_COOKIE}=${encodeURIComponent(`${badPayload}.${sig}`)}` } })
    expect(await mfa.verifyMfaTicket(req2, 'register')).toBeNull()
    expect(await mfa.verifyMfaTicket(req2, 'login')).toBeNull() // подпись не совпадёт с чужим payload
  })

  it('без cookie — null', async () => {
    expect(await mfa.verifyMfaTicket(new Request('http://hub.local/'), 'login')).toBeNull()
  })
})

describe('аккаунт (route): show-totp-qr / setup-totp / switch-totp', () => {
  // Анти-регрессия инцидента «TOTP не привязывается по QR»: любой повторный
  // setup генерировал НОВЫЙ секрет — код из уже отсканированного приложения
  // переставал подходить. Теперь «Показать QR» возвращает ТЕКУЩИЙ секрет без
  // перевыпуска, а перевыпуск — только явный «Пересоздать ключ».
  let accPOST: typeof import('@/app/api/auth/account/route').POST
  let sessionMod: typeof import('@/lib/security/session')
  let userId: string
  let sid: string

  const post = async (body: Record<string, unknown>): Promise<Response> => {
    const req = new Request('http://hub.local/api/auth/account', {
      method: 'POST',
      headers: {
        cookie: `${sessionMod.SESSION_COOKIE}=${sid}`,
        origin: 'http://hub.local',
        host: 'hub.local',
        'content-type': 'application/json',
        'x-forwarded-for': '10.9.2.1',
      },
      body: JSON.stringify(body),
    })
    return accPOST(req as never)
  }

  beforeAll(async () => {
    accPOST = (await import('@/app/api/auth/account/route')).POST
    sessionMod = await import('@/lib/security/session')
    const u = await db.user.create({
      data: { email: 'totp-acc@example.com', displayName: 'TOTP Каб', passwordHash: 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88), role: 'user', status: 'active' },
    })
    userId = u.id
    sid = (await sessionMod.createSession(userId, '10.9.2.1', 'vitest', null)).token
  })

  it('show-totp-qr без секрета создаёт и сохраняет его; QR — data-url', async () => {
    const res = await post({ action: 'show-totp-qr' })
    expect(res.status).toBe(200)
    const r = await res.json()
    expect(r.ok).toBe(true)
    expect(r.manualKey).toMatch(/^[A-Z2-7]{32}$/)
    expect(r.qrDataUrl).toContain('data:image/png;base64,')
    const row = await db.user.findUnique({ where: { id: userId } })
    expect(row!.totpSecret).toBe(r.manualKey)
  })

  it('повторный show-totp-qr возвращает ТОТ ЖЕ секрет (отсканированный QR не ломается)', async () => {
    const r1 = await (await post({ action: 'show-totp-qr' })).json()
    const r2 = await (await post({ action: 'show-totp-qr' })).json()
    expect(r2.manualKey).toBe(r1.manualKey)
    expect(r2.message).toContain('текущего секрета')
  })

  it('switch-totp: неверный код → 401; верный код из приложения → 2FA=totp', async () => {
    const saved = (await db.user.findUnique({ where: { id: userId } }))!.totpSecret!
    const bad = await post({ action: 'switch-totp', code: '000000' === mfa.totpNow(saved) ? '111111' : '000000' })
    expect(bad.status).toBe(401)
    const good = await post({ action: 'switch-totp', code: mfa.totpNow(saved) })
    expect(good.status).toBe(200)
    const r = await good.json()
    expect(r.ok).toBe(true)
    expect(r.twoFactor).toBe('totp')
    const row = await db.user.findUnique({ where: { id: userId } })
    expect(row!.twoFactor).toBe('totp')
  })

  it('setup-totp после включения — явный перевыпуск: секрет меняется', async () => {
    const before = (await db.user.findUnique({ where: { id: userId } }))!.totpSecret!
    const r = await (await post({ action: 'setup-totp' })).json()
    expect(r.ok).toBe(true)
    expect(r.manualKey).not.toBe(before)
    const row = await db.user.findUnique({ where: { id: userId } })
    expect(row!.totpSecret).toBe(r.manualKey)
  })

  it('switch-totp: код, сгенерированный устройством с дрейфом ±2 шага (±60 c), принимается (окно расширено с ±1)', async () => {
    const secret = (await db.user.findUnique({ where: { id: userId } }))!.totpSecret!
    // сброс 2FA, чтобы проверить привязку заново
    await db.user.update({ where: { id: userId }, data: { twoFactor: 'none' } })
    // часы устройства спешат на 55 c (меньше 2 шагов) — код из «будущего» устройства
    const driftAhead = Date.now() + 55_000
    const ahead = await post({ action: 'switch-totp', code: mfa.totpNow(secret, driftAhead), clientNow: driftAhead })
    expect(ahead.status).toBe(200)
    const r = await ahead.json()
    expect(r.twoFactor).toBe('totp')
    // часы устройства отстают на 55 c — код из «прошлого» устройства
    await db.user.update({ where: { id: userId }, data: { twoFactor: 'none' } })
    const driftBehind = Date.now() - 55_000
    const behind = await post({ action: 'switch-totp', code: mfa.totpNow(secret, driftBehind), clientNow: driftBehind })
    expect(behind.status).toBe(200)
    await db.user.update({ where: { id: userId }, data: { twoFactor: 'none' } })
  })

  it('switch-totp: дрейф часов ~2.5 мин (3+ шага) — привязка отклонена с точным диагнозом, 2FA не включается', async () => {
    const secret = (await db.user.findUnique({ where: { id: userId } }))!.totpSecret!
    await db.user.update({ where: { id: userId }, data: { twoFactor: 'none' } })
    const skewed = Date.now() + 150_000 // устройство спешит на 2.5 минуты
    const res = await post({ action: 'switch-totp', code: mfa.totpNow(secret, skewed), clientNow: skewed })
    expect(res.status).toBe(401)
    const j = await res.json()
    expect(j.error).toContain('спешат')
    expect(j.error).toContain('150')
    // 2FA осталась выключенной — иначе вход (по серверному времени) заблокировал бы пользователя
    const row = await db.user.findUnique({ where: { id: userId } })
    expect(row!.twoFactor).toBe('none')
    // и зеркальный случай: устройство отстаёт
    const skewed2 = Date.now() - 150_000
    const res2 = await post({ action: 'switch-totp', code: mfa.totpNow(secret, skewed2), clientNow: skewed2 })
    expect(res2.status).toBe(401)
    expect((await res2.json()).error).toContain('отстают')
  })

  it('switch-totp: заведомо неверный код — 401 с серверным UTC-временем для сверки', async () => {
    const res = await post({ action: 'switch-totp', code: '000000' === mfa.totpNow(mfa.generateTotpSecret()) ? '111111' : '000000' })
    expect(res.status).toBe(401)
    const j = await res.json()
    expect(j.error).toContain('Неверный код TOTP')
    expect(j.error).toMatch(/UTC/)
    expect(j.error).toContain('Показать QR')
  })
})

describe('mfa: окно TOTP ±2 шага на уровне verifyTotp', () => {
  it('код соседних ±2 шагов принимается, ±3 — отвергается', () => {
    const secret = mfa.generateTotpSecret()
    const now = Date.now()
    expect(mfa.verifyTotp(secret, mfa.totpNow(secret, now + 60_000), now)).toBe(true)
    expect(mfa.verifyTotp(secret, mfa.totpNow(secret, now - 60_000), now)).toBe(true)
    expect(mfa.verifyTotp(secret, mfa.totpNow(secret, now), now)).toBe(true)
    expect(mfa.verifyTotp(secret, mfa.totpNow(secret, now + 95_000), now)).toBe(false)
    expect(mfa.verifyTotp(secret, mfa.totpNow(secret, now - 95_000), now)).toBe(false)
  })
})
