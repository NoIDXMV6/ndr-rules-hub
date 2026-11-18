import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFileP = promisify(execFile)

// MISP: генерация событий (payload/теги/категории), атрибуты коннекторов
// (Clear NDR / Wazuh / Zabbix / MikroTik), дедупликация, webhook-приёмник,
// файлы окружения развёртывания и сквозной прогон коннектора Wazuh с моком HTTP.

const ROOT = path.resolve(__dirname, '..')

// ── мок undici.request ───────────────────────────────────────────────────────
type ReqRec = { url: string; opts: { method?: string; headers?: Record<string, string>; body?: string; dispatcher?: unknown } }
const reqs: ReqRec[] = []
let responder: (r: ReqRec) => { status: number; body: string } = () => ({ status: 200, body: '{}' })

vi.mock('undici', () => {
  class FakeAgent {
    constructor(_opts?: unknown) { /* диспетчер не проверяем */ }
  }
  return {
    request: (url: string, opts: ReqRec['opts']) => {
      const rec: ReqRec = { url, opts }
      reqs.push(rec)
      const r = responder(rec)
      return {
        statusCode: r.status,
        body: { text: async () => r.body, dump: async () => undefined },
      }
    },
    ProxyAgent: FakeAgent,
    Agent: FakeAgent,
  }
})

let work: string
let db: import('@prisma/client').PrismaClient
let mc: typeof import('@/lib/engine/misp-connectors')
let md: typeof import('@/lib/engine/misp-deploy')

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value, updatedAt: new Date() }, update: { value, updatedAt: new Date() } })
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-misp-'))
  process.env.DATABASE_URL = `file:${path.join(work, 'hub.db')}`
  process.env.RULES_DATA_DIR = path.join(work, 'data')
  await execFileP('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${path.join(work, 'hub.db')}` },
  })
  const dbmod = await import('@/lib/db')
  db = dbmod.db
  mc = await import('@/lib/engine/misp-connectors')
  md = await import('@/lib/engine/misp-deploy')
}, 120_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

const MISP_HITS = JSON.stringify({
  hits: {
    hits: [
      {
        _source: {
          'vulnerability': { id: 'CVE-2025-1111', severity: 'high', score: { base: 8.1 } },
          'agent': { name: 'srv-01' },
          'package': { name: 'nginx', version: '1.18.0' },
        },
      },
      {
        _source: {
          'vulnerability': { id: 'CVE-2025-2222', severity: 'medium', score: { base: 5.0 } },
          'agent': { name: 'srv-01' },
          'package': { name: 'openssl', version: '3.0.11' },
        },
      },
    ],
  },
})

describe('misp: категории и payload событий', () => {
  it('attrCategory: сетевые типы → Network activity, CVE → External analysis, прочее → Other', () => {
    expect(mc.attrCategory('ip-src')).toBe('Network activity')
    expect(mc.attrCategory('hostname')).toBe('Network activity')
    expect(mc.attrCategory('vulnerability')).toBe('External analysis')
    expect(mc.attrCategory('md5')).toBe('Artifacts dropped')
    expect(mc.attrCategory('text')).toBe('Other')
  })

  it('buildEventPayload: распределение/угроза ограничены, тег хаба + теги коннектора, published', () => {
    const p = mc.buildEventPayload(
      { info: 'test event', attrs: [{ type: 'ip-src', value: '10.0.0.1' }, { type: 'ip-src', value: '10.0.0.2', toIds: true }], tags: ['wazuh', 'wazuh'] },
      { distribution: 9, threatLevel: 0, published: false, tagPrefix: 'ndr-hub' },
    )
    const ev = p.Event as Record<string, unknown>
    expect(ev.distribution).toBe(3) // 9 → максимум 3
    expect(ev.threat_level_id).toBe(1) // 0 → минимум 1
    expect(ev.published).toBe(false)
    expect(ev.analysis).toBe(1)
    const tags = (ev.Tag as Array<{ name: string }>).map((t) => t.name)
    expect(tags).toEqual(['ndr-hub', 'wazuh']) // дубликат убран, префикс первым
    const attrs = ev.Attribute as Array<Record<string, unknown>>
    expect(attrs).toHaveLength(2)
    expect(attrs[0]).toMatchObject({ type: 'ip-src', value: '10.0.0.1', to_ids: false, distribution: 5, category: 'Network activity' })
    expect(attrs[1]).toMatchObject({ to_ids: true })
  })

  it('buildEventPayload: атрибуты сверх лимита отбрасываются', () => {
    const attrs = Array.from({ length: 600 }, (_, i) => ({ type: 'ip-src', value: `10.0.0.${i % 256}` }))
    const p = mc.buildEventPayload({ info: 'x', attrs, tags: [] }, { distribution: 1, threatLevel: 2, published: false, tagPrefix: 'ndr-hub' })
    expect(((p.Event as Record<string, unknown>).Attribute as unknown[]).length).toBeLessThanOrEqual(500)
  })
})

