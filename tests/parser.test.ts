import { describe, it, expect } from 'vitest'
import { parseRuleLine, parseRuleText, extractSid, checkSuricataCompat } from '@/lib/engine/parser'

const R1 = 'alert tcp $HOME_NET any -> $EXTERNAL_NET any ( msg:"APP-DETECT psyBNC access"; flow:to_client,established; content:"Welcome!psyBNC@lam3rz.de",fast_pattern,nocase; metadata:ruleset community; classtype:bad-unknown; sid:493; rev:11; )'
const R_SNORT2_PREPROC = 'alert tcp any any -> any any ( msg:"TEST preproc"; preproc:sensitive_data; sid:1000001; rev:1; )'
const R_SNORT3_KEYSTORE = 'alert tls any any -> any any ( msg:"TEST keystore"; keystore:trust; sid:1000002; rev:1; )'
const R_MULTILINE = `alert tcp $EXTERNAL_NET any -> $HOME_NET 80 (msg:"TEST multiline";\\
  content:"GET"; http_uri;\\
  sid:1000003; rev:1;)`

describe('parser: parseRuleLine', () => {
  it('разбирает стандартное правило Snort/Suricata', () => {
    const r = parseRuleLine(R1)
    expect(r).not.toBeNull()
    expect(r!.action).toBe('alert')
    expect(r!.proto).toBe('tcp')
    expect(r!.srcIp).toBe('$HOME_NET')
    expect(r!.srcPort).toBe('any')
    expect(r!.dstIp).toBe('$EXTERNAL_NET')
    expect(r!.dstPort).toBe('any')
    expect(r!.sid).toBe(493)
    expect(r!.rev).toBe(11)
    expect(r!.msg).toBe('APP-DETECT psyBNC access')
    expect(r!.classtype).toBe('bad-unknown')
    expect(r!.suricataOk).toBe(true)
  })

  it('игнорирует комментарии и мусор', () => {
    expect(parseRuleLine('# alert tcp any any -> any any (sid:1;)')).toBeNull()
    expect(parseRuleLine('')).toBeNull()
    expect(parseRuleLine('some random text')).toBeNull()
  })

  it('помечает snort2-препроцессорные правила как несовместимые', () => {
    const r = parseRuleLine(R_SNORT2_PREPROC)!
    expect(r.sid).toBe(1000001)
    expect(r.suricataOk).toBe(false)
    expect(r.compatNotes).toContain('preproc')
  })

  it('помечает snort3-ключевые слова как несовместимые', () => {
    const r = parseRuleLine(R_SNORT3_KEYSTORE)!
    expect(r.suricataOk).toBe(false)
    expect(r.compatNotes).toContain('keystore')
  })
})

describe('parser: parseRuleText (многострочные правила)', () => {
  it('склеивает правило, разорванное по строкам', () => {
    const rules = parseRuleText(`${R1}\n\n# comment\n${R_MULTILINE}\n`)
    expect(rules.length).toBe(2)
    expect(rules[1].sid).toBe(1000003)
    expect(rules[1].msg).toBe('TEST multiline')
  })

  it('разбирает большой реальный поток без потерь sid', () => {
    const sample = Array.from({ length: 1000 }, (_, i) =>
      `alert tcp any any -> any ${1000 + i} (msg:"gen ${i}"; content:"x${i}"; sid:${2000000 + i}; rev:1;)`
    ).join('\n')
    const rules = parseRuleText(sample)
    expect(rules.length).toBe(1000)
    expect(rules[999].sid).toBe(2000999)
  })
})

describe('parser: extractSid / compat', () => {
  it('extractSid находит sid', () => {
    expect(extractSid('... sid:12345; rev:2;')).toBe(12345)
    expect(extractSid('no sid here')).toBeNull()
  })
  it('activate/dynamic действия несовместимы', () => {
    expect(checkSuricataCompat('activate tcp any any -> any any (sid:1;)').ok).toBe(false)
  })
})
