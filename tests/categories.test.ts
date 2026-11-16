import { describe, it, expect } from 'vitest'
import {
  ruleCategory, groupRulesByCategory, applyCategoryAndRuleFilter, categoryDisplayName, UNCATEGORIZED,
} from '@/lib/engine/categories'

const r = (sid: number, clsType?: string | null, sourceName = 'src') => ({ sid, clsType, sourceName })

describe('categories: ruleCategory — нормализация classtype', () => {
  it('пустые/пробельные значения → «none»', () => {
    expect(ruleCategory(null)).toBe('none')
    expect(ruleCategory(undefined)).toBe('none')
    expect(ruleCategory('  ')).toBe('none')
  })
  it('регистр и пробелы срезаются', () => {
    expect(ruleCategory('  Attempted-User ')).toBe('attempted-user')
  })
})

describe('categories: groupRulesByCategory — группировка правил', () => {
  it('считает правила по категориям и собирает источники', () => {
    const map = groupRulesByCategory([
      r(1, 'trojan-activity', 'ET'),
      r(2, 'trojan-activity', 'ET'),
      r(3, 'trojan-activity', 'Snort'),
      r(4, null, 'Feodo IP'),
      r(5, 'attempted-user', 'Snort'),
    ])
    expect(map.size).toBe(3)
    expect(map.get('trojan-activity')).toEqual({ name: 'trojan-activity', rules: 3, sources: ['ET', 'Snort'] })
    expect(map.get(UNCATEGORIZED)?.rules).toBe(1)
    expect(map.get('attempted-user')?.sources).toEqual(['Snort'])
  })
  it('пустой список → пустая карта', () => {
    expect(groupRulesByCategory([]).size).toBe(0)
  })
})

describe('categories: applyCategoryAndRuleFilter — фильтр сборки', () => {
  const rules = [
    r(1, 'trojan-activity', 'ET'),
    r(2, 'attempted-user', 'Snort'),
    r(3, null, 'Feodo IP'),
    r(4, 'trojan-activity', 'Snort'),
  ]

  it('пустые карты — ничего не отбрасывается (категории ещё не сканировались)', () => {
    const res = applyCategoryAndRuleFilter(rules, new Map(), new Map())
    expect(res.kept.length).toBe(4)
    expect(res.excludedByCategory).toBe(0)
    expect(res.excludedByRule).toBe(0)
  })

  it('выключенная категория убирает её правила', () => {
    const res = applyCategoryAndRuleFilter(rules, new Map([['trojan-activity', false]]), new Map())
    expect(res.kept.map((x) => x.sid).sort()).toEqual([2, 3])
    expect(res.excludedByCategory).toBe(2)
    expect(res.excludedByRule).toBe(0)
  })

  it('выключенное правило (RuleOverride) убирает его независимо от категории', () => {
    const res = applyCategoryAndRuleFilter(rules, new Map(), new Map([[2, false]]))
    expect(res.kept.map((x) => x.sid).sort()).toEqual([1, 3, 4])
    expect(res.excludedByRule).toBe(1)
  })

  it('оба фильтра вместе', () => {
    const res = applyCategoryAndRuleFilter(
      rules,
      new Map([['trojan-activity', false]]),
      new Map([[3, false]]),
    )
    expect(res.kept.map((x) => x.sid)).toEqual([2])
    expect(res.excludedByCategory).toBe(2)
    expect(res.excludedByRule).toBe(1)
  })

  it('правило без clsType попадает в категорию «none» и управляется ею', () => {
    const res = applyCategoryAndRuleFilter(rules, new Map([['none', false]]), new Map())
    expect(res.kept.map((x) => x.sid).sort()).toEqual([1, 2, 4])
    expect(res.excludedByCategory).toBe(1)
  })

  it('включённая категория в карте не мешает', () => {
    const res = applyCategoryAndRuleFilter(rules, new Map([['trojan-activity', true]]), new Map())
    expect(res.kept.length).toBe(4)
  })
})

describe('categories: categoryDisplayName', () => {
  it('label приоритетнее', () => {
    expect(categoryDisplayName('trojan-activity', 'Трояны')).toBe('Трояны')
    expect(categoryDisplayName('trojan-activity')).toBe('trojan-activity')
    expect(categoryDisplayName('none')).toBe('без категории (без classtype)')
    expect(categoryDisplayName('none', 'Конвертеры')).toBe('Конвертеры')
  })
})