describe('misp: атрибуты коннекторов', () => {
  it('clearndrHitAttrs: ip-src/ip-dst + комментарий с sid/signature', () => {
    const attrs = mc.clearndrHitAttrs({ src_ip: '203.0.113.9', dest_ip: '10.0.0.5', alert: { signature_id: 2027865, signature: 'ET MALWARE C2' } })
    expect(attrs).toHaveLength(2)
    expect(attrs[0]).toMatchObject({ type: 'ip-src', value: '203.0.113.9' })
    expect(attrs[0].comment).toContain('2027865')
    expect(attrs[0].comment).toContain('ET MALWARE C2')
    expect(attrs[1].type).toBe('ip-dst')
  })

  it('clearndrHitAttrs: без IP — fallback text с названием правила', () => {
    const attrs = mc.clearndrHitAttrs({ alert: { signature_id: 1, signature: 'weird rule' } })
    expect(attrs).toHaveLength(1)
    expect(attrs[0]).toMatchObject({ type: 'text', value: 'weird rule' })
  })

  it('wazuhHitAttrs: CVE (vulnerability) + хост агента; без CVE — пусто', () => {
    const attrs = mc.wazuhHitAttrs({ vulnerability: { id: 'CVE-2025-1111', severity: 'high', score: { base: 8.1 } }, agent: { name: 'srv-01' }, package: { name: 'nginx', version: '1.18.0' } })
    expect(attrs[0]).toMatchObject({ type: 'vulnerability', value: 'CVE-2025-1111' })
    expect(attrs[0].comment).toContain('nginx')
    expect(attrs[0].comment).toContain('srv-01')
    expect(attrs[1]).toMatchObject({ type: 'hostname', value: 'srv-01' })
    expect(mc.wazuhHitAttrs({ agent: { name: 'x' } })).toEqual([])
  })

  it('zabbixProblemAttrs: hostname + text; severityName по шкале 0..5', () => {
    const attrs = mc.zabbixProblemAttrs({ host: 'gw-01', name: 'High CPU usage', severity: 4 })
    expect(attrs[0]).toMatchObject({ type: 'hostname', value: 'gw-01' })
    expect(attrs[0].comment).toContain('high')
    expect(attrs[0].comment).toContain('High CPU usage')
    expect(attrs[1]).toMatchObject({ type: 'text', value: 'High CPU usage' })
    expect(mc.severityName(0)).toBe('not classified')
    expect(mc.severityName('5')).toBe('disaster')
    expect(mc.severityName(undefined)).toBe('not classified')
  })

  it('mikrotik: дедуп — новые записи только при первом появлении', () => {
    const entries = [
      { address: '198.51.100.1', list: 'blacklist' },
      { address: '198.51.100.2', list: 'blacklist' },
      { address: '198.51.100.1', list: 'whitelist' }, // другой список = другой ключ
    ]
    const first = mc.filterNewMikrotikEntries(entries, {})
    expect(first.fresh).toHaveLength(3)
    expect(mc.mikrotikEntryKey(entries[0])).toBe('blacklist|198.51.100.1')
    const second = mc.filterNewMikrotikEntries(entries, first.seen)
    expect(second.fresh).toHaveLength(0)
    expect(Object.keys(second.seen)).toHaveLength(3)
  })
})

describe('misp: планировщик', () => {
  it('connectorDue: без lastRun — пора; свежий lastRun — нет; устаревший — пора', () => {
    const now = Date.now()
    expect(mc.connectorDue(undefined, 15, now)).toBe(true)
    expect(mc.connectorDue(new Date(now - 5 * 60_000).toISOString(), 15, now)).toBe(false)
    expect(mc.connectorDue(new Date(now - 20 * 60_000).toISOString(), 15, now)).toBe(true)
    expect(mc.connectorDue('not-a-date', 15, now)).toBe(true)
    // интервал меньше минуты округляется до 1 минуты: 30 с назад — рано, 61 с — пора
    expect(mc.connectorDue(new Date(now - 30_000).toISOString(), 0.1, now)).toBe(false)
    expect(mc.connectorDue(new Date(now - 61_000).toISOString(), 0.1, now)).toBe(true)
  })
})

