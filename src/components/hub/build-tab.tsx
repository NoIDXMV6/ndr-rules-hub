'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { api, Dashboard, BuildProgressInfo, fmtSize, fmtTime } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Download, FileArchive, Hammer, Send } from 'lucide-react'

// Токены скачивания («Токены и доступ») переехали в раздел «Аккаунт» (tokens-card.tsx)

export function BuildTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, lang, loc } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [files, setFiles] = useState<Array<{ name: string; size: number; mtime: string }>>([])
  // прогресс сборки: POST /api/build запускает сборку фоном и возвращает jobId,
  // статус опрашивается из GET /api/build/progress (фаза + процент + журнал)
  const [prog, setProg] = useState<BuildProgressInfo | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
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

  // если сборка уже идёт (запущена другим окном или по cron) — сразу показываем прогресс
  useEffect(() => {
    api.buildProgress().then((r) => {
      if (r.progress?.active) setProg(r.progress)
    }).catch(() => undefined)
  }, [])

  // автопрокрутка журнала сборки
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [prog?.log.length])

  const doBuild = async (exportAfter: boolean) => {
    setBusy(true)
    setMsg(null)
    try {
      // запуск фоном + опрос прогресса (фаза/процент/журнал) до завершения сборки
      const res = await api.buildWait(exportAfter, (p) => setProg(p))
      if (res?.ok) {
        // вердикт по изменениям набора vs предыдущей сборки: нужен ли переимпорт в Clear NDR
        const changes = res.changes
          ? (res.unchanged
              ? t.messages.buildNoChanges
              : tr(t.messages.buildChanges, { a: res.changes.added, c: res.changes.changed, rm: res.changes.removed }))
          : ''
        setMsg(tr(t.messages.buildDone, {
          n: res.total?.toLocaleString(loc) ?? '—',
          file: res.fileName ?? '—',
          changes,
          export: res.export ? (res.export.ok ? t.messages.buildExportDone : tr(t.messages.buildExportErr, { err: res.export.error ?? '—' })) : '',
        }))
      } else {
        setMsg(tr(t.messages.fetchErr, { err: res?.error ?? '—' }))
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
      setMsg(r.ok ? tr(t.messages.exportDone, { d: r.pushedTo ?? r.detail ?? 'ok' }) : tr(t.messages.exportErr, { err: r.error ?? '—' }))
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const b = data?.lastBuild
  const mode = data?.settings.clearndrExportMode ?? 'file'
  // диф последней сборки vs предыдущей: «что изменилось в итоговом наборе»
  const chg = b?.stats?.changes
  const chgUnchanged = !!chg && chg.added + chg.changed + chg.removed === 0
  const chgTitle = chg ? tr(t.build.changesHint, { a: chg.added, c: chg.changed, rm: chg.removed }) : undefined
  const showProg = busy && !!prog

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <CardTitle className="text-base">{t.build.title}</CardTitle>
              <CardDescription>{t.build.desc}</CardDescription>
            </div>
            <Button onClick={() => doBuild(false)} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Hammer className={`h-4 w-4 mr-1.5 ${busy ? 'animate-pulse' : ''}`} /> {t.build.run}
            </Button>
            <Button onClick={doExport} disabled={busy || !b} variant="outline" className="border-input text-foreground">
              <Send className="h-4 w-4 mr-1.5" /> {tr(t.build.exportTo, { mode: mode === 'file' ? t.build.modeFile : mode === 'clearndr' ? t.build.modeClearndr : mode === 'http' ? t.build.modeHttp : mode === 'local-path' ? t.build.modeLocal : mode })}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {showProg && prog && (
            <div className="mb-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium text-foreground">
                  {tr(t.build.progTitle, { stage: stageLabel(t, prog.stage) })}
                </span>
                <span className="text-muted-foreground tabular-nums">{prog.percent}%</span>
              </div>
              <Progress value={prog.percent} />
              <pre
                ref={logRef}
                className="rounded-lg border border-border bg-zinc-950 text-zinc-100 p-3 text-xs font-mono max-h-48 overflow-auto whitespace-pre-wrap"
              >
                {(prog.log.map((l) => l.msg).join('\n')) || '…'}
              </pre>
            </div>
          )}
          {msg && <p className="text-sm mb-3 text-emerald-700">{msg}</p>}
          {b ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline" className="border-input text-foreground">{fmtTime(b.createdAt, lang)}</Badge>
                <Badge variant="outline" className="border-input text-foreground">{tr(t.build.badgeRules, { n: b.totalRules.toLocaleString(loc) })}</Badge>
                <Badge variant="outline" className="border-input text-foreground">{fmtSize(b.sizeBytes, lang)}</Badge>
                <Badge variant="outline" className="border-input text-foreground">{b.fileName}</Badge>
                {b.stats?.archive ? (
                  <Badge variant="outline" className="border-input text-foreground"><FileArchive className="h-3 w-3 mr-1 inline" />{b.stats.archive.fileName}</Badge>
                ) : null}
                <Badge variant="outline" className={b.source === 'cron' ? 'border-sky-700 text-sky-700' : 'border-input text-muted-foreground'}>{b.source === 'cron' ? t.build.bySchedule : t.build.manual}</Badge>
                {chg && (
                  <Badge
                    variant="outline"
                    title={chgTitle}
                    className={chgUnchanged ? 'border-emerald-300 text-emerald-700' : 'border-amber-300 text-amber-700'}
                  >
                    {chgUnchanged ? t.build.changesNone : tr(t.build.changesBadge, { a: chg.added, c: chg.changed, rm: chg.removed })}
                  </Badge>
                )}
                <a href="/api/export" download className="ml-auto">
                  <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground">
                    <Download className="h-4 w-4 mr-1.5" /> {t.build.download}
                  </Button>
                </a>
                {b.stats?.archive ? (
                  <a href="/api/export?archive=1" download>
                    <Button size="sm" variant="outline" className="border-input text-foreground">
                      <FileArchive className="h-4 w-4 mr-1.5" /> {t.build.downloadArchive}
                    </Button>
                  </a>
                ) : null}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
                <MiniStat label={t.build.statInput} value={b.stats.totalInputRules?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.build.statDupSid} value={b.stats.duplicateBySid?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.build.statDupContent} value={b.stats.duplicateByContent?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.build.statIncompat} value={b.stats.incompatibleDropped?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.build.statExcludedCat} value={b.stats.excludedByCategory?.toLocaleString(loc) ?? '0'} />
                <MiniStat label={t.build.statExcludedRule} value={b.stats.excludedByRule?.toLocaleString(loc) ?? '0'} />
                <MiniStat label={t.build.statFinal} value={b.stats.uniqueSids?.toLocaleString(loc) ?? '—'} />
              </div>
              <div className="rounded-lg border border-border overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0">
                    <tr className="text-muted-foreground text-left">
                      <th className="px-3 py-2 font-medium">{t.build.thSource}</th>
                      <th className="px-3 py-2 font-medium">{t.build.thFetched}</th>
                      <th className="px-3 py-2 font-medium">{t.build.thInBuild}</th>
                      <th className="px-3 py-2 font-medium">{t.build.thDroppedSid}</th>
                      <th className="px-3 py-2 font-medium">{t.build.thDroppedContent}</th>
                      <th className="px-3 py-2 font-medium">{t.build.thIncompat}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(b.stats.perSource ?? {}).map(([name, st]) => (
                      <tr key={name} className="border-t border-border/60 text-foreground">
                        <td className="px-3 py-1.5 max-w-72 truncate">{name}</td>
                        <td className="px-3 py-1.5 tabular-nums">{st.total.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-emerald-700">{st.kept.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-amber-700">{st.droppedSid.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-amber-700">{st.droppedContent.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-red-600">{st.droppedCompat.toLocaleString(loc)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t.build.noBuild}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileArchive className="h-4 w-4 text-primary" /> {t.build.filesTitle}
          </CardTitle>
          <CardDescription>{t.build.filesDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.build.noFiles}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {files.map((f) => (
                <li key={f.name} className="flex flex-wrap gap-x-4 text-foreground border-b border-border/60 py-1">
                  <code className="text-emerald-700">{f.name}</code>
                  <span className="text-muted-foreground">{fmtSize(f.size, lang)}</span>
                  <span className="text-muted-foreground">{fmtTime(f.mtime, lang)}</span>
                  <a href={`/api/export`} download className="ml-auto text-emerald-700 hover:underline text-xs">{t.build.latestFile}</a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Локализованное название фазы сборки (коды фаз — из build-progress.ts) */
function stageLabel(t: ReturnType<typeof useI18n>['t'], stage: string): string {
  const map = t.build.progStage as Record<string, string | undefined>
  return map[stage] ?? stage
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}
