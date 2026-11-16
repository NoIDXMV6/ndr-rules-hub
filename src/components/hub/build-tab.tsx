'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, Dashboard, fmtSize, fmtTime } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Check, Copy, Download, FileArchive, Hammer, KeyRound, Link2, Save, Send } from 'lucide-react'

export function BuildTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, lang, loc } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [files, setFiles] = useState<Array<{ name: string; size: number; mtime: string }>>([])
  // PULL-схема: готовые URL отдачи + ключ serveToken (правится прямо здесь)
  const [origin, setOrigin] = useState('')
  const [serveToken, setServeToken] = useState('')
  const [serveBusy, setServeBusy] = useState(false)
  const [serveMsg, setServeMsg] = useState<string | null>(null)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  useEffect(() => {
    setServeToken(data?.settings?.serveToken ?? '')
  }, [data?.settings?.serveToken])

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
        setMsg(tr(t.messages.buildDone, {
          n: r.total?.toLocaleString(loc) ?? '—',
          file: r.fileName ?? '—',
          export: r.export ? (r.export.ok ? t.messages.buildExportDone : tr(t.messages.buildExportErr, { err: r.export.error ?? '—' })) : '',
        }))
      } else {
        setMsg(tr(t.messages.fetchErr, { err: r.error ?? '—' }))
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

  const tokenQs = serveToken ? `?token=${encodeURIComponent(serveToken)}` : ''
  const fileUrl = `${origin}/api/export${tokenQs}`
  const tgzUrl = serveToken ? `${origin}/api/export?archive=1&token=${encodeURIComponent(serveToken)}` : `${origin}/api/export?archive=1`

  const genServeToken = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    setServeToken(Array.from(bytes).map((v) => v.toString(16).padStart(2, '0')).join(''))
    setServeMsg(null)
  }

  const saveServeToken = async () => {
    setServeBusy(true)
    setServeMsg(null)
    try {
      await api.saveSettings({ ...(data?.settings ?? {}), serveToken })
      setServeMsg(t.build.serveTokenSaved)
      onChange()
    } catch (e) {
      setServeMsg(tr(t.messages.fetchErr, { err: (e as Error).message }))
    } finally {
      setServeBusy(false)
    }
  }

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
            <Link2 className="h-4 w-4 text-primary" /> {t.build.serveTitle}
          </CardTitle>
          <CardDescription>{t.build.serveDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ServeRow label={t.build.serveFile} url={fileUrl} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
          <ServeRow label={t.build.serveArchive} url={tgzUrl} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
          <div className="max-w-2xl">
            <Label className="text-foreground">{t.build.serveToken}</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              <Input
                value={serveToken}
                onChange={(e) => { setServeToken(e.target.value.trim()); setServeMsg(null) }}
                className="bg-card border-input font-mono flex-1 min-w-56"
                placeholder="32-hex…"
              />
              <Button variant="outline" className="border-input text-foreground shrink-0" onClick={genServeToken} title={t.build.serveTokenGen}>
                <KeyRound className="h-4 w-4 mr-1.5" /> {t.build.serveTokenGen}
              </Button>
              <Button onClick={saveServeToken} disabled={serveBusy} className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0">
                <Save className="h-4 w-4 mr-1.5" /> {t.build.serveTokenSave}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{t.build.serveTokenEmpty}</p>
            {serveMsg && <p className="text-xs text-emerald-700 mt-1">{serveMsg}</p>}
          </div>
          <div>
            <p className="text-sm font-medium text-foreground mb-1">{t.build.serveStepsTitle}</p>
            <ol className="list-decimal ml-5 space-y-1 text-sm text-muted-foreground">
              <li>{t.build.serveStep1}</li>
              <li>{t.build.serveStep2}</li>
              <li>{t.build.serveStep3}</li>
              <li>{t.build.serveStep4}</li>
            </ol>
          </div>
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

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}

function ServeRow({ label, url, copyLabel, copiedLabel }: { label: string; url: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (!url) return
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => undefined)
  }
  return (
    <div>
      <Label className="text-foreground">{label}</Label>
      <div className="mt-1 flex gap-2 items-center">
        <code className="flex-1 min-w-0 truncate rounded-md border border-border bg-muted px-2 py-1.5 text-xs font-mono text-foreground" title={url}>{url || '…'}</code>
        <Button size="sm" variant="outline" className="border-input text-foreground shrink-0" onClick={copy} disabled={!url}>
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />} {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
    </div>
  )
}
