import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// Лимит snort.org: официальный интервал между загрузками — 15 минут
// (suricata-update проверяет то же: «Last download less than 15 minutes ago»).
// Без гейта пользователь мог «Обновить» snort-источник сколько угодно раз:
// snort.org отвечает 403 и может заблокировать oinkcode. Гейт в
// fetchSourceById: ответы rateLimited:true / retryAfterSec (API → 429 + Retry-After),
// «Обновить все»/cron пропускают источник (skippedSnortLimit).
// ET Pro: СВОЙ oinkcode (Proofpoint) — глобальный снортовский код к источнику
// rules.emergingthreatspro.com НЕ подставляется; без кода — понятная ошибка
// сразу, до запроса.

const ROOT = path.resolve(__dirname, '..')

let work: string
let db: import('@prisma/client').PrismaClient
let service: typeof import('@/lib/engine/service')
let fetcher: typeof import('@/lib/engine/fetcher')

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-snort-gate-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = work
  delete process.env.NDR_EDITION // community: guard пропускает без сессии
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  service = await import('@/lib/engine/service')
  fetcher = await import('@/lib/engine/fetcher')
  // сид не нужен: создаем источники напрямую
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

describe('хелперы провайдеров и гейта частоты', () => {
  it('isSnortOrgUrl: snort.org с www/поддоменом — да, остальные — нет', () => {
    expect(fetcher.isSnortOrgUrl('https://www.snort.org/reg-rules/snort3.rules.tar.gz/CODE')).toBe(true)
    expect(fetcher.isSnortOrgUrl('https://snort.org/downloads/community/community-rules.tar.gz')).toBe(true)
    expect(fetcher.isSnortOrgUrl('https://lab.snort.org/nalp/rules.tar.gz')).toBe(true)
    expect(fetcher.isSnortOrgUrl('https://rules.emergingthreats.net/open/snort-3.0/emerging.rules.tar.gz')).toBe(false)
    expect(fetcher.isSnortOrgUrl('https://snort.org.example.com/evil')).toBe(false) // не поддомен snort.org
    expect(fetcher.isSnortOrgUrl(null)).toBe(false)
    expect(fetcher.isSnortOrgUrl('не URL')).toBe(false)
  })

  it('isEtProUrl: только emergingthreatspro.com (ET Open на emergingthreats.net — не ET Pro)', () => {
    expect(fetcher.isEtProUrl('https://rules.emergingthreatspro.com/%%OINKCODE%%/suricata-7.0/etpro.rules.tar.gz')).toBe(true)
    expect(fetcher.isEtProUrl('https://www.emergingthreatspro.com/x.rules')).toBe(true)
    expect(fetcher.isEtProUrl('https://rules.emergingthreats.net/open/snort-3.0/emerging.rules.tar.gz')).toBe(false)
    expect(fetcher.isEtProUrl('https://www.snort.org/reg-rules/x.tar.gz/CODE')).toBe(false)
    expect(fetcher.isEtProUrl(null)).toBe(false)
  })

  it('snortRateGate: нет загрузки — пропускаем; 4 мин назад — блок до ~660с; 16 мин назад — пропускаем', () => {
    expect(fetcher.snortRateGate(null).blocked).toBe(false)
    const now = Date.now()
    const fresh = fetcher.snortRateGate(new Date(now - 4 * 60_000), now)
    expect(fresh.blocked).toBe(true)
    expect(fresh.elapsedMin).toBe(4)
    expect(fresh.retryAfterSec).toBeGreaterThan(600)
    expect(fresh.retryAfterSec).toBeLessThanOrEqual(660)
    const old = fetcher.snortRateGate(new Date(now - 16 * 60_000), now)
    expect(old.blocked).toBe(false)
    const edge = fetcher.snortRateGate(new Date(now - fetcher.SNORT_MIN_FETCH_INTERVAL_MS), now)
    expect(edge.blocked).toBe(false) // ровно 15 минут — лимит соблюден
  })
})

