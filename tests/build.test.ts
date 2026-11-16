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

// ── Совместимость с наивным парсером scirius (Clear NDR) ─────────────────────
import {
  sciriusFirstSid, moveSidToFront, sanitizeSciriusCompat, findSciriusSidConflicts,
  renderPerSourceFiles, slugifySourceName, BuiltRule,
} from '@/lib/engine/build'

// Реальный случай, уронивший импорт Clear NDR:
// ValidationError: The source contains conflicting SID (33) in same source NDR rules HUB.
// Scirius берёт первое совпадение регэкспа "sid *: *(\d+)" — а в контенте
// "clsid:33D9A761-…" это совпадение встречается раньше настоящего sid.
const CLSID_RULE = (sid: number) =>
  'alert tcp $EXTERNAL_NET $FILE_DATA_PORTS -> $HOME_NET any ( msg:"BROWSER-PLUGINS Microsoft Internet Explorer ACM Class Manager ActiveX clsid access"; flow:to_client,established; file_data; content:"clsid:33D9A761-90C8-11D0-BD43-00A0C911CE86",fast_pattern,nocase; service:ftp-data,http,imap,pop3; reference:cve,2005-1990; classtype:attempted-user; sid:' + sid + '; rev:13; )'

describe('build: scirius-совместимость — наивный парсер scirius', () => {
  it('sciriusFirstSid видит ложный sid:33 внутри content:"clsid:33…"', () => {
    expect(sciriusFirstSid(CLSID_RULE(1060784466))).toBe(33)
  })
  it('sciriusFirstSid обычного правила — настоящий sid', () => {
    expect(sciriusFirstSid(mkRule(12345, 1, 'x'))).toBe(12345)
  })
  it('moveSidToFront переносит sid в начало опций, содержимое не меняется', () => {
    const raw = CLSID_RULE(1060784466)
    const out = moveSidToFront(raw, 1060784466)
    expect(out.startsWith('alert tcp $EXTERNAL_NET $FILE_DATA_PORTS -> $HOME_NET any (sid:1060784466;')).toBe(true)
    // байты контента не изменились
    expect(out).toContain('content:"clsid:33D9A761-90C8-11D0-BD43-00A0C911CE86",fast_pattern,nocase;')
    expect(out).toContain('rev:13;')
    // после переноса scirius видит настоящий sid
    expect(sciriusFirstSid(out)).toBe(1060784466)
    // правило остаётся валидным для парсера хаба
    expect(out.match(/\bsid\s*:\s*(\d+)\s*;/)?.[1]).toBe('1060784466')
  })
  it('sanitizeSciriusCompat переписывает только проблемные правила', () => {
    const rules: BuiltRule[] = [
      { sid: 1060784466, rev: 13, raw: CLSID_RULE(1060784466), sourceName: 's' },
      { sid: 1001, rev: 1, raw: mkRule(1001, 1, 'normal rule'), sourceName: 's' },
    ]
    const res = sanitizeSciriusCompat(rules)
    expect(res.rewritten).toBe(1)
    expect(res.failed.length).toBe(0)
    // нормальное правило не тронуто
    expect(res.rules[1].raw).toBe(rules[1].raw)
    // переписанное — sid первым
    expect(sciriusFirstSid(res.rules[0].raw)).toBe(1060784466)
    expect(res.rules[0].raw.startsWith('alert tcp $EXTERNAL_NET $FILE_DATA_PORTS -> $HOME_NET any (sid:')).toBe(true)
  })
  it('sanitizeSciriusCompat: пробельные варианты "sid : 33" тоже ловятся', () => {
    const raw = 'alert http any any -> any any ( content:"sid : 33 evil"; sid:900001; rev:1; )'
    const res = sanitizeSciriusCompat([{ sid: 900001, rev: 1, raw, sourceName: 's' }])
    expect(res.rewritten).toBe(1)
    expect(sciriusFirstSid(res.rules[0].raw)).toBe(900001)
    expect(res.failed.length).toBe(0)
  })
  it('findSciriusSidConflicts: до санитайза конфликт есть, после — нет', () => {
    const rules: BuiltRule[] = [
      { sid: 1060784466, rev: 13, raw: CLSID_RULE(1060784466), sourceName: 's' },
      { sid: 1027681677, rev: 13, raw: CLSID_RULE(1027681677), sourceName: 's' },
    ]
    const before = findSciriusSidConflicts(rules)
    expect(before.get(33)).toBe(2)
    const after = findSciriusSidConflicts(sanitizeSciriusCompat(rules).rules)
    expect(after.size).toBe(0)
  })
})

describe('build: renderPerSourceFiles — разбивка по источникам', () => {
  const rules: BuiltRule[] = [
    { sid: 3, rev: 1, raw: mkRule(3, 1, 'c'), sourceName: 'ET Open Ruleset (Emerging Threats)' },
    { sid: 1, rev: 1, raw: mkRule(1, 1, 'a'), sourceName: 'ET Open Ruleset (Emerging Threats)' },
    { sid: 2, rev: 1, raw: mkRule(2, 1, 'b'), sourceName: 'Snort Registered Ruleset (Snort 3)' },
  ]
  it('по одному файлу на источник, имена — слаги, правила отсортированы по sid', () => {
    const files = renderPerSourceFiles(rules)
    expect(files.length).toBe(2)
    const names = files.map((f) => f.name)
    expect(names).toContain('et-open-ruleset-emerging-threats.rules')
    expect(names).toContain('snort-registered-ruleset-snort-3.rules')
    const et = files.find((f) => f.name === 'et-open-ruleset-emerging-threats.rules')!
    expect(et.rules).toBe(2)
    expect(et.content).toContain('# Источник: ET Open Ruleset (Emerging Threats)')
    // порядок по sid внутри файла
    const sids = [...et.content.matchAll(/sid:(\d+);/g)].map((m) => Number(m[1]))
    expect(sids).toEqual([1, 3])
    // в файле-источнике нет пометок "# [источник]" (категория и так одна)
    expect(et.content).not.toContain('# [')
  })
  it('коллизии слагов разрешаются суффиксом', () => {
    const same: BuiltRule[] = [
      { sid: 1, rev: 1, raw: mkRule(1, 1, 'a'), sourceName: 'Source A/1' },
      { sid: 2, rev: 1, raw: mkRule(2, 1, 'b'), sourceName: 'Source A 1' },
    ]
    const files = renderPerSourceFiles(same)
    expect(files.map((f) => f.name).sort()).toEqual(['source-a-1-2.rules', 'source-a-1.rules'])
  })
  it('slugifySourceName кириллицу схлопывает в безопасный слаг', () => {
    expect(slugifySourceName('Правила Хаб (тест)')).toBe('pravila-khab-test')
    expect(slugifySourceName('')).toBe('source')
  })
})

describe('build: renderFinalFile — заголовок по факту', () => {
  it('"Всего правил" = фактическому числу правил в файле, а не счётчику слияния', () => {
    const { rules } = mergeSources([src('a', 10, [[1, 1, 'x'], [2, 1, 'y']])])
    const fakeStats = {
      totalInputRules: 10, uniqueSids: 99, duplicateBySid: 5, duplicateByContent: 3,
      incompatibleDropped: 0, renumbered: 0, sanitizedForScirius: 1,
      perSource: {}, sidsReplaced: [],
    } as never
    const text = renderFinalFile(rules, { sources: ['a'], stats: fakeStats })
    expect(text).toContain('# Всего правил: 2')
    expect(text).toContain('# Адаптировано под парсер Clear NDR (sid перенесён в начало опций): 1')
  })
})
