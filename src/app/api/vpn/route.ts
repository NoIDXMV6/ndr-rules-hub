import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { wgFullTest, wgUp, wgDown, parseWgConfig, WgStatus } from '@/lib/engine/vpn'
import { apiError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'

/** GET /api/vpn — статус инструментов и туннелей */
export async function GET() {
  try {
    const res = await wgFullTest()
    const profiles = await db.vpnProfile.findMany()
    return NextResponse.json({
      available: res.status.available,
      error: res.status.error,
      interfaces: res.status.interfaces,
      tools: res.tools,
      profiles,
    })
  } catch (e) {
    return apiError(e)
  }
}

/** POST /api/vpn — действия: {action: 'up'|'down'|'test', id?, config?, name?} */
export async function POST(req: NextRequest) {
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
      if (res.ok) {
        if (body.id) await db.vpnProfile.update({ where: { id: body.id }, data: { active: true, lastCheckAt: new Date() } })
        return NextResponse.json({ ok: true, detail: `туннель ${parsed.iface} поднят` })
      }
      return NextResponse.json({ ok: false, error: res.error }, { status: 400 })
    }

    if (action === 'down') {
      const name = body.name ?? 'wg0'
      const res = await wgDown(name)
      if (res.ok) {
        await db.vpnProfile.updateMany({ where: { name }, data: { active: false } })
        return NextResponse.json({ ok: true })
      }
      return NextResponse.json({ ok: false, error: res.error }, { status: 400 })
    }

    return NextResponse.json({ error: 'action: up | down | test | test-config' }, { status: 400 })
  } catch (e) {
    return apiError(e)
  }
}

/** PUT /api/vpn — сохранить/создать профиль {name, config} */
export async function PUT(req: NextRequest) {
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
