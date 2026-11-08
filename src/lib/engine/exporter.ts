// ─────────────────────────────────────────────────────────────────────────────
// Экспорт итогового набора: локальный файл + выгрузка в Clear NDR
//
// Режим 'clearndr' — нативная интеграция с REST API Scirius (движок правил
// Clear NDR, /rest/…, аутентификация Authorization: Token <токен>):
//   1. найти (при отсутствии — создать) локальный источник правил;
//   2. POST /rest/rules/source/<pk>/upload/      — multipart-загрузка файла;
//   3. POST /rest/suricata/update_push_all/      — пересобрать набор,
//      применить к Suricata и перезапустить движок.
// Эндпоинты проверены по исходникам Scirius (StamusNetworks/scirius):
//   rules/rest_api.py — SourceViewSet.upload / SuricataViewSet.update_push_all.
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from 'fs'
import path from 'path'
import { EXPORTS_DIR } from './fetcher'

export interface ClearndrExportCfg {
  mode: 'file' | 'clearndr' | 'http' | 'local-path' | 'disabled'
  url?: string          // 'clearndr': базовый URL Clear NDR (например, https://clearndr.local);
                        // 'http': полный адрес POST-эндпоинта
  token?: string        // API-токен (Scirius: UI → пользователь → Edit Token → Regenerate)
  authType?: 'token' | 'bearer' | 'none' // формат заголовка Authorization (по умолчанию token)
  sourceName?: string   // 'clearndr': имя локального источника в Clear NDR
  apply?: boolean       // 'clearndr': вызывать update_push_all после загрузки
  localPath?: string    // каталог/файл, куда копировать (смонтированный в clearndr)
  restartSuricata?: boolean
}

export interface ExportResult {
  ok: boolean
  error?: string
  filePath?: string
  fileName?: string
  pushedTo?: string
  detail?: string
}

const TIMEOUT_MS = 120_000

/** Заголовок авторизации в формате, ожидаемом Clear NDR (Scirius, DRF) */
function authHeaders(cfg: ClearndrExportCfg): Record<string, string> {
  if (!cfg.token) return {}
  const type = cfg.authType ?? 'token'
  if (type === 'bearer') return { Authorization: `Bearer ${cfg.token}` }
  if (type === 'token') return { Authorization: `Token ${cfg.token}` }
  return {}
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'токен отклонён — проверьте токен (Clear NDR → меню пользователя → Edit Token → Regenerate) и права пользователя (rules.source_edit, rules.ruleset_update_push)'
  }
  return `HTTP ${status}`
}

/** Сохранить итоговый файл в каталог экспортов */
export async function saveExportFile(fileName: string, content: string): Promise<{ filePath: string; sizeBytes: number }> {
  await fs.mkdir(EXPORTS_DIR, { recursive: true })
  const filePath = path.join(EXPORTS_DIR, fileName)
  await fs.writeFile(filePath, content)
  return { filePath, sizeBytes: Buffer.byteLength(content) }
}

/** Отправить файл в Clear NDR выбранным способом */
export async function pushToClearndr(
  filePath: string,
  cfg: ClearndrExportCfg
): Promise<ExportResult> {
  try {
    if (cfg.mode === 'disabled') return { ok: true, detail: 'автоэкспорт отключён (режим «файл»)' }
    const buf = await fs.readFile(filePath)

    if (cfg.mode === 'local-path' && cfg.localPath) {
      await fs.mkdir(cfg.localPath, { recursive: true })
      const dest = path.join(cfg.localPath, path.basename(filePath))
      await fs.writeFile(dest, buf)
      return { ok: true, pushedTo: dest, detail: 'файл скопирован в каталог импорта Clear NDR' }
    }

    if (cfg.mode === 'http' && cfg.url) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)]), path.basename(filePath))
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: authHeaders(cfg),
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        return { ok: false, error: `Clear NDR вернул ${describeStatus(res.status)}: ${(await res.text()).slice(0, 200)}` }
      }
      return { ok: true, pushedTo: cfg.url, detail: await res.text().catch(() => 'OK') }
    }

    if (cfg.mode === 'clearndr' && cfg.url) {
      return await pushToClearndrRest(filePath, buf, cfg)
    }

    return { ok: false, error: `не настроен режим экспорта: ${cfg.mode}` }
  } catch (e) {
    return { ok: false, error: `ошибка экспорта: ${(e as Error).message}` }
  }
}

