import { describe, it, expect } from 'vitest'
import { mergeSources, hashRule, renderFinalFile, replaceSid, SourceRules } from '@/lib/engine/build'

function mkRule(sid: number, rev: number, content: string) {
  return `alert tcp any any -> any any (msg:"${content}"; content:"${content}"; sid:${sid}; rev:${rev};)`
}

function src(name: string, priority: number, rules: Array<[number, number, string]>): SourceRules {
  return {
    sourceId: name,
    sourceName: name,
    priority,
    rules: rules.map(([sid, rev, content]) => ({
      sid, rev, raw: mkRule(sid, rev, content), action: 'alert', proto: 'tcp',
      contentHash: hashRule(mkRule(sid, rev, content)), suricataOk: true, compatNotes: null,
    })),
  }
}

describe('build: mergeSources — дедупликация по SID', () => {
  it('оставляет правило с наибольшим rev (highest-rev)', () => {
    const { rules, stats } = mergeSources([
      src('old', 10, [[1001, 3, 'rule A']]),
      src('new', 20, [[1001, 5, 'rule A v5']]),
    ])
    expect(stats.duplicateBySid).toBe(1)
    expect(rules.length).toBe(1)
    expect(rules[0].rev).toBe(5)
    expect(rules[0].sourceName).toBe('new')
  })

  it('source-priority: побеждает источник с меньшим числом приоритета при равном rev', () => {
    const { rules } = mergeSources(
      [
        src('secondary', 50, [[2002, 4, 'same']]),
        src('primary', 10, [[2002, 4, 'same']]),
      ],
      { sidStrategy: 'source-priority' }
    )
    expect(rules.length).toBe(1)
    expect(rules[0].sourceName).toBe('primary')
  })

  it('не теряет непересекающиеся правила', () => {
    const { rules, stats } = mergeSources([
      src('a', 10, [[3001, 1, 'x'], [3002, 1, 'y']]),
      src('b', 20, [[3003, 1, 'z']]),
    ])
    expect(rules.length).toBe(3)
    expect(stats.duplicateBySid).toBe(0)
    expect(stats.uniqueSids).toBe(3)
  })
})

describe('build: mergeSources — дедупликация по содержимому', () => {
  it('убирает одинаковое содержимое под разными SID', () => {
    const { rules, stats } = mergeSources([
      src('a', 10, [[4001, 1, 'identical payload']]),
      src('b', 20, [[4002, 1, 'identical payload']]),
    ])
    expect(stats.duplicateByContent).toBe(1)
    expect(rules.length).toBe(1)
  })

  it('hashRule не зависит от sid/rev/msg', () => {
    const h1 = hashRule(mkRule(5001, 1, 'same').replace('msg:"same"', 'msg:"other name"'))
    const h2 = hashRule(mkRule(9999, 7, 'same'))
    expect(h1).toBe(h2)
  })
})

describe('build: политики совместимости и заглушек', () => {
  it('dropIncompatible убирает правила с пометкой несовместимости', () => {
    const s: SourceRules = {
      sourceId: 's', sourceName: 's', priority: 10,
      rules: [
        { sid: 6001, rev: 1, raw: mkRule(6001, 1, 'ok'), action: 'alert', proto: 'tcp', contentHash: hashRule(mkRule(6001, 1, 'ok')), suricataOk: true, compatNotes: null },
        { sid: 6002, rev: 1, raw: mkRule(6002, 1, 'bad'), action: 'alert', proto: 'tcp', contentHash: hashRule(mkRule(6002, 1, 'bad')), suricataOk: false, compatNotes: 'preproc' },
      ],
    }
    const { rules, stats } = mergeSources([s], { dropIncompatible: true })
    expect(rules.length).toBe(1)
    expect(stats.incompatibleDropped).toBe(1)
  })

  it('dropDisabledMsg убирает правила DELETED/DISABLED', () => {
    const deleted = `alert tcp any any -> any any (msg:"DELETED rule x"; content:"d"; sid:7001; rev:2;)`
    const s: SourceRules = {
      sourceId: 's', sourceName: 's', priority: 10,
      rules: [{ sid: 7001, rev: 2, raw: deleted, action: 'alert', proto: 'tcp', contentHash: hashRule(deleted), suricataOk: true, compatNotes: null }],
    }
    const { rules } = mergeSources([s], { dropDisabledMsg: true })
    expect(rules.length).toBe(0)
  })
})

describe('build: renumber-private', () => {
  it('перенумеровывает SID вне приватного диапазона', () => {
    const { rules, stats } = mergeSources(
      [src('s', 10, [[493, 11, 'public sid'], [560, 9, 'public sid 2']])],
      { sidStrategy: 'renumber-private', privateSidStart: 1000000 }
    )
    expect(stats.renumbered).toBe(2)
    expect(rules[0].sid).toBe(1000000)
    expect(rules[1].sid).toBe(1000001)
    expect(rules[0].raw).toContain('sid:1000000;')
  })
})

describe('build: renderFinalFile', () => {
  it('формирует файл с заголовком и правилами', () => {
    const { rules, stats } = mergeSources([src('a', 10, [[8001, 1, 'x']])])
    const text = renderFinalFile(rules, { sources: ['a'], stats })
    expect(text).toContain('# Объединённый набор правил для Clear NDR / Suricata')
    expect(text).toContain('sid:8001;')
    expect(text).toContain('# [a]')
    // каждая строка правила валидна
    const lines = text.split('\n').filter((l) => l.startsWith('alert '))
    expect(lines.length).toBe(1)
  })
})

describe('build: replaceSid', () => {
  it('заменяет sid в сыром правиле', () => {
    expect(replaceSid(mkRule(1, 1, 'x'), 1234567)).toContain('sid:1234567;')
  })
})
