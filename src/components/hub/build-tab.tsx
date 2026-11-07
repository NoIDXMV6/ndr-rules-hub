'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, Dashboard, fmtSize, fmtTime } from '@/components/hub/api'
import { Download, FileArchive, Hammer, Send } from 'lucide-react'

export function BuildTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [files, setFiles] = useState<Array<{ name: string; size: number; mtime: string }>>([])

  const loadFiles = useCallback(async () => {
    try {
      const r = await api.exportFiles()
      setFiles(r.files)
    } catch {
      setFiles([])
    }
  }, [])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const doBuild = async (exportAfter: boolean) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.build(exportAfter)
      if (r.ok) {
        setMsg(`Собрано ${r.total?.toLocaleString('ru-RU')} правил → ${r.fileName}${r.export ? ` · экспорт: ${r.export.ok ? 'выполнен' : r.export.error}` : ''}`)
      } else {
        setMsg(`Ошибка: ${r.error}`)
      }
      onChange()
      await loadFiles()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doExport = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.exportPush()
      setMsg(r.ok ? `Экспорт выполнен: ${r.pushedTo ?? r.detail ?? 'ок'}` : `Ошибка экспорта: ${r.error}`)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const b = data?.lastBuild
  const mode = data?.settings.clearndrExportMode ?? 'file'

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <CardTitle className="text-base">Сборка итогового набора</CardTitle>
              <CardDescription>
                Объединение включённых источников → дедупликация → устранение конфликтов SID → финальный файл
              </CardDescription>
            </div>
            <Button onClick={() => doBuild(false)} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Hammer className={`h-4 w-4 mr-1.5 ${busy ? 'animate-pulse' : ''}`} /> Собрать
            </Button>
            <Button onClick={doExport} disabled={busy || !b} variant="outline" className="border-input text-foreground">
              <Send className="h-4 w-4 mr-1.5" /> Выгрузить в Clear NDR ({mode === 'file' ? 'файл' : mode === 'http' ? 'HTTP' : mode === 'local-path' ? 'каталог' : mode})
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {msg && <p className="text-sm mb-3 text-emerald-700">{msg}</p>}
          {b ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline" className="border-input text-foreground">{fmtTime(b.createdAt)}</Badge>
                <Badge variant="outline" className="border-input text-foreground">{b.totalRules.toLocaleString('ru-RU')} правил</Badge>
                <Badge variant="outline" className="border-input text-foreground">{fmtSize(b.sizeBytes)}</Badge>
                <Badge variant="outline" className="border-input text-foreground">{b.fileName}</Badge>
                <Badge variant="outline" className={b.source === 'cron' ? 'border-sky-700 text-sky-700' : 'border-input text-muted-foreground'}>{b.source === 'cron' ? 'по расписанию' : 'вручную'}</Badge>
                <a href="/api/export" download className="ml-auto">
                  <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground">
                    <Download className="h-4 w-4 mr-1.5" /> Скачать
                  </Button>
                </a>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <MiniStat label="Правил на входе" value={b.stats.totalInputRules?.toLocaleString('ru-RU') ?? '—'} />
                <MiniStat label="Дубликатов SID" value={b.stats.duplicateBySid?.toLocaleString('ru-RU') ?? '—'} />
                <MiniStat label="Дубликатов содержимого" value={b.stats.duplicateByContent?.toLocaleString('ru-RU') ?? '—'} />
                <MiniStat label="Несовместимых убрано" value={b.stats.incompatibleDropped?.toLocaleString('ru-RU') ?? '—'} />
                <MiniStat label="Итог (уникальных SID)" value={b.stats.uniqueSids?.toLocaleString('ru-RU') ?? '—'} />
              </div>
              <div className="rounded-lg border border-border overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0">
                    <tr className="text-muted-foreground text-left">
                      <th className="px-3 py-2 font-medium">Источник</th>
                      <th className="px-3 py-2 font-medium">Загружено</th>
                      <th className="px-3 py-2 font-medium">В сборке</th>
                      <th className="px-3 py-2 font-medium">Сброшено SID</th>
                      <th className="px-3 py-2 font-medium">Сброшено по содерж.</th>
                      <th className="px-3 py-2 font-medium">Несовмест.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(b.stats.perSource ?? {}).map(([name, st]) => (
                      <tr key={name} className="border-t border-border/60 text-foreground">
                        <td className="px-3 py-1.5 max-w-72 truncate">{name}</td>
                        <td className="px-3 py-1.5 tabular-nums">{st.total.toLocaleString('ru-RU')}</td>
                        <td className="px-3 py-1.5 tabular-nums text-emerald-700">{st.kept.toLocaleString('ru-RU')}</td>
                        <td className="px-3 py-1.5 tabular-nums text-amber-700">{st.droppedSid.toLocaleString('ru-RU')}</td>
                        <td className="px-3 py-1.5 tabular-nums text-amber-700">{st.droppedContent.toLocaleString('ru-RU')}</td>
                        <td className="px-3 py-1.5 tabular-nums text-red-600">{st.droppedCompat.toLocaleString('ru-RU')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Сборка ещё не выполнялась. Включите источники и нажмите «Собрать».
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileArchive className="h-4 w-4 text-primary" /> Файлы в каталоге экспорта (data/exports)
          </CardTitle>
          <CardDescription>Готовые к импорту файлы правил (в Docker — смонтируйте volume и укажите путь в Clear NDR)</CardDescription>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">Пока нет файлов.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {files.map((f) => (
                <li key={f.name} className="flex flex-wrap gap-x-4 text-foreground border-b border-border/60 py-1">
                  <code className="text-emerald-700">{f.name}</code>
                  <span className="text-muted-foreground">{fmtSize(f.size)}</span>
                  <span className="text-muted-foreground">{fmtTime(f.mtime)}</span>
                  <a href={`/api/export`} download className="ml-auto text-emerald-700 hover:underline text-xs">последний файл</a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}