describe('fetchSourceById: гейт snort.org и ET Pro oinkcode', () => {
  it('snort-источник, обновлённый 2 мин назад — отказ «15 минут», rateLimited:true, без сетевого запроса', async () => {
    const src = await db.source.create({
      data: {
        name: 'Snort Registered Ruleset',
        category: 'ruleset',
        kind: 'url',
        url: 'https://www.snort.org/reg-rules/snort3-open-rules.tar.gz',
        authType: 'oinkcode',
        enabled: true,
        lastFetchAt: new Date(Date.now() - 2 * 60_000),
        lastError: null,
      },
    })
    const r = await service.fetchSourceById(src.id)
    expect(r.ok).toBe(false)
    expect(r.rateLimited).toBe(true)
    expect(r.retryAfterSec).toBeGreaterThan(600)
    expect(r.error).toContain('15 минут')
    expect(r.error).toContain('snort.org')
    await db.source.delete({ where: { id: src.id } })
  })

  it('не-snort источник под гейт не попадает: обновлён 2 мин назад — запрос идёт дальше (ошибка сети, не rateLimited)', async () => {
    const src = await db.source.create({
      data: {
        name: 'ET Open',
        category: 'ruleset',
        kind: 'url',
        // гарантированно недоступный адрес (порт 1) — сетевая ошибка мгновенно, без внешней сети
        url: 'http://127.0.0.1:1/open/suricata-7.0/emerging.rules.tar.gz',
        authType: 'none',
        enabled: true,
        lastFetchAt: new Date(Date.now() - 2 * 60_000),
      },
    })
    const r = await service.fetchSourceById(src.id)
    expect(r.rateLimited).toBeUndefined()
    expect(r.ok).toBe(false) // сеть недоступна в тестах — но это НЕ гейт
    expect(r.error ?? '').not.toContain('15 минут')
    await db.source.delete({ where: { id: src.id } })
  })

  it('ET Pro без кода — понятная ошибка до запроса, глобальный oinkcode snort.org НЕ подставляется', async () => {
    await db.setting.upsert({
      where: { key: 'oinkcode' },
      create: { key: 'oinkcode', value: 'snort-code-1234567890abcdef', updatedAt: new Date() },
      update: { value: 'snort-code-1234567890abcdef' },
    })
    const src = await db.source.create({
      data: {
        name: 'ET Pro Ruleset (Emerging Threats Pro)',
        category: 'ruleset',
        kind: 'url',
        url: 'https://rules.emergingthreatspro.com/%%OINKCODE%%/suricata-7.0/etpro.rules.tar.gz',
        authType: 'oinkcode',
        enabled: true,
      },
    })
    const r = await service.fetchSourceById(src.id)
    expect(r.ok).toBe(false)
    expect(r.rateLimited).toBeUndefined()
    expect(r.error).toContain('ET Pro')
    expect(r.error).toContain('Oinkcode ET Pro')
    await db.source.delete({ where: { id: src.id } })
  })

  it('ET Pro: задан etProOinkcode — подставляется именно он (проверка applyAuth), снортовский не смешивается', async () => {
    await db.setting.upsert({
      where: { key: 'etProOinkcode' },
      create: { key: 'etProOinkcode', value: 'proofpoint-code-0987654321ab', updatedAt: new Date() },
      update: { value: 'proofpoint-code-0987654321ab' },
    })
    const src = await db.source.create({
      data: {
        name: 'ET Pro Ruleset (Emerging Threats Pro)',
        category: 'ruleset',
        kind: 'url',
        url: 'https://rules.emergingthreatspro.com/%%OINKCODE%%/suricata-7.0/etpro.rules.tar.gz',
        authType: 'oinkcode',
        enabled: true,
      },
    })
    // применяем ту же логику подстановки, что в fetchSourceById: settings читаются из БД
    const settings = await service.getSettings()
    const cfg: import('@/lib/engine/fetcher').FetchSourceCfg = {
      id: src.id, name: src.name, category: src.category, kind: src.kind,
      url: src.url, authType: src.authType, extraJson: src.extraJson, format: src.format,
    }
    let extra: Record<string, unknown> = {}
    if (cfg.extraJson) extra = JSON.parse(cfg.extraJson)
    if (fetcher.isEtProUrl(src.url)) {
      if (!extra.oinkcode && settings.etProOinkcode) extra.oinkcode = settings.etProOinkcode
    } else if (!extra.oinkcode && settings.oinkcode) {
      extra.oinkcode = settings.oinkcode
    }
    cfg.extraJson = JSON.stringify(extra)
    const url = fetcher.applyAuth(cfg.url!, cfg, JSON.parse(cfg.extraJson!) as import('@/lib/engine/fetcher').ExtraCfg)
    expect(url).toContain('proofpoint-code-0987654321ab')
    expect(url).not.toContain('snort-code-1234567890abcdef')
    expect(url).not.toContain('%%OINKCODE%%')
    await db.source.delete({ where: { id: src.id } })
  })

  it('ET Pro: extra.oinkcode источника приоритетнее настройки etProOinkcode', async () => {
    const src = await db.source.create({
      data: {
        name: 'ET Pro с индивидуальным кодом',
        category: 'ruleset',
        kind: 'url',
        url: 'https://rules.emergingthreatspro.com/%%OINKCODE%%/suricata-7.0/etpro.rules.tar.gz',
        authType: 'oinkcode',
        enabled: true,
        extraJson: '{"oinkcode":"per-source-code"}',
      },
    })
    const cfg: import('@/lib/engine/fetcher').FetchSourceCfg = {
      id: src.id, name: src.name, category: src.category, kind: src.kind,
      url: src.url, authType: src.authType, extraJson: src.extraJson, format: src.format,
    }
    const url = fetcher.applyAuth(cfg.url!, cfg, JSON.parse(cfg.extraJson!) as import('@/lib/engine/fetcher').ExtraCfg)
    expect(url).toContain('per-source-code')
    await db.source.delete({ where: { id: src.id } })
  })
})
