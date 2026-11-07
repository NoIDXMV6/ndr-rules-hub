import { NextResponse } from 'next/server'

/**
 * Единая обработка необработанных исключений в API-роутах.
 * Без этого Next.js возвращает пустой 500 без тела, и UI показывает
 * безликое «HTTP 500» вместо реальной причины (например, P2022 от Prisma
 * при устаревшей схеме БД). Теперь причина возвращается как JSON {error}
 * и дублируется в логи контейнера (docker logs).
 */
export function apiError(e: unknown, status = 500) {
  // Prisma вставляет переводы строк и лишние пробелы в текст исключения —
  // схлопываем их, чтобы ошибка читалась одной строкой в баннере UI
  const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
  console.error(`[api] ${status}:`, msg)
  return NextResponse.json({ error: msg }, { status })
}