/**
 * Нативная отправка в Clear NDR через REST API Scirius:
 * найти/создать источник → upload → update_push_all.
 */
async function pushToClearndrRest(
  filePath: string,
  buf: Buffer,
  cfg: ClearndrExportCfg
): Promise<ExportResult> {
  const base = (cfg.url ?? '').replace(/\/+$/, '')
  const sourceName = cfg.sourceName?.trim() || 'NDR Rules Hub'
  const headers = { ...authHeaders(cfg), 'Content-Type': 'application/json', Accept: 'application/json' }
  const steps: string[] = []

  // ── Шаг 1: найти источник по имени (создать, если нет) ────────────────────
  // DRF Scirius пагинирует списки: {"count": N, "next": …, "results": […]}
  let srcId: number | null = null
  const listRes = await fetch(
    `${base}/rest/rules/source/?name=${encodeURIComponent(sourceName)}`,
    { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
  )
  if (listRes.status === 401 || listRes.status === 403) {
    return { ok: false, error: `Clear NDR: не удалось получить список источников — ${describeStatus(listRes.status)}` }
  }
  if (!listRes.ok) {
    return { ok: false, error: `Clear NDR: GET /rest/rules/source/ вернул HTTP ${listRes.status} — проверьте базовый URL (должен быть корень, без /rest)` }
  }
  const payload: unknown = await listRes.json()
  const items = Array.isArray(payload)
    ? (payload as Array<{ pk: number; name: string }>)
    : Array.isArray((payload as { results?: unknown })?.results)
      ? ((payload as { results: Array<{ pk: number; name: string }> }).results)
      : []
  const found = items.find((s) => s.name === sourceName)
  if (found) {
    srcId = found.pk
    steps.push(`источник «${sourceName}» найден (pk=${srcId})`)
  } else {
    const createRes = await fetch(`${base}/rest/rules/source/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: sourceName,
        method: 'local',
        datatype: 'sig',
        use_sys_proxy: false,
        comment: 'создан автоматически NDR Rules Hub',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!createRes.ok) {
      return { ok: false, error: `Clear NDR: не удалось создать источник «${sourceName}» — HTTP ${createRes.status}: ${(await createRes.text()).slice(0, 200)}` }
    }
    const created = (await createRes.json()) as { pk: number }
    srcId = created.pk
    steps.push(`источник «${sourceName}» создан (pk=${srcId})`)
  }

  // ── Шаг 2: multipart-загрузка файла (upload импортирует правила сразу) ────
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buf)]), path.basename(filePath))
  form.append('comment', `NDR Rules Hub: ${path.basename(filePath)}`)
  const uploadRes = await fetch(`${base}/rest/rules/source/${srcId}/upload/`, {
    method: 'POST',
    headers: authHeaders(cfg), // multipart — без Content-Type: application/json
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!uploadRes.ok) {
    const text = (await uploadRes.text().catch(() => '')).slice(0, 300)
    if (/conflicting SID|Duplicate sids/i.test(text)) {
      return { ok: false, error: `Clear NDR отклонил файл: конфликт SID (${text}). Включите дедупликацию в настройках сборки` }
    }
    return { ok: false, error: `Clear NDR: загрузка файла отклонена — ${describeStatus(uploadRes.status)}: ${text}` }
  }
  steps.push(`файл ${path.basename(filePath)} загружен и импортирован (${(buf.length / 1e6).toFixed(1)} МБ)`)

  // ── Шаг 3: применить набор (пересборка + push + перезапуск Suricata) ─────
  if (cfg.apply !== false) {
    const applyRes = await fetch(`${base}/rest/suricata/update_push_all/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ comment: 'NDR Rules Hub: применить обновлённый набор' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!applyRes.ok) {
      const text = (await applyRes.text().catch(() => '')).slice(0, 300)
      return { ok: false, error: `файл загружен, но применение не удалось — ${describeStatus(applyRes.status)}: ${text}. Правила уже в базе Clear NDR; примените их вручную (Rulesets → Update)` }
    }
    steps.push('набор применён к Suricata (update_push_all: ok)')
  } else {
    steps.push('применение отключено — правила загружены в базу Clear NDR, примените набор вручную')
  }

  return { ok: true, pushedTo: base, detail: steps.join('; ') }
}
