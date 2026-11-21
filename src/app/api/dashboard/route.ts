import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeed, getSettings, maybeStartScheduler } from '@/lib/engine/service'
import { ensureDnsSeed } from '@/lib/engine/seed'
import { domainDashboard } from '@/lib/engine/dns-service'
import { rulesCountCached } from '@/lib/engine/count-cache'
import { isSourceVisible, effectiveEnabled } from '@/lib/engine/workspace'
import { maybeStartCleanupScheduler } from '@/lib/engine/cleanup'
import { maybeStartTelegramPoller, checkReleaseBroadcast } from '@/lib/engine/telegram'
import { ensureConnectorLoop } from '@/lib/engine/misp-connectors'
import { maybeAutoUpVpn } from '@/lib/engine/vpn-autoup'
import { wgStatus } from '@/lib/engine/vpn'
import { guard, sanitizeSettings } from '@/lib/security/guard'

export const dynamic = 'force-dynamic'

// ── Отказоустойчивость дашборда (v1.39.0) ────────────────────────────────────
// ИНЦИДЕНТ (продакшен, БД 1.3 GB + медленный том): при старте контейнера
// интерактивные запросы упирались в диск (холодный кэш страниц + фоновая
// докатка/сборки), /api/dashboard отдавал 500/таймаут — интерфейс навсегда
// оставался на «Загрузка данных…», администратор видел «неработоспособную»
// систему без диагноза. Политика роута с v1.39.0:
//   • дашборд НЕ падает целиком: каждый блок данных — со своим
//     try/catch/таймаутом; упавший блок отдаётся деградировавшим
//     (fallback + пометка в `degraded[]`), остальные данные доходят до UI;
//   • докатка каталогов (ensureSeed/ensureDnsSeed) — не на пути ответа дольше
//     8с: не успела — пропущена (повторится на следующем опросе через 20с);
//   • seeds выполняются ОДИН РАЗ на процесс: опрос дашборда каждые 20с больше
//     не гоняет сверки каталогов и upserts категорий по большой БД на каждый
//     запрос (после обновления образа процесс новый — докатка отработает).
const SEED_BUDGET_MS = 8_000

const gs = globalThis as unknown as { __hubSeedsDone?: boolean }

/**
 * Сток для «проигравшего» гонку промиса: если дедлайн наступил раньше, а
 * promise отклонился ПОСЛЕ — у отклонения не осталось бы обработчика, и
 * unhandledRejection уронил бы процесс (Node 22 — crash). Отдельный
 * .then/.catch поглощает поздний исход.
 */
function sink(p: Promise<unknown>): void {
  p.then(
    () => undefined,
    () => undefined,
  )
}

