import { describe, it, expect } from 'vitest'
import {
  isSourceVisible,
  effectiveEnabled,
  selectWorkspaceSources,
  personalFileName,
  workspaceSignature,
  type WorkspaceSource,
  type WorkspaceState,
} from '@/lib/engine/workspace'

// Рабочие пространства (v1.27.0): у каждого пользователя — свой набор источников
// и персональная сборка. Манипуляции одного пользователя не затрагивают других.

function src(p: Partial<WorkspaceSource> & { id: string }): WorkspaceSource {
  return {
    ownerId: null,
    visibility: 'private',
    adminOnly: false,
    enabled: false,
    deletedAt: null,
    ...p,
  }
}

describe('isSourceVisible: видимость источников в рабочем пространстве', () => {
  const sys = src({ id: 'sys' })
  const sysAdminOnly = src({ id: 'etpro', adminOnly: true })
  const own = src({ id: 'own', ownerId: 'u1' })
  const foreignPrivate = src({ id: 'priv', ownerId: 'u2', visibility: 'private' })
  const foreignPublished = src({ id: 'pub', ownerId: 'u2', visibility: 'published' })
  const trashed = src({ id: 'del', deletedAt: new Date() })

  it('администратор видит все не удалённые источники, включая adminOnly и чужие', () => {
    expect(isSourceVisible(sys, 'admin', null)).toBe(true)
    expect(isSourceVisible(sysAdminOnly, 'admin', 'admin1')).toBe(true)
    expect(isSourceVisible(foreignPrivate, 'admin', 'admin1')).toBe(true)
    expect(isSourceVisible(trashed, 'admin', 'admin1')).toBe(false)
  })

  it('пользователь видит системные источники, кроме adminOnly', () => {
    expect(isSourceVisible(sys, 'user', 'u1')).toBe(true)
    expect(isSourceVisible(sysAdminOnly, 'user', 'u1')).toBe(false)
  })

  it('пользователь видит свои источники (в т.ч. приватные) и опубликованные другими', () => {
    expect(isSourceVisible(own, 'user', 'u1')).toBe(true)
    expect(isSourceVisible(foreignPrivate, 'user', 'u1')).toBe(false)
    expect(isSourceVisible(foreignPublished, 'user', 'u1')).toBe(true)
    expect(isSourceVisible(foreignPublished, 'user', 'u2')).toBe(true)
  })

  it('удалённые (корзина) не видны никому', () => {
    expect(isSourceVisible(trashed, 'user', 'u1')).toBe(false)
  })
})

describe('effectiveEnabled: состояние источника в рабочем пространстве', () => {
  it('строка SourceState перекрывает Source.enabled', () => {
    expect(effectiveEnabled({ enabled: true }, { sourceId: 's', enabled: false })).toBe(false)
    expect(effectiveEnabled({ enabled: false }, { sourceId: 's', enabled: true })).toBe(true)
  })

  it('без строки состояние наследуется от Source.enabled (системные по дефолту)', () => {
    expect(effectiveEnabled({ enabled: true }, null)).toBe(true)
    expect(effectiveEnabled({ enabled: true }, undefined)).toBe(true)
    expect(effectiveEnabled({ enabled: false }, null)).toBe(false)
  })
})

describe('selectWorkspaceSources: выборка рабочего пространства', () => {
  it('пользователь: скрыты adminOnly и чужие приватные; эффективные состояния из SourceState', () => {
    const states: WorkspaceState[] = [{ sourceId: 'sys', enabled: true }]
    const out = selectWorkspaceSources(
      [
        src({ id: 'sys', enabled: false }),
        src({ id: 'etpro', adminOnly: true, enabled: true }),
        src({ id: 'priv', ownerId: 'u2', enabled: true }),
        src({ id: 'pub', ownerId: 'u2', visibility: 'published', enabled: false }),
      ],
      states,
      'user',
      'u1',
    )
    expect(out.map((s) => s.id).sort()).toEqual(['pub', 'sys'])
    const sys = out.find((s) => s.id === 'sys')!
    expect(sys.effectiveEnabled).toBe(true) // SourceState перекрыл Source.enabled=false
    const pub = out.find((s) => s.id === 'pub')!
    expect(pub.effectiveEnabled).toBe(false)
  })

  it('админ: состояние берётся из Source.enabled', () => {
    const out = selectWorkspaceSources(
      [src({ id: 'a', enabled: true }), src({ id: 'b', enabled: false })],
      [{ sourceId: 'b', enabled: true }], // состояния админа игнорируются
      'admin',
      'admin1',
    )
    expect(out.find((s) => s.id === 'a')!.effectiveEnabled).toBe(true)
    expect(out.find((s) => s.id === 'b')!.effectiveEnabled).toBe(false)
  })
})

describe('personalFileName: имя файла персональной сборки', () => {
  it('slug из email-префикса + хвост id', () => {
    expect(personalFileName('cuid1234abcd', 'ivan.petrov@example.com')).toBe('personal-ivan-petrov-abcd.rules')
  })

  it('недопустимые символы заменяются дефисом, длина ограничена', () => {
    // email-префикс берётся до ПЕРВОГО «@»: «Пётр» — кириллица → slug пуст → 'user'
    expect(personalFileName('xyz9999', 'Пётр@Алексеев@x')).toBe('personal-user-9999.rules')
    // латиница сохраняется, прочие символы → дефис
    expect(personalFileName('xyz9999', 'ivan-petrov+x@example.com')).toBe('personal-ivan-petrov-x-9999.rules')
  })

  it('без email — нейтральный slug по id', () => {
    expect(personalFileName('abcdefgh1234', null)).toBe('personal-user-1234.rules')
    expect(personalFileName('abcdefgh1234', '')).toBe('personal-user-1234.rules')
  })
})

describe('workspaceSignature: подпись рабочего пространства', () => {
  const mk = (id: string, eff: boolean, ruleCount = 10, updatedAt = '2026-01-01T00:00:00Z') => ({
    id, enabled: eff, eff, priority: 100, ruleCount, updatedAt,
  })

  it('не зависит от порядка источников', () => {
    const a = workspaceSignature([mk('a', true), mk('b', false)])
    const b = workspaceSignature([mk('b', false), mk('a', true)])
    expect(a).toBe(b)
  })

  it('меняется при переключении источника и при обновлении правил', () => {
    const base = workspaceSignature([mk('a', true), mk('b', false)])
    expect(workspaceSignature([mk('a', false), mk('b', false)])).not.toBe(base)
    expect(workspaceSignature([mk('a', true, 11), mk('b', false)])).not.toBe(base)
    expect(workspaceSignature([mk('a', true, 10, '2026-01-02T00:00:00Z'), mk('b', false)])).not.toBe(base)
    expect(workspaceSignature([mk('a', true), mk('b', false)])).toBe(base)
  })

  it('пустое пространство и полное дают разные подписи', () => {
    expect(workspaceSignature([])).not.toBe(workspaceSignature([mk('a', true)]))
  })
})
