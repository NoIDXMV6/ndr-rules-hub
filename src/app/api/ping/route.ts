import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ping — живость HTTP-сервера для docker healthcheck.
 *
 * Специально НЕ обращается к БД и не делает никакой тяжёлой работы.
 * Причина: сборка правил (с v1.24 — фоновое задание) подолгу занимает
 * единственную SQLite-коннекцию (connection_limit=1) и нагружает event loop
 * фазами слияния/санитайза десятков тысяч правил. Тяжёлый healthcheck
 * (раньше /api/dashboard: ensureSeed + 5 запросов + wgStatus) в это окно
 * не укладывался в таймаут 5с — docker помечал работающий контейнер
 * как unhealthy, хотя приложение продолжало отвечать.
 *
 * Назначение остальных проверочных эндпоинтов:
 *  - /api/health    — диагностика (БД, файлы, схема), ВСЕГДА 200 с отчётом;
 *  - /api/dashboard — данные «Обзора», 500 при ошибке БД.
 */
export async function GET() {
  return NextResponse.json({ ok: true, uptime: process.uptime(), time: new Date().toISOString() })
}