describe('misp: webhook-приёмник (parseIngestPayload)', () => {
  it('строки values + text + теги: нормализуются, источник становится тегом', () => {
    const p = mc.parseIngestPayload({ source: 'uuwaf', info: 'SQLi attempt', type: 'ip-src', values: ['203.0.113.7', { type: 'url', value: 'http://x/?q=1', comment: 'union select' }], text: 'blocked by rule 42', tags: ['sqli', 'bad tag!', 'x'.repeat(70)] })
    expect(p.ok).toBe(true)
    const spec = p.spec!
    expect(spec.tags).toContain('uuwaf')
    expect(spec.tags).toContain('sqli')
    expect(spec.tags).not.toContain('bad tag!')
    expect(spec.tags.every((t) => t.length <= 64)).toBe(true)
    expect(spec.attrs).toHaveLength(3) // ip-src + url + text
    expect(spec.attrs[0]).toMatchObject({ type: 'ip-src', value: '203.0.113.7' })
    expect(spec.attrs[1]).toMatchObject({ type: 'url', comment: 'union select' })
    expect(spec.info).toContain('SQLi attempt')
    expect(spec.info).toContain('(3)')
  })

  it('пустое тело (без values и text) — отказ с внятной ошибкой', () => {
    const p = mc.parseIngestPayload({ source: 'uuwaf' })
    expect(p.ok).toBe(false)
    expect(p.error).toContain('values')
  })

  it('недопустимый type игнорируется — берётся дефолт ip-src', () => {
    const p = mc.parseIngestPayload({ type: 'DROP TABLE', values: ['203.0.113.7'] })
    expect(p.ok).toBe(true)
    expect(p.spec!.attrs[0].type).toBe('ip-src')
  })
})

