import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { wgFullTest, wgUp, wgDown, parseWgConfig, wgStatus, WgStatus } from '@/lib/engine/vpn'
import { getSetting } from '@/lib/engine/service'
import { autoUpVpn } from '@/lib/engine/vpn-autoup'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { log } from '@/lib/engine/service'
import { notifyEvent } from '@/lib/engine/notify'

export const dynamic = 'force-dynamic'

/** Сохранить результат последней операции в профиль (виден в списке профилей) */
async function persistProfileStatus(
  id: string,
  action: 'up' | 'down',
  ok: boolean,
  payload: { error?: string; output?: string; notes?: string[] },
): Promise<void> {
  try {
    const status = await wgStatus()
    await db.vpnProfile.update({
      where: { id },
      data: {
        active: action === 'up' && ok,
        lastCheckAt: new Date(),
        lastStatusJson: JSON.stringify({
          at: new Date().toISOString(),
          action,
          ok,
          error: payload.error ?? null,
          output: payload.output ?? null,
          notes: payload.notes ?? [],
          interfaces: status.interfaces.filter((i) => i.peers.length > 0 || action === 'up'),
        }),
      },
    })
  } catch {
    // статус не критичен — не срываем основной ответ
  }
}

/** GET /api/vpn — статус инструментов и туннелей (только администратор) */
export async function GET(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'vpn', rule: { limit: 120, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const res = await wgFullTest()
    const upIfaces = new Set(res.status.interfaces.map((i) => i.name))
    const profiles = await db.vpnProfile.findMany()
    // реальное состояние интерфейса каждого профиля — из `wg show interfaces`,
    // а не из флага active (он отражает последнюю операцию и может врать):
    // кнопка «Поднять» должна быть недоступна для поднятого туннеля
    const withState = profiles.map((p) => {
      const parsed = parseWgConfig(p.config)
      const iface = parsed.ok ? parsed.iface ?? p.name : p.name
      return { ...p, iface, ifaceUp: upIfaces.has(iface) }
    })
    return NextResponse.json({
      available: res.status.available,
      error: res.status.error,
      interfaces: res.status.interfaces,
      tools: res.tools,
      profiles: withState,
      // состояние переключателя «Автоматическое поднятие тунеля» (wgAutoUp)
      autoUp: (await getSetting('wgAutoUp')) === 'true',
    })
  } catch (e) {
    return apiError(e)
  }
}

/** POST /api/vpn — действия: {action: 'up'|'down'|'test', id?, config?, name?} */
export async function POST(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'vpn', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => ({}))
    const action = body?.action

    if (action === 'test-config') {
      return NextResponse.json({ configOk: parseWgConfig(body.config ?? '') })
    }

    if (action === 'test') {
      const res = await wgFullTest(body.config)
      return NextResponse.json(res)
    }

    if (action === 'auto-up') {
      // «Автоматическое поднятие тунеля» — применить сейчас (включение
      // переключателя в UI или ручной прогон той же проверки конфигурации)
      const r = await autoUpVpn('manual')
      if (r.ok) return NextResponse.json({ ok: true, detail: r.detail, notes: r.notes, info: !!r.skipped })
      return NextResponse.json({ ok: false, error: r.detail, notes: r.notes, info: !!r.skipped })
    }

    if (action === 'up') {
      if (!body.id && !body.config) return NextResponse.json({ error: 'нужен id профиля или config' }, { status: 400 })
      let config = body.config
      let name = body.name ?? 'wg0'
      if (body.id) {
        const p = await db.vpnProfile.findUnique({ where: { id: body.id } })
        if (!p) return NextResponse.json({ error: 'профиль не найден' }, { status: 404 })
        config = p.config
        name = p.name
      }
      const parsed = parseWgConfig(config ?? '')
      if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })
      const res = await wgUp(parsed.iface ?? name, config ?? '')
      // alreadyUp — туннель реально поднят: сохраняем как действующий (active),
      // а не как неудачную попытку; обычная ошибка — как раньше
      if (body.id) await persistProfileStatus(body.id, 'up', res.ok || !!res.alreadyUp, res)
      if (res.alreadyUp) {
        // 409 Conflict: туннель уже поднят — повторный up недопустим (иначе
        // wg-quick down+up рвал туннель и вешал web UI). Флаг alreadyUp
        // позволяет UI показать это как подсказку, а не как ошибку.
        await log('warn', 'vpn', `Повторное включение ${parsed.iface} отклонено: туннель уже поднят`)
        return NextResponse.json({ ok: false, alreadyUp: true, error: res.error, notes: res.notes }, { status: 409 })
      }
      if (res.ok) {
        const detail = `туннель ${parsed.iface} поднят`
        await log('success', 'vpn', `Туннель ${parsed.iface} поднят${body.id ? ` (профиль ${body.id})` : ''}`)
        void notifyEvent('vpn', 'success', `Туннель ${parsed.iface} поднят`, detail).catch(() => undefined)
        return NextResponse.json({ ok: true, detail, notes: res.notes, output: res.output })
      }
      await log('error', 'vpn', `Не удалось поднять ${parsed.iface}: ${res.error ?? '—'}`)
      void notifyEvent('vpn', 'error', `Не удалось поднять туннель ${parsed.iface}`, res.error ?? '—').catch(() => undefined)
      return NextResponse.json({ ok: false, error: res.error, notes: res.notes }, { status: 400 })
    }

    if (action === 'down') {
      const name = body.name ?? 'wg0'
      const res = await wgDown(name)
      if (res.ok) await log('info', 'vpn', `Туннель ${name} остановлен`)
      else await log('error', 'vpn', `Не удалось остановить ${name}: ${res.error ?? '—'}`)
      void notifyEvent('vpn', res.ok ? 'info' : 'error', res.ok ? `Туннель ${name} остановлен` : `Не удалось остановить ${name}`, res.error ?? '').catch(() => undefined)
      if (body.id) await persistProfileStatus(body.id, 'down', res.ok, res)
      else if (!body.id && body.name) {
        const p = await db.vpnProfile.findFirst({ where: { name } })
        if (p) await persistProfileStatus(p.id, 'down', res.ok, res)
      }
      if (res.ok) return NextResponse.json({ ok: true, notes: res.notes })
      return NextResponse.json({ ok: false, error: res.error, notes: res.notes }, { status: 400 })
    }

    return NextResponse.json({ error: 'action: up | down | test | test-config | auto-up' }, { status: 400 })
  } catch (e) {
    return apiError(e)
  }
}

/** PUT /api/vpn — сохранить/создать профиль {name, config} */
export async function PUT(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'vpn', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const body = await req.json().catch(() => null)
    if (!body?.name || !body?.config) return NextResponse.json({ error: 'нужны name и config' }, { status: 400 })
    const parsed = parseWgConfig(body.config)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const p = await db.vpnProfile.upsert({
      where: { name: body.name },
      create: { name: body.name, config: body.config },
      update: { config: body.config },
    })
    return NextResponse.json({ profile: p })
  } catch (e) {
    return apiError(e)
  }
}

/** DELETE /api/vpn?id=... */
export async function DELETE(req: NextRequest) {
  const g = await guard(req, { admin: true, rate: { key: 'vpn', rule: { limit: 60, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'нужен id' }, { status: 400 })
    await db.vpnProfile.delete({ where: { id } }).catch(() => null)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return apiError(e)
  }
}

export type { WgStatus }
