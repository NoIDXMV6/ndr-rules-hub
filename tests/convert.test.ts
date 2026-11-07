import { describe, it, expect } from 'vitest'
import { convertIpList, convertDomainList, convertUrlList } from '@/lib/engine/convert'

const IPS = Array.from({ length: 1200 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`)

describe('convert: convertIpList', () => {
  it('конвертирует IP-список чанками по 500 с выделением SID из диапазона', () => {
    const rules = convertIpList(IPS.join('\n'), { sidStart: 1100000, msgPrefix: 'TEST-FEED' })
    expect(rules.length).toBe(Math.ceil(1200 / 500))
    expect(rules[0].sid).toBe(1100000)
    expect(rules[1].sid).toBe(1100001)
    expect(rules[0].raw).toContain('alert tcp $HOME_NET any -> [10.0.0.0,')
    expect(rules[0].raw).toContain('sid:1100000;')
    // 500 IP в первом правиле
    expect(rules[0].raw.split('->')[1]).toContain('500')
  })

  it('игнорирует комментарии и пустые строки', () => {
    const rules = convertIpList('# comment\n\n1.2.3.4\n// not ip comment\n5.6.7.8\n', { sidStart: 1200000 })
    expect(rules.length).toBe(1)
    expect(rules[0].raw).toContain('[1.2.3.4,5.6.7.8]')
  })

  it('поддерживает drop-действие и CIDR-маски', () => {
    const rules = convertIpList('1.2.3.0/24\n5.6.7.8\n', { sidStart: 1300000, action: 'drop' })
    expect(rules[0].raw).toContain('[1.2.3.0/24,5.6.7.8]')
    expect(rules[0].raw.startsWith('drop ')).toBe(true)
  })

  it('maxRules — предохранитель', () => {
    const rules = convertIpList(IPS.join('\n'), { sidStart: 1400000, perRule: 1, maxRules: 5 })
    expect(rules.length).toBe(5)
  })
})

describe('convert: convertDomainList', () => {
  it('создаёт DNS-правила по домену на SID', () => {
    const rules = convertDomainList('evil.example.com\ngood.example.org\nevil.example.com\n# comment\n', { sidStart: 1100800, msgPrefix: 'TEST-DNS' })
    expect(rules.length).toBe(2)
    expect(rules[0].raw).toContain('alert dns $HOME_NET any -> $EXTERNAL_NET any')
    expect(rules[0].raw).toContain('dns.query; content:"evil.example.com"; nocase; endswith;')
    expect(rules[0].raw).toContain('sid:1100800;')
    expect(rules[1].sid).toBe(1100801)
  })
})

describe('convert: convertUrlList', () => {
  it('создаёт HTTP-правила host+uri', () => {
    const rules = convertUrlList('http://evil.example.com/payload.bin\nhttp://bad.example.net/\n', { sidStart: 1101000 })
    expect(rules.length).toBe(2)
    expect(rules[0].raw).toContain('http.host; content:"evil.example.com"; startswith; endswith;')
    expect(rules[0].raw).toContain('http.uri; content:"/payload.bin"; startswith;')
    expect(rules[1].raw).toContain('content:"bad.example.net"')
  })
})
