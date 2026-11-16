// ─────────────────────────────────────────────────────────────────────────────
// Отдача итогового набора правил по HTTP (PULL-схема): Clear NDR (scirius)
// подключает итоговый файл URL-источником (Source.method='http') и штатным
// планировщиком (celery, Suricata → Update → Recurrence) забирает его сам.
// Два формата отдачи:
//   • одиночный .rules-файл       — GET /api/export               (datatype «sig»);
//   • tgz-архив по источникам     — GET /api/export?archive=1     (datatype «sigs»:
//     scirius handle_rules_in_tar раскладывает каждый файл архива в rules/
//     отдельной категорией; допускаются файлы в корне архива, но НЕ две
//     директории «rules» — наш архив плоский и этому соответствует).
// Защита: настройка serveToken (вкладка «Сборка» → «Отдача по URL»). Ключ
// принимается из ?token= или из заголовка Authorization: при заполненном поле
// authkey источника scirius шлёт ровно его («Authorization: <authkey>»,
// rules/models.py → update_ruleset_http). Пустая настройка = отдача открыта.
// ВАЖНО: scirius НЕ проверяет HTTP-статус ответа URL-источника
// (update_ruleset_http пишет resp.content в файл как есть) — поэтому тексты
// ошибок здесь внятные: при неверном ключе источник упадёт на разборе правил,
// и текст ошибки сразу покажет причину.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { getSetting } from './service'
import { promises as fs } from 'fs'

export interface ServeResult {
  status: number
  contentType: string
  fileName?: string
  body: string | Buffer
}

const TEXT = 'text/plain; charset=utf-8'

/** Последний «кусок» заголовка Authorization: «K1», «Token K1», «Bearer K1» → «K1» */
export function tokenFromAuthHeader(h?: string | null): string | undefined {
  if (!h) return undefined
  const parts = h.trim().split(/\s+/)
  return parts[parts.length - 1] || undefined
}

/** Отдать последнюю сборку: файл или архив, с проверкой ключа отдачи */
export async function serveBuild(opts: { archive?: boolean; token?: string; authHeader?: string | null } = {}): Promise<ServeResult> {
  const cfg = (await getSetting('serveToken')).trim()
  if (cfg) {
    const provided = (opts.token?.trim() || tokenFromAuthHeader(opts.authHeader) || '')
    if (provided !== cfg) {
      return {
        status: 403,
        contentType: TEXT,
        body: 'NDR Rules Hub: доступ запрещён — неверный ключ отдачи. Добавьте к URL ?token=<ключ> или заполните поле authkey источника в Clear NDR этим ключом (ключ задаётся на вкладке «Сборка» → «Отдача по URL»).',
      }
    }
  }

  const build = await db.build.findFirst({ orderBy: { createdAt: 'desc' } })
  if (!build) {
    return { status: 404, contentType: TEXT, body: 'NDR Rules Hub: нет сборок — сначала выполните сборку (вкладка «Сборка»).' }
  }

  if (opts.archive) {
    const stats = JSON.parse(build.statsJson || '{}') as { archive?: { filePath: string; fileName: string } }
    if (!stats.archive) {
      return { status: 404, contentType: TEXT, body: 'NDR Rules Hub: в этой сборке нет tgz-архива — включите «Формат сборки: файл + tgz» в настройках и пересоберите набор.' }
    }
    try {
      const content = await fs.readFile(stats.archive.filePath)
      return { status: 200, contentType: 'application/gzip', fileName: stats.archive.fileName, body: content }
    } catch {
      return { status: 404, contentType: TEXT, body: `NDR Rules Hub: файл архива не найден на диске: ${stats.archive.filePath}` }
    }
  }

  try {
    const content = await fs.readFile(build.filePath)
    return { status: 200, contentType: TEXT, fileName: build.fileName, body: content }
  } catch {
    return { status: 404, contentType: TEXT, body: `NDR Rules Hub: файл сборки не найден на диске: ${build.filePath} — пересоберите набор.` }
  }
}
