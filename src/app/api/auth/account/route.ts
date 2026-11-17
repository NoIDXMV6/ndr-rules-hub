// GET/POST /api/auth/account — личный кабинет (только Enterprise): управление
// двухфакторной аутентификацией своей учётной записи.
//   POST {action:'save-telegram', username}   — сохранить @username (чат отвяжется до /start)
//   POST {action:'send-telegram-code'}        — выпустить и отправить код (или подсказать /start)
//   POST {action:'switch-telegram', code}     — подтвердить кодом и включить 2FA=telegram
//   POST {action:'show-totp-qr'}              — QR/ключ для СУЩЕСТВУЮЩЕГО секрета (нет — создать);
//                                               повторный показ НЕ инвалидирует отсканированный QR
//   POST {action:'setup-totp'}                — ПЕРЕВЫПУСК секрета (старый QR/ключ перестают
//                                               действовать — после нужен повторный скан)
//   POST {action:'switch-totp', code}         — подтвердить кодом и включить 2FA=totp
//   POST {action:'disable-2fa', password}     — выключить 2FA (нужен пароль)
//   POST {action:'send-test'}                 — тестовое сообщение в привязанный чат
// Смена метода требует успешного подтверждения кодом нового метода —
// пользователь не может заблокировать сам себя неверной настройкой.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireMultiUser, jsonError, sameOriginOk, guard } from '@/lib/security/guard'
import { verifyPassword } from '@/lib/security/password'
import { clientIp, rateLimit } from '@/lib/security/ratelimit'
import { issueVerificationCode, verifyVerificationCode, verifyTotp, generateTotpSecret, otpauthUri, totpQrDataUrl } from '@/lib/engine/mfa'
import { sendTelegramText, getBotUsername, botDeepLink } from '@/lib/engine/telegram'
import { audit } from '@/lib/security/audit'

export const dynamic = 'force-dynamic'

const TG_USER_RE = /^[a-zA-Z0-9_]{4,32}$/
const ACTION_RULE = { limit: 20, windowMs: 5 * 60_000, blockMs: 10 * 60_000 }

export async function GET(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate
  const g = await guard(req, {})
  if (g instanceof NextResponse) return g
  try {
    const u = await db.user.findUnique({ where: { id: g.user!.id } })
    if (!u) return jsonError(404, 'Пользователь не найден')
    const bot = await getBotUsername().catch(() => null)
    return NextResponse.json({
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      status: u.status,
      twoFactor: u.twoFactor,
      telegramUsername: u.telegramUsername,
      telegramBound: !!u.telegramChatId,
      totpEnabled: !!u.totpSecret,
      botLink: botDeepLink(bot),
    })
  } catch (e) {
    return jsonError(500, (e as Error).message)
  }
}

