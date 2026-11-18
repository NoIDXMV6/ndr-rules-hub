import { describe, it, expect } from 'vitest'

// Docker healthcheck живёт на /api/ping: лёгкий эндпоинт БЕЗ обращения к БД.
// Фоновая сборка (v1.24+) занимает единственную SQLite-коннекцию
// (connection_limit=1) и нагружает event loop — тяжёлый healthcheck
// (раньше /api/dashboard) не укладывался в таймаут и помечал контейнер
// как unhealthy во время нормальной сборки.

describe('GET /api/ping (docker healthcheck)', () => {
  it('отвечает 200 {ok:true} без обращения к БД и guard-ов', async () => {
    const { GET } = await import('@/app/api/ping/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const j = (await res.json()) as { ok: boolean; uptime: number; time: string }
    expect(j.ok).toBe(true)
    expect(typeof j.uptime).toBe('number')
    expect(Number.isFinite(new Date(j.time).getTime())).toBe(true)
  })

  it('не тянет модуль БД (нет конкуренции за SQLite-коннекцию при сборке)', async () => {
    const src = await import('fs').then((fs) => fs.promises.readFile('src/app/api/ping/route.ts', 'utf8'))
    expect(src).not.toMatch(/from\s+['"]@\/lib\/db['"]/)
    expect(src).not.toMatch(/from\s+['"]@prisma\/client['"]/)
  })
})
