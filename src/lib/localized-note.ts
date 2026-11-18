// Выбор примечания источника на языке интерфейса.
// Примечание хранится в двух вариантах: notes (русский) и notesEn (английский).
// В EN-интерфейсе берём английское, при отсутствии — русский (лучше показать
// что-то, чем пустоту); в RU-интерфейсе — наоборот.
export function pickLocalizedNote(
  notes: string | null | undefined,
  notesEn: string | null | undefined,
  lang: 'ru' | 'en',
): string | null {
  const ru = (notes ?? '').trim()
  const en = (notesEn ?? '').trim()
  if (lang === 'ru') return ru || en || null
  return en || ru || null
}