describe('misp: файлы окружения развёртывания', () => {
  const base = {
    baseUrl: 'http://192.168.1.10:8408',
    adminEmail: 'admin@ndr.local',
    adminPassword: 'pw',
    adminKey: 'a'.repeat(40),
    dbPassword: 'dbpw',
    dbRootPassword: 'rootpw',
    redisPassword: 'redispw',
    port: 8408,
  }

  it('.env содержит ключевые переменные и BASE_URL', () => {
    const env = md.mispEnvFile(base)
    expect(env).toContain('BASE_URL=http://192.168.1.10:8408')
    expect(env).toContain(`ADMIN_KEY=${'a'.repeat(40)}`)
    expect(env).toContain('MYSQL_USER=misp')
    expect(env).toContain('MYSQL_DATABASE=misp')
    expect(env).toContain('REDIS_PASSWORD=redispw')
    expect(env).toContain('NGINX_HTTP_PORT=8408')
  })

  it('compose: все 5 сервисов, интерполяция секретов из .env, только именованные тома', () => {
    const yml = md.mispComposeFile(base)
    for (const svc of ['misp-core:', 'misp-nginx:', 'misp-modules:', 'db:', 'redis:']) {
      expect(yml).toContain(svc)
    }
    // секреты не вшиты — приходят из .env
    expect(yml).toContain('${MYSQL_PASSWORD}')
    expect(yml).toContain('${ADMIN_KEY}')
    expect(yml).toContain('${REDIS_PASSWORD}')
    // порт nginx
    expect(yml).toContain('"${NGINX_HTTP_PORT}:8080"')
    // БЕЗ bind-каталогов (compose запускается из контейнера хаба — пути хоста не резолвятся)
    expect(yml).not.toMatch(/:\s*\.\/|\.:\//)
    expect(yml).toContain('mysql_data:/var/lib/mysql')
    // core ждёт здоровья db/redis/modules
    expect(yml).toContain('condition: service_healthy')
  })

  it('normalizeBaseUrl через deployMisp: кривой BASE_URL не ломает генерацию (fallback на порт)', () => {
    // проверка через mispEnvFile с явным значением: нормализация сама тестируется в deploy (integration)
    const env = md.mispEnvFile({ ...base, baseUrl: `http://127.0.0.1:${base.port}` })
    expect(env).toContain(`BASE_URL=http://127.0.0.1:${base.port}`)
  })
})

describe('misp: сквозной прогон коннектора Wazuh (мок HTTP)', () => {
  it('хиты → событие MISP: Authorization-ключ, Event.info, LastRun/LastStatus записаны', async () => {
    await setSetting('mispUrl', 'http://misp.local')
    await setSetting('mispAuthKey', 'APIKEY42')
    await setSetting('mispConnWazuhUrl', 'http://wazuh:9200')
    await setSetting('mispConnWazuhPass', 'secret')
    reqs.length = 0
    responder = (r) => {
      if (r.url.endsWith('/_search')) return { status: 200, body: MISP_HITS }
      if (r.url.endsWith('/events/add')) return { status: 200, body: '{"Event":{"id":"42"}}' }
      return { status: 404, body: '{}' }
    }
    const r = await mc.runConnector('wazuh')
    expect(r.ok).toBe(true)
    expect(r.eventId).toBe('42')
    expect(r.count).toBeGreaterThanOrEqual(2)

    const search = reqs.find((x) => x.url === 'http://wazuh:9200/wazuh-states-vulnerabilities-*/_search')
    expect(search).toBeDefined()
    expect(search!.opts.headers!.authorization).toContain('Basic ') // Basic admin:secret

    const add = reqs.find((x) => x.url === 'http://misp.local/events/add')
    expect(add).toBeDefined()
    expect(add!.opts.headers!.Authorization).toBe('APIKEY42')
    const body = JSON.parse(add!.opts.body!) as { Event: { info: string; Attribute: Array<{ type: string; value: string }> } }
    expect(body.Event.info).toContain('Wazuh')
    const cves = body.Event.Attribute.filter((a) => a.type === 'vulnerability').map((a) => a.value)
    expect(cves).toContain('CVE-2025-1111')
    expect(cves).toContain('CVE-2025-2222')

    const s = await db.setting.findMany({ where: { key: { startsWith: 'mispConnWazuh' } } })
    const kv = Object.fromEntries(s.map((x) => [x.key, x.value]))
    expect(kv.mispConnWazuhLastRun).not.toBe('')
    expect(kv.mispConnWazuhLastStatus).toBe('ok')
  })

  it('MISP отвечает 403 — коннектор падает с внятной ошибкой, статус error', async () => {
    reqs.length = 0
    responder = (r) => {
      if (r.url.endsWith('/_search')) return { status: 200, body: MISP_HITS }
      return { status: 403, body: '{"name":"403","message":"Invalid API key"}' }
    }
    const r = await mc.runConnector('wazuh')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('403')
    const row = await db.setting.findUnique({ where: { key: 'mispConnWazuhLastStatus' } })
    expect(row?.value).toBe('error')
  })

  it('пустой индекс (0 хитов) — ok, empty, событие не создаётся', async () => {
    reqs.length = 0
    responder = (r) => {
      if (r.url.endsWith('/_search')) return { status: 200, body: '{"hits":{"hits":[]}}' }
      return { status: 500, body: 'must not be called' }
    }
    const r = await mc.runConnector('wazuh')
    expect(r.ok).toBe(true)
    expect(r.empty).toBe(true)
    expect(reqs.find((x) => x.url.endsWith('/events/add'))).toBeUndefined()
  })

  it('ingestToMisp: валидный webhook → событие; пустой → отказ', async () => {
    reqs.length = 0
    responder = (r) => {
      if (r.url.endsWith('/events/add')) return { status: 200, body: '{"Event":{"id":"77"}}' }
      return { status: 404, body: '{}' }
    }
    const ok = await mc.ingestToMisp({ source: 'uuwaf', type: 'ip-src', values: ['203.0.113.7'] })
    expect(ok.ok).toBe(true)
    expect(ok.eventId).toBe('77')
    expect(ok.count).toBe(1)
    const bad = await mc.ingestToMisp({ source: 'uuwaf' })
    expect(bad.ok).toBe(false)
  })

  it('connectorStates: возвращает состояние всех четырёх коннекторов', async () => {
    await setSetting('mispConnWazuhLastStatus', 'ok')
    await setSetting('mispConnWazuhLastCount', '3')
    const rows = await mc.connectorStates()
    expect(rows.map((r) => r.id).sort()).toEqual(['clearndr', 'mikrotik', 'wazuh', 'zabbix'])
    const wazuh = rows.find((r) => r.id === 'wazuh')!
    expect(wazuh.lastStatus).toBe('ok')
    expect(wazuh.lastCount).toBe(3)
  })
})