export async function POST(req: NextRequest) {
  const gate = requireMultiUser()
  if (gate) return gate
  const g = await guard(req, {})
  if (g instanceof NextResponse) return g
  const ip = clientIp(req)
  if (!sameOriginOk(req)) return jsonError(403, 'Запрос с чужого источника запрещён (CSRF-защита)')
  const rl = rateLimit(`account:${g.user!.id}`, ACTION_RULE)
  if (!rl.ok) return NextResponse.json({ error: 'Слишком много действий — повторите позже' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } })

  const body = await req.json().catch(() => ({})) as { action?: string; username?: string; code?: string; password?: string; clientNow?: number }
  const user = await db.user.findUnique({ where: { id: g.user!.id } })
  if (!user) return jsonError(404, 'Пользователь не найден')

  switch (body.action) {
    case 'save-telegram': {
      const username = String(body.username ?? '').trim().replace(/^@/, '').toLowerCase()
      if (!TG_USER_RE.test(username)) return jsonError(400, 'Username Telegram: 4–32 символа (буквы, цифры, подчёркивания)')
      const taken = await db.user.findFirst({ where: { telegramUsername: username, id: { not: user.id } }, select: { id: true } })
      if (taken) return jsonError(400, 'Этот Telegram-username уже привязан к другой учётной записи')
      await db.user.update({ where: { id: user.id }, data: { telegramUsername: username, telegramChatId: null } })
      void audit('telegram_username', { email: user.email, userId: user.id, ip, detail: `сохранён @${username} — ждём /start боту` })
      const bot = await getBotUsername().catch(() => null)
      return NextResponse.json({ ok: true, telegramUsername: username, telegramBound: false, botLink: botDeepLink(bot), message: 'Username сохранён. Откройте бота и отправьте /start — чат привяжется, код придёт автоматически' })
    }

    case 'send-telegram-code': {
      if (!user.telegramUsername) return jsonError(400, 'Сначала сохраните username Telegram')
      const code = await issueVerificationCode(user.id)
      if (!user.telegramChatId) {
        const bot = await getBotUsername().catch(() => null)
        return NextResponse.json({ ok: true, sent: false, telegramBound: false, botLink: botDeepLink(bot), message: 'Код выпущен. Откройте бота и отправьте /start — он придёт в чат автоматически' })
      }
      const sent = await sendTelegramText(user.telegramChatId, `Код подтверждения NDR Rules Hub: ${code}\n(действует 5 минут)`)
      return sent.ok
        ? NextResponse.json({ ok: true, sent: true, telegramBound: true, message: 'Код отправлен в Telegram' })
        : NextResponse.json({ ok: false, error: `Бот не смог доставить сообщение: ${sent.error}` }, { status: 502 })
    }

    case 'switch-telegram': {
      if (!user.telegramUsername) return jsonError(400, 'Сначала сохраните username Telegram')
      const v = await verifyVerificationCode(user.id, String(body.code ?? ''))
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 401 })
      if (!user.telegramChatId) return jsonError(400, 'Чат не привязан — отправьте боту /start и повторите')
      await db.user.update({ where: { id: user.id }, data: { twoFactor: 'telegram' } })
      void audit('2fa_change', { email: user.email, userId: user.id, ip, detail: 'метод: telegram' })
      return NextResponse.json({ ok: true, twoFactor: 'telegram', message: 'Двухфакторная аутентификация через Telegram включена' })
    }

    case 'setup-totp': {
      // ЯВНЫЙ перевыпуск: старый секрет и отсканированный по нему QR перестают действовать
      const secret = generateTotpSecret()
      await db.user.update({ where: { id: user.id }, data: { totpSecret: secret } })
      const uri = otpauthUri(secret, user.email)
      const qr = await totpQrDataUrl(uri).catch(() => null)
      void audit('2fa_change', { email: user.email, userId: user.id, ip, detail: 'секрет TOTP перевыпущен (старый недействителен)' })
      return NextResponse.json({ ok: true, otpauth: uri, qrDataUrl: qr, manualKey: secret, message: 'Секрет перевыпущен — предыдущий QR и ключ больше не действуют. Отсканируйте новый QR и введите текущий код для включения' })
    }

    case 'show-totp-qr': {
      // Показ QR для текущего секрета БЕЗ перевыпуска: если пользователь потерял
      // картинку (переключил вкладку/перезагрузил страницу), повторный показ не
      // инвалидирует уже отсканированный QR — раньше любой повторный «setup»
      // генерировал НОВЫЙ секрет, и код из приложения переставал подходить.
      const secret = user.totpSecret ?? generateTotpSecret()
      if (!user.totpSecret) {
        await db.user.update({ where: { id: user.id }, data: { totpSecret: secret } })
        void audit('2fa_change', { email: user.email, userId: user.id, ip, detail: 'сгенерирован новый секрет TOTP' })
      }
      const uri = otpauthUri(secret, user.email)
      const qr = await totpQrDataUrl(uri).catch(() => null)
      return NextResponse.json({ ok: true, otpauth: uri, qrDataUrl: qr, manualKey: secret, message: user.totpSecret ? 'QR для текущего секрета — код из приложения подойдёт' : 'Секрет создан. Отсканируйте QR и введите текущий код для включения' })
    }

    case 'switch-totp': {
      if (!user.totpSecret) return jsonError(400, 'Сначала настройте TOTP (создайте секрет)')
      const code = String(body.code ?? '')
      // 1) Проверка по СЕРВЕРНОМУ времени (окно ±2 шага = ±60 c). Привязка возможна
      //    только если код верен по серверным часам — иначе при входе (который всегда
      //    проверяет по серверному времени) пользователь заблокирует сам себя.
      if (verifyTotp(user.totpSecret, code)) {
        await db.user.update({ where: { id: user.id }, data: { twoFactor: 'totp' } })
        void audit('2fa_change', { email: user.email, userId: user.id, ip, detail: 'метод: totp' })
        return NextResponse.json({ ok: true, twoFactor: 'totp', message: 'Двухфакторная аутентификация через TOTP включена' })
      }
      // 2) Диагностика расхождения часов: если код верен по времени УСТРОЙСТВА, но не
      //    сервера — говорим ровно об этом (а не про «неверный код») и не включаем 2FA.
      const serverNow = Date.now()
      const clientNow = typeof body.clientNow === 'number' && Number.isFinite(body.clientNow) ? body.clientNow : null
      if (
        clientNow !== null &&
        Math.abs(serverNow - clientNow) > 30_000 &&
        verifyTotp(user.totpSecret, code, clientNow)
      ) {
        const driftSec = Math.round((clientNow - serverNow) / 1000)
        const dir = driftSec > 0 ? 'спешат' : 'отстают'
        void audit('2fa_change', { email: user.email, userId: user.id, ip, detail: `привязка TOTP отклонена: часы устройства ${dir} на ~${Math.abs(driftSec)} с` })
        return NextResponse.json({
          error: `Часы устройства, где запущено приложение-аутентификатор, ${dir} от серверных примерно на ${Math.abs(driftSec)} с. Включите в устройстве автоматическую синхронизацию времени (NTP) и повторите привязку — иначе вход по TOTP не будет работать.`,
        }, { status: 401 })
      }
      // 3) Обычная ошибка: подсказка для сверки времени с точным серверным UTC
      const serverUtc = new Date().toUTCString()
      void audit('2fa_change', { email: user.email, userId: user.id, ip, detail: 'привязка TOTP: неверный код' })
      return NextResponse.json({
        error: `Неверный код TOTP. Сверьте: 1) время сервера (UTC): ${serverUtc} — время на устройстве с приложением должно совпадать с ним с точностью до минуты; 2) в приложении именно текущий секрет (после «Пересоздать ключ» нужен повторный скан — нажмите «Показать QR» и сверьте ключ вручную); 3) код должен быть самым свежим — подождите смены цифр и введите заново.`,
      }, { status: 401 })
    }

    case 'disable-2fa': {
      if (!verifyPassword(String(body.password ?? ''), user.passwordHash)) {
        void audit('login_fail', { email: user.email, userId: user.id, ip, detail: 'отключение 2FA: неверный пароль' })
        return NextResponse.json({ error: 'Неверный пароль' }, { status: 401 })
      }
      await db.user.update({
        where: { id: user.id },
        data: { twoFactor: 'none', totpSecret: null, verificationCode: null, verificationExpiresAt: null, verificationAttempts: 0 },
      })
      void audit('2fa_change', { email: user.email, userId: user.id, ip, detail: '2FA отключена (пароль подтверждён)' })
      return NextResponse.json({ ok: true, twoFactor: 'none', message: 'Двухфакторная аутентификация выключена' })
    }

    case 'send-test': {
      if (!user.telegramChatId) return jsonError(400, 'Чат не привязан — отправьте боту /start')
      const sent = await sendTelegramText(user.telegramChatId, 'Тестовое сообщение NDR Rules Hub — канал 2FA работает.')
      return sent.ok
        ? NextResponse.json({ ok: true, message: 'Тестовое сообщение отправлено — проверьте Telegram' })
        : NextResponse.json({ ok: false, error: sent.error }, { status: 502 })
    }

    default:
      return jsonError(400, 'action: save-telegram | send-telegram-code | switch-telegram | setup-totp | switch-totp | disable-2fa | send-test')
  }
}