/** Не дольше budgetMs: что раньше — результат или fallback (ошибка глотается) */
async function bounded<T>(p: Promise<T>, budgetMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ hit: true }>((resolve) => {
    timer = setTimeout(() => resolve({ hit: true }), budgetMs)
  })
  sink(p)
  try {
    const r = await Promise.race([p, deadline])
    return r && (r as { hit?: boolean }).hit === true ? fallback : (r as T)
  } catch {
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function GET(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dashboard', rule: { limit: 240, windowMs: 60_000 } } })
  if (g instanceof NextResponse) return g

  // Degraded-отчёт: что именно не ответило (видно в UI и диагностике)
  const degraded: string[] = []
  const step = async <T>(label: string, p: Promise<T>, fallback: T, budgetMs = 25_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<{ hit: true }>((resolve) => {
      timer = setTimeout(() => resolve({ hit: true }), budgetMs)
    })
    sink(p)
    try {
      const r = await Promise.race([p, deadline])
      if (r && (r as { hit?: boolean }).hit === true) {
        degraded.push(`${label}: таймаут ${Math.round(budgetMs / 1000)}с`)
        return fallback
      }
      return r as T
    } catch (e) {
      degraded.push(`${label}: ${(e as Error).message?.split('\n')[0] ?? 'ошибка'}`)
      return fallback
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // Bootstrap один раз на процесс; при сбое/таймауте — повтор на следующем опросе
  if (!gs.__hubSeedsDone) {
    const ok = await bounded((async () => {
      await ensureSeed()
      // DNS-модуль: докатка каталога доменных списков (недостающие источники/категории)
      await ensureDnsSeed()
      gs.__hubSeedsDone = true
      return true
    })(), SEED_BUDGET_MS, false)
    if (!ok) degraded.push('докатка каталогов: не завершилась (повтор при следующем опросе)')
  }

  // cron/планировщики/поллеры — in-memory запускаются один раз, БД не ждут:
  // ошибки не должны ронять дашборд
  try {
    maybeStartCleanupScheduler()
    maybeStartScheduler()
    maybeAutoUpVpn()
    maybeStartTelegramPoller()
    ensureConnectorLoop()
    void checkReleaseBroadcast().catch(() => undefined)
  } catch { /* фоновые сервисы не критичны для ответа */ }

  try {
    // ── Рабочее пространство (v1.27.0) ─────────────────────────────────────────
    // Администратор/Community: все источники, состояние Source.enabled, системные
    // сборки и все события. Пользователь: видимые ему источники (системные кроме
    // adminOnly, свои, опубликованные другими), состояние SourceState (без строки
    // — наследуется Source.enabled), СВОЯ персональная сборка и ТОЛЬКО свои события.
    const isAdminRole = g.role === 'admin'
    const uid = g.user?.id ?? null
    const wsRole = isAdminRole ? 'admin' : 'user'
    const stateRows: Array<{ sourceId: string; enabled: boolean }> = !isAdminRole && uid
      ? await step('SourceState', db.sourceState.findMany({ where: { userId: uid } }), [])
      : []
    const [allSources, builds, settings, rulesCount] = await Promise.all([
      // стабильный порядок: по времени добавления — вкл/выкл источника НЕ перемещает
      // его в списке (раньше orderBy по enabled перемещал строку при каждом toggle)
      step('Source.findMany', db.source.findMany({ orderBy: [{ createdAt: 'asc' }] }), []),
      step('Build.last', db.build.findMany({ where: isAdminRole ? { userId: null } : uid ? { userId: uid } : { userId: '—none—' }, orderBy: { createdAt: 'desc' }, take: 1 }), []),
      step('Settings', getSettings(), {} as Record<string, string>),
      // v1.35.0: счётчик правил через TTL-кэш — COUNT(*) по 478k строк на каждый
      // опрос дашборда замедлял чтение из БД до неприемлемых показателей
      step('Rules.count', rulesCountCached(), 0),
    ])
    // события: пользователь видит ТОЛЬКО свои; системные (userId = null) — только админ
    const logs = isAdminRole
      ? await step('LogEntry', db.logEntry.findMany({ orderBy: { ts: 'desc' }, take: 50 }), [])
      : uid
        ? await step('LogEntry.user', db.logEntry.findMany({ where: { userId: uid }, orderBy: { ts: 'desc' }, take: 50 }), [])
        : []
    const stMap = new Map(stateRows.map((st) => [st.sourceId, st]))
    const visibleSources = allSources
      .filter((s) => isSourceVisible(s, wsRole, uid))
      .map((s) => ({ ...s, effEnabled: isAdminRole ? s.enabled : effectiveEnabled(s, stMap.get(s.id)) }))
    const builds0 = builds[0] ?? null
    // VPN — только администратору (статус туннелей/ключи пиров не для кабинета);
    // wg-команды под жёстким бюджетом: зависший wg не должен вешать дашборд
    const wg = g.role === 'admin'
      ? await step('WireGuard', wgStatus(), { available: false, error: 'статус WireGuard не получен (таймаут)', interfaces: [] }, 8_000)
      : { available: false, error: 'WireGuard доступен только администратору', interfaces: [], tools: { wgQuick: false, wg: false, tunDevice: false, netAdmin: false, sysctl: false, srcValidMark: false, notes: [] as string[] } }
    // DNS-фильтрация: сводка для вкладки и «Обзора» (администратору)
    const dnsBlock = g.role === 'admin' ? await step('DNS.dashboard', domainDashboard(), null, 15_000) : null
    return NextResponse.json({
      degraded: degraded.length > 0 ? degraded : undefined,
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
      rules: { inDb: rulesCount, inBuild: builds0?.totalRules ?? 0 },
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
    // Последняя линия обороны: даже полностью упавший сбор данных — это
    // деградация, а не 500: UI получает сигнал и показывает диагноз
    return NextResponse.json({
      degraded: [`dashboard: ${(e as Error).message?.split('\n')[0] ?? 'ошибка'}`],
      sources: { total: 0, enabled: 0, ok: 0, error: 0, trash: 0, list: [] },
      rules: { inDb: 0, inBuild: 0 },
      lastBuild: null,
      settings: {},
      dns: null,
      vpn: { available: false, error: 'недоступно', interfaces: [], tools: { wgQuick: false, wg: false, tunDevice: false, netAdmin: false, sysctl: false, srcValidMark: false, notes: [] } },
      logs: [],
    }, { status: 200 })
  }
}
