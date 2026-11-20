// ─────────────────────────────────────────────────────────────────────────────
// Автоматическое поднятие WireGuard-туннеля (v1.33.0).
// Переключатель «Автоматическое поднятие тунеля» (настройка wgAutoUp, вкладка
// «WireGuard VPN»): при старте контейнера — из instrumentation.ts (один раз на
// процесс, с паузой, чтобы сервер успел начать слушать порт) — проверяется
// доступность конфигурации и туннель поднимается:
//   1) конфигурация = сохранённый профиль в БД (VpnProfile): сначала помеченный
//      active (последний поднятый), затем первый созданный;
//   2) конфиг валиден (parseWgConfig: [Interface]/PrivateKey/[Peer]);
//   3) интерфейс ещё не поднят (wg show interfaces) — после рестарта процесса
//      без пересоздания контейнера туннель остаётся жить, повторный up не нужен.
// Результат — в журнал (scope vpn) и уведомления Telegram/Gotify (notifyOnVpn).
// Ошибки окружения (нет /dev/net/tun, NET_ADMIN, недостижим endpoint) отдаёт
// сам wg-quick — они попадают в журнал, уведомление и последний статус профиля.
// Тот же механизм вызывается при включении переключателя в UI («поднять сейчас»).
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { getSetting, log } from './service'
import { notifyEvent } from './notify'
import { parseWgConfig, wgStatus, wgUp } from './vpn'

const AUTOUP_DELAY_MS = 7_000

const g = globalThis as unknown as { __wgAutoUpStarted?: boolean }

export type AutoUpOrigin = 'start' | 'manual'

export interface AutoUpResult {
  ok: boolean
  /** ничего не поднимали: выключено переключателем / уже поднят / нет конфига */
  skipped?: boolean
  detail: string
  notes?: string[]
}

/** Поднять туннель автоматически: проверка конфигурации → wg-quick up → журнал/уведомление */
export async function autoUpVpn(origin: AutoUpOrigin = 'manual'): Promise<AutoUpResult> {
  const enabled = (await getSetting('wgAutoUp')) === 'true'
  if (!enabled) {
    await log('info', 'vpn', 'Автоподнятие туннеля не выполнялось: переключатель «Автоматическое поднятие тунеля» выключен', undefined, 'WireGuard auto-up skipped: the auto-up toggle is off')
    return { ok: false, skipped: true, detail: 'переключатель выключен' }
  }
  // 1) доступность конфигурации: сохранённый профиль в БД
  const profiles = await db.vpnProfile.findMany({ orderBy: [{ active: 'desc' }, { createdAt: 'asc' }] })
  const p = profiles[0]
  if (!p) {
    const msg = 'Автоподнятие туннеля не выполнено: конфигурация WireGuard не найдена — сохраните профиль на вкладке «WireGuard VPN»'
    await log('warn', 'vpn', msg, undefined, 'WireGuard auto-up skipped: no saved profile')
    return { ok: false, skipped: true, detail: msg }
  }
  // 2) конфиг валиден
  const parsed = parseWgConfig(p.config)
  const iface = parsed.ok ? parsed.iface ?? p.name : p.name
  if (!parsed.ok) {
    const msg = `Автоподнятие туннеля не выполнено: конфигурация «${p.name}» некорректна (${parsed.error})`
    await log('error', 'vpn', msg, undefined, `WireGuard auto-up failed: invalid config "${p.name}"`)
    void notifyEvent('vpn', 'error', 'Автоподнятие туннеля: конфигурация недоступна', msg).catch(() => undefined)
    return { ok: false, detail: msg }
  }
  // 3) туннель уже поднят (рестарт процесса без пересоздания контейнера)
  const st = await wgStatus()
  if (st.available && st.interfaces.some((i) => i.name === iface)) {
    await log('info', 'vpn', `Автоподнятие: туннель ${iface} уже поднят — повторное включение не требуется`, undefined, `WireGuard auto-up: tunnel ${iface} is already up`)
    return { ok: true, skipped: true, detail: `туннель ${iface} уже поднят` }
  }
  const res = await wgUp(iface, p.config)
  const when = origin === 'start' ? 'при старте контейнера' : 'по запросу пользователя'
  const ok = !!res.ok
  await persist(p.id, ok, res)
  if (ok) {
    const detail = `туннель ${iface} поднят автоматически (${when})`
    await log('success', 'vpn', `Автоподнятие: ${detail}${res.notes?.length ? `; заметки: ${res.notes.join('; ')}` : ''}`, undefined, `WireGuard auto-up: tunnel ${iface} raised (${when})`)
    void notifyEvent('vpn', 'success', `Туннель ${iface} поднят автоматически`, detail + (res.notes?.length ? `\n${res.notes.join('\n')}` : '')).catch(() => undefined)
    return { ok: true, detail, notes: res.notes }
  }
  if (res.alreadyUp) {
    await log('info', 'vpn', `Автоподнятие: туннель ${iface} уже поднят`, undefined, `WireGuard auto-up: tunnel ${iface} is already up`)
    return { ok: true, skipped: true, detail: `туннель ${iface} уже поднят` }
  }
  const msg = `Автоподнятие туннеля ${iface} (${when}) не удалось: ${res.error ?? '—'}${res.notes?.length ? ` (${res.notes.join('; ')})` : ''}`
  await log('error', 'vpn', msg, undefined, `WireGuard auto-up failed for ${iface} (${when}): ${res.error ?? '—'}`)
  void notifyEvent('vpn', 'error', `Не удалось поднять туннель ${iface} автоматически`, (res.error ?? '—') + (res.notes?.length ? `\n${res.notes.join('\n')}` : '')).catch(() => undefined)
  return { ok: false, detail: msg, notes: res.notes }
}

/** Сохранить исход операции в профиль (виден в списке профилей, как в /api/vpn) */
async function persist(id: string, ok: boolean, res: { error?: string; output?: string; notes?: string[] }): Promise<void> {
  try {
    const status = await wgStatus()
    await db.vpnProfile.update({
      where: { id },
      data: {
        active: ok,
        lastCheckAt: new Date(),
        lastStatusJson: JSON.stringify({
          at: new Date().toISOString(),
          action: 'up',
          ok,
          autoUp: true,
          error: res.error ?? null,
          output: res.output ?? null,
          notes: res.notes ?? [],
          interfaces: status.interfaces.filter((i) => i.peers.length > 0 || ok),
        }),
      },
    })
  } catch {
    // статус не критичен — не срываем основной результат
  }
}

/** Однократный автозапуск на процесс: из instrumentation.ts (старт сервера) и из bootstrap дашборда */
export function maybeAutoUpVpn(): void {
  if (g.__wgAutoUpStarted) return
  g.__wgAutoUpStarted = true
  setTimeout(() => {
    void autoUpVpn('start').catch(() => undefined)
  }, AUTOUP_DELAY_MS)
}
