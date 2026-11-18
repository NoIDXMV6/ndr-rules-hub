import { describe, it, expect } from 'vitest'
import { SEED_SOURCES } from '@/lib/engine/seed'
import { pickLocalizedNote } from '@/lib/localized-note'

// Примечания источников двуязычны: notes (рус) / notesEn (англ) —
// EN-интерфейс показывает notesEn, а не русский текст каталога.
describe('seed sources: двуязычные примечания', () => {
  it('у каждого источника с русским примечанием есть непустое английское', () => {
    for (const s of SEED_SOURCES) {
      if (s.notes) {
        expect(s.notesEn, `notesEn отсутствует у «${s.name}»`).toBeTruthy()
        expect((s.notesEn ?? '').length, `notesEn слишком короткое у «${s.name}»`).toBeGreaterThan(10)
      }
    }
  })

  it('английские примечания не содержат кириллицы', () => {
    for (const s of SEED_SOURCES) {
      expect(/[А-Яа-яЁё]/.test(s.notesEn ?? ''), `кириллица в notesEn у «${s.name}»`).toBe(false)
    }
  })

  it('английское примечание не дублирует русское', () => {
    for (const s of SEED_SOURCES) {
      if (s.notes) expect(s.notesEn, `notesEn совпадает с notes у «${s.name}»`).not.toBe(s.notes)
    }
  })
})

describe('pickLocalizedNote', () => {
  it('EN-интерфейс берёт английское примечание, при отсутствии — русское', () => {
    expect(pickLocalizedNote('русская', 'english', 'en')).toBe('english')
    expect(pickLocalizedNote('русская', null, 'en')).toBe('русская')
    expect(pickLocalizedNote('русская', '  ', 'en')).toBe('русская')
  })

  it('RU-интерфейс берёт русское примечание, при отсутствии — английское', () => {
    expect(pickLocalizedNote('русская', 'english', 'ru')).toBe('русская')
    expect(pickLocalizedNote(null, 'english', 'ru')).toBe('english')
    expect(pickLocalizedNote('', '  ', 'ru')).toBeNull()
    expect(pickLocalizedNote(null, null, 'en')).toBeNull()
  })
})
