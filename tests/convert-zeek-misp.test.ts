import { describe, it, expect } from 'vitest'
import { convertZeekIntel, convertMispJson } from '@/lib/engine/convert'
import { applyAuth, maskAuthKey, FetchSourceCfg, ExtraCfg } from '@/lib/engine/fetcher'

// ─────────────────────────────────────────────────────────────────────────────
// Zeek intel (формат фидов CriticalPathSecurity, TSV с заголовком #fields)
// ─────────────────────────────────────────────────────────────────────────────

const INTEL = [
  '#fields\tindicator\tindicator_type\tmeta.source\tmeta.do_notice\tmeta.desc',
  '106.12.219.245\tIntel::ADDR\tCobaltStrike-IP\tF\tCobaltStrike',
  '106.12.219.245\tIntel::ADDR\tCobaltStrike-IP\tF\tCobaltStrike', // дубликат
  '106.13.29.104\tIntel::ADDR\tCobaltStrike-IP\tF\tCobaltStrike',
  '198.51.100.0/24\tIntel::ADDR\tRange\tF\tRange',
  'evil.example.com\tIntel::DOMAIN\tCS-Domain\tF\tCobaltStrike C2',
  'c2.example.net\tIntel::DNS\tCS-Domain\tF\tCobaltStrike C2',
  'http://payload.example.org/dropper.bin\tIntel::URL\tCS-URL\tF\tDropper',
  '4d5e6f707172737475767778797a7b7c\tIntel::FILE_HASH\tHash\tF\tSample', // не сетевой — пропуск
  '# комментарий — пропускается',
  '',
].join('\n')

