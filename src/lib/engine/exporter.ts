// ─────────────────────────────────────────────────────────────────────────────
// Экспорт итогового набора: локальный файл + выгрузка в Clear NDR
// ─────────────────────────────────────────────────────────────────────────────
import { promises as fs } from 'fs'
import path from 'path'
import { EXPORTS_DIR } from './fetcher'

export interface ClearndrExportCfg {
  mode: 'file' | 'http' | 'local-path' | 'disabled'
  url?: string          // HTTP endpoint Clear NDR (например, http://clearndr:8080/api/rules/import)
  token?: string        // Bearer token, если требуется
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
        headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
        body: form,
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) {
        return { ok: false, error: `Clear NDR вернул HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
      }
      return { ok: true, pushedTo: cfg.url, detail: await res.text().catch(() => 'OK') }
    }

    return { ok: false, error: `не настроен режим экспорта: ${cfg.mode}` }
  } catch (e) {
    return { ok: false, error: `ошибка экспорта: ${(e as Error).message}` }
  }
}
