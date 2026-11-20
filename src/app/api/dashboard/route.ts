import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeed, getSettings } from '@/lib/engine/service'
import { ensureDnsSeed } from '@/lib/engine/seed'
import { domainDashboard } from '@/lib/engine/dns-service'
import { isSourceVisible, effectiveEnabled } from '@/lib/engine/workspace'
import { maybeStartCleanupScheduler } from '@/lib/engine/cleanup'
import { maybeStartTelegramPoller, checkReleaseBroadcast } from '@/lib/engine/telegram'
import { ensureConnectorLoop } from '@/lib/engine/misp-connectors'
import { wgStatus } from '@/lib/engine/vpn'
import { apiError } from '@/lib/api-error'
import { guard, sanitizeSettings } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dashboard', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g
  try {
    await ensureSeed()
    // DNS-модуль: докатка каталога доменных списков (недостающие источники/категории)
    await ensureDnsSeed().catch(() => undefined)
    // cron проверки диска (пороги/автоочистка) поднимается один раз на процесс
    maybeStartCleanupScheduler()
    // Telegram-поллер (привязка чатов, коды 2FA) + проверка рассылки о версии —
    // тоже один раз на процесс; ошибки не роняют дашборд
    maybeStartTelegramPoller()
    // цикл коннекторов MISP (60 c): как и остальные — один раз на процесс
    ensureConnectorLoop()
    void checkReleaseBroadcast().catch(() => undefined)
    // ── Рабочее пространство (v1.27.0) ─────────────────────────────────────────
    // Администратор/Community: все источники, состояние Source.enabled, системные
    // сборки и все события. Пользователь: видимые ему источники (системные кроме
    // adminOnly, свои, опубликованные другими), состояние SourceState (без строки
    // — наследуется Source.enabled), СВОЯ персональная сборка и ТОЛЬКО свои события.
    const isAdminRole = g.role === 'admin'
    const uid = g.user?.id ?? null
    const wsRole = isAdminRole ? 'admin' : 'user'
    const stateRows: Array<{ sourceId: string; enabled: boolean }> = !isAdminRole && uid
      ? await db.sourceState.findMany({ where: { userId: uid } })
      : []
    const [allSources, builds, settings, ruleAgg] = await Promise.all([
      // стабильный порядок: по времени добавления — вкл/выкл источника НЕ перемещает
      // его в списке (раньше orderBy по enabled перемещал строку при каждом toggle)
      db.source.findMany({ orderBy: [{ createdAt: 'asc' }] }),
      db.build.findMany({ where: isAdminRole ? { userId: null } : uid ? { userId: uid } : { userId: '—none—' }, orderBy: { createdAt: 'desc' }, take: 1 }),
      getSettings(),
      db.rule.aggregate({ _count: { _all: true } }),
    ])
    // события: пользователь видит ТОЛЬКО свои; системные (userId = null) — только админ
    const logs = isAdminRole
      ? await db.logEntry.findMany({ orderBy: { ts: 'desc' }, take: 50 })
      : uid
        ? await db.logEntry.findMany({ where: { userId: uid }, orderBy: { ts: 'desc' }, take: 50 })
        : []
    const stMap = new Map(stateRows.map((st) => [st.sourceId, st]))
    const visibleSources = allSources
      .filter((s) => isSourceVisible(s, wsRole, uid))
      .map((s) => ({ ...s, effEnabled: isAdminRole ? s.enabled : effectiveEnabled(s, stMap.get(s.id)) }))
    const builds0 = builds[0] ?? null
    // VPN — только администратору (статус туннелей/ключи пиров не для кабинета)
    const wg = g.role === 'admin' ? await wgStatus() : { available: false, error: 'WireGuard доступен только администратору', interfaces: [], tools: { wgQuick: false, wg: false, tunDevice: false, netAdmin: false, sysctl: false, srcValidMark: false, notes: [] as string[] } }
    // DNS-фильтрация: сводка для вкладки и «Обзора» (администратору)
    const dnsBlock = g.role === 'admin' ? await domainDashboard().catch(() => null) : null
    return NextResponse.json({
      sources: {
        total: visibleSources.length,
        enabled: visibleSources.filter((s) => s.effEnabled).length,
        ok: visibleSources.filter((s) => s.status === 'ok').length,
        error: visibleSources.filter((s) => s.status === 'error').length,
        trash: allSources.filter((s) => s.deletedAt && (isAdminRole || s.ownerId === uid)).length,
        list: visibleSources.map((s) => ({
          id: s.id, name: s.name, category: s.category, kind: s.kind, url: s.url,
          authType: s.authType, enabled: s.effEnabled, priority: s.priority,
          status: s.status, lastFetchAt: s.lastFetchAt, lastError: s.lastError,
          ruleCount: s.ruleCount, sizeBytes: s.sizeBytes, badge: s.badge,
          badgeLabel: s.badgeLabel, badgeColor: s.badgeColor,
          notes: s.notes, notesEn: s.notesEn,
          diffAdded: s.diffAdded, diffChanged: s.diffChanged, diffRemoved: s.diffRemoved,
          builtin: s.builtin, extraJson: s.extraJson, deletedAt: s.deletedAt, ownerId: s.ownerId,
          visibility: s.visibility, adminOnly: s.adminOnly,
          createdAt: s.createdAt,
        })),
      },
      rules: { inDb: ruleAgg._count._all, inBuild: builds0?.totalRules ?? 0 },
      lastBuild: builds0
        ? {
            id: builds0.id, createdAt: builds0.createdAt, totalRules: builds0.totalRules,
            fileName: builds0.fileName, filePath: builds0.filePath, sha256: builds0.sha256,
            sizeBytes: builds0.sizeBytes, source: builds0.source, personal: !!builds0.userId,
            stats: JSON.parse(builds0.statsJson || '{}'),
          }
        : null,
      // секреты (serveToken, oinkcode, Auth-Key abuse.ch, токен Scirius) — только админу
      settings: sanitizeSettings(settings, g.role),
      dns: dnsBlock,
      vpn: wg,
      logs: logs.map((l) => ({ id: l.id, ts: l.ts, level: l.level, scope: l.scope, message: l.message, messageEn: l.messageEn })),
    })
  } catch (e) {
    return apiError(e)
  }
}