describe('convert: convertZeekIntel', () => {
  it('Intel::ADDR → IP-правила чанками, дубликаты убраны, CIDR сохранён', () => {
    const rules = convertZeekIntel(INTEL, { sidStart: 1101200, msgPrefix: 'CPS-CS' })
    expect(rules.length).toBe(4) // 1 чанк IP (2 уникальных + /24) + 2 DNS + 1 HTTP
    const ipRule = rules[0]
    expect(ipRule.raw).toContain('alert ip $HOME_NET any -> [106.12.219.245,106.13.29.104,198.51.100.0/24] any')
    expect(ipRule.raw).toContain('sid:1101200;')
    expect(ipRule.raw).toContain('metadata:ruleset zeek-intel;')
    expect(ipRule.raw).toContain('msg:"CPS-CS')
  })

  it('Intel::DOMAIN / Intel::DNS → DNS-правила по домену', () => {
    const rules = convertZeekIntel(INTEL, { sidStart: 1101200 })
    const dns = rules.filter((r) => r.raw.includes('dns.query'))
    expect(dns.length).toBe(2)
    expect(dns[0].raw).toContain('content:"evil.example.com"; nocase; endswith;')
    expect(dns[1].raw).toContain('content:"c2.example.net";')
  })

  it('Intel::URL → HTTP-правило host+uri', () => {
    const rules = convertZeekIntel(INTEL, { sidStart: 1101200 })
    const http = rules.filter((r) => r.raw.includes('http.host'))
    expect(http.length).toBe(1)
    expect(http[0].raw).toContain('content:"payload.example.org"; startswith; endswith;')
    expect(http[0].raw).toContain('http.uri; content:"/dropper.bin"; startswith;')
  })

  it('хэши/не-сетевые типы пропускаются, SID идут подряд', () => {
    const rules = convertZeekIntel(INTEL, { sidStart: 1101200 })
    expect(rules.every((r) => r.raw.includes('Intel::FILE_HASH') === false)).toBe(true)
    expect(rules.map((r) => r.sid)).toEqual([1101200, 1101201, 1101202, 1101203])
  })

  it('строки без типа: IP и домен определяются по форме, мусор пропускается', () => {
    const rules = convertZeekIntel('1.2.3.4\ngood.example.org\nnot a domain\n', { sidStart: 1200000 })
    expect(rules.length).toBe(2)
    expect(rules[0].raw).toContain('[1.2.3.4]')
    expect(rules[1].raw).toContain('content:"good.example.org";')
  })

  it('URL без пути падает на домен, maxRules — предохранитель', () => {
    const rules = convertZeekIntel('http://evil.example.com\tIntel::URL\tFeed\tF\tX', { sidStart: 1300000 })
    expect(rules.length).toBe(1)
    expect(rules[0].raw).toContain('dns.query; content:"evil.example.com";')
    const many = Array.from({ length: 30 }, (_, i) => `10.0.0.${i + 1}\tIntel::ADDR\tFeed\tF\tX`).join('\n')
    expect(convertZeekIntel(many, { sidStart: 1400000, perRule: 1, maxRules: 5 }).length).toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MISP attributes JSON (restSearch /attributes/restSearch.json)
// ─────────────────────────────────────────────────────────────────────────────

const MISP_RESPONSE_ATTR = {
  response: {
    Attribute: [
      { id: '1', type: 'ip-dst', value: '185.220.101.1', category: 'Network activity', comment: 'C2 node' },
      { id: '2', type: 'ip-src', value: '203.0.113.5', category: 'Network activity' },
      { id: '3', type: 'ip-src|port', value: '198.51.100.7|8080', category: 'Network activity' },
      { id: '4', type: 'domain', value: 'malware.example.com', category: 'Payload delivery' },
      { id: '5', type: 'hostname', value: 'stage.example.net' },
      { id: '6', type: 'url', value: 'http://dropper.example.org/payload.bin' },
      { id: '7', type: 'domain|ip', value: 'evil.example.org|192.0.2.9', category: 'Network activity' },
      { id: '8', type: 'md5', value: '0123456789abcdef0123456789abcdef' }, // не сетевой — пропуск
      { id: '9', type: 'sha256', value: 'deadbeef' }, // не сетевой — пропуск
      { id: '10', type: 'filename|md5', value: 'evil.exe|cafebabecafebabecafebabecafebabe' }, // пропуск
      { id: '11', type: 'ip-dst', value: '185.220.101.1' }, // дубликат ip-dst № 1
    ],
  },
}

describe('convert: convertMispJson', () => {
  it('форма {response:{Attribute:[…]}}: ip→чанк, domain/hostname→DNS, url→HTTP; хэши пропущены', () => {
    const rules = convertMispJson(JSON.stringify(MISP_RESPONSE_ATTR), { sidStart: 1101400, msgPrefix: 'MISP' })
    // 1 IP-чанк (4 уникальных IP) + 3 DNS + 1 HTTP = 5; md5/sha256/filename|md5 пропущены
    expect(rules.length).toBe(5)
  })

  it('уникальные IP-атрибуты собираются в один чанк', () => {
    const rules = convertMispJson(JSON.stringify(MISP_RESPONSE_ATTR), { sidStart: 1101400 })
    const ipRules = rules.filter((r) => r.raw.match(/alert ip /))
    expect(ipRules.length).toBe(1)
    expect(ipRules[0].raw).toContain('185.220.101.1')
    expect(ipRules[0].raw).toContain('203.0.113.5')
    expect(ipRules[0].raw).toContain('198.51.100.7')
    expect(ipRules[0].raw).toContain('192.0.2.9')
    // дубликат 185.220.101.1 не задвоил запись
    expect(ipRules[0].raw.match(/185\.220\.101\.1/g)?.length).toBe(1)
  })

  it('domain/hostname → DNS-правила, включая домен из composite domain|ip', () => {
    const rules = convertMispJson(JSON.stringify(MISP_RESPONSE_ATTR), { sidStart: 1101400 })
    const dns = rules.filter((r) => r.raw.includes('dns.query'))
    const domains = dns.map((r) => r.raw.match(/content:"([^"]+)"; nocase/)?.[1])
    expect(domains).toContain('malware.example.com')
    expect(domains).toContain('stage.example.net')
    expect(domains).toContain('evil.example.org')
    // 192.0.2.9 из composite попал в IP-чанк, а не в DNS
    expect(domains).not.toContain('192.0.2.9')
  })

  it('url → HTTP-правило; комментарий/category попадает в msg', () => {
    const rules = convertMispJson(JSON.stringify(MISP_RESPONSE_ATTR), { sidStart: 1101400 })
    const http = rules.filter((r) => r.raw.includes('http.host'))
    expect(http.length).toBe(1)
    expect(http[0].raw).toContain('content:"dropper.example.org"; startswith; endswith;')
    expect(http[0].raw).toContain('http.uri; content:"/payload.bin"; startswith;')
  })

  it('форма {response:[…]} (новые MISP) и корневой массив тоже разбираются', () => {
    const flat = { response: [{ type: 'ip-dst', value: '10.0.0.1' }, { type: 'domain', value: 'a.example.com' }] }
    const arr = [{ type: 'ip-dst', value: '10.0.0.2' }]
    const r1 = convertMispJson(JSON.stringify(flat), { sidStart: 1101400 })
    const r2 = convertMispJson(JSON.stringify(arr), { sidStart: 1101400 })
    expect(r1.length).toBe(2)
    expect(r2.length).toBe(1)
    expect(r2[0].raw).toContain('[10.0.0.2]')
  })

  it('битый JSON → пустой результат (источник без правил)', () => {
    expect(convertMispJson('не json', { sidStart: 1101400 })).toEqual([])
    expect(convertMispJson('{"response":{}}', { sidStart: 1101400 })).toEqual([])
  })

  it('CIDR в ip-dst сохраняется, sidStart задаёт диапазон, metadata:ruleset misp', () => {
    const rules = convertMispJson(JSON.stringify([{ type: 'ip-dst', value: '10.1.2.0/24' }]), { sidStart: 1101400 })
    expect(rules[0].raw).toContain('[10.1.2.0/24]')
    expect(rules[0].sid).toBe(1101400)
    expect(rules[0].raw).toContain('metadata:ruleset misp;')
  })

  it('значения с кавычками/пробелами не ломают правило', () => {
    const rules = convertMispJson(JSON.stringify([
      { type: 'domain', value: 'bad"quote.example.com' },      // кавычка — индикатор пропущен
      { type: 'domain', value: 'ok.example.com' },
    ]), { sidStart: 1101400 })
    expect(rules.length).toBe(1)
    expect(rules[0].raw).toContain('content:"ok.example.com";')
  })

  it('maxRules — предохранитель на общее число правил', () => {
    const attrs = Array.from({ length: 50 }, (_, i) => ({ type: 'domain', value: `d${i}.example.com` }))
    expect(convertMispJson(JSON.stringify(attrs), { sidStart: 1101400, maxRules: 10 }).length).toBe(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ET Pro: %%OINKCODE%% в пути URL (новый механизм path-based oinkcode)
// ─────────────────────────────────────────────────────────────────────────────

const CODE = '0123456789abcdef0123456789abcdef01234567'
const oinkCfg = (url: string): FetchSourceCfg => ({
  id: 'x', name: 'x', category: 'ruleset', kind: 'url', url, authType: 'oinkcode', format: 'auto',
})

describe('fetcher: applyAuth %%OINKCODE%% (ET Pro)', () => {
  it('плейсхолдер заменяется на код, query не дописывается', () => {
    const url = applyAuth('https://rules.emergingthreats.net/%%OINKCODE%%/suricata-7.0/emerging-all.rules', oinkCfg('u'), { oinkcode: CODE })
    expect(url).toBe(`https://rules.emergingthreats.net/${CODE}/suricata-7.0/emerging-all.rules`)
  })

  it('без кода URL остаётся как есть (ошибка отдастся при загрузке)', () => {
    const url = applyAuth('https://rules.emergingthreats.net/%%OINKCODE%%/suricata-7.0/emerging-all.rules', oinkCfg('u'), {})
    expect(url).toContain('%%OINKCODE%%')
  })

  it('maskAuthKey скрывает сегмент %%OINKCODE%%', () => {
    expect(maskAuthKey('https://rules.emergingthreats.net/%%OINKCODE%%/suricata-7.0/emerging-all.rules')).not.toContain('%%OINKCODE%%')
  })
})
