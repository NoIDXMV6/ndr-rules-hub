'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, Dashboard, DownloadTokenItem, fmtSize, fmtTime } from '@/components/hub/api'
import { useI18n, type Lang } from '@/lib/i18n'
import { Check, Copy, Download, FileArchive, Hammer, KeyRound, Link2, Plus, Save, Send, Trash2 } from 'lucide-react'

export function BuildTab({ data, onChange, role }: { data: Dashboard | null; onChange: () => void; role?: 'admin' | 'user' | 'anon' }) {
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
        // вердикт по изменениям набора vs предыдущей сборки: нужен ли переимпорт в Clear NDR
        const changes = r.changes
          ? (r.unchanged
              ? t.messages.buildNoChanges
              : tr(t.messages.buildChanges, { a: r.changes.added, c: r.changes.changed, rm: r.changes.removed }))
          : ''
        setMsg(tr(t.messages.buildDone, {
          n: r.total?.toLocaleString(loc) ?? '—',
          file: r.fileName ?? '—',
          changes,
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
  // диф последней сборки vs предыдущей: «что изменилось в итоговом наборе»
  const chg = b?.stats?.changes
  const chgUnchanged = !!chg && chg.added + chg.changed + chg.removed === 0
  const chgTitle = chg ? tr(t.build.changesHint, { a: chg.added, c: chg.changed, rm: chg.removed }) : undefined

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

      {/* PULL-карточка с глобальным ключом serveToken — только админ (у пользователя свои токены) */}
      {role !== 'user' ? (
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
      ) : null}

      {/* Токены скачивания (Enterprise): у пользователя — только свои, у админа — все */}
      {role === 'admin' || role === 'user' ? (
        <TokensCard role={role === 'user' ? 'user' : 'admin'} origin={origin} lang={lang} />
      ) : null}

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

/** Токены скачивания правил (Enterprise): создание, готовые URL, отзыв */
function TokensCard({ role, origin, lang }: { role: 'admin' | 'user'; origin: string; lang: Lang }) {
  const { t, tr, loc } = useI18n()
  const [tokens, setTokens] = useState<DownloadTokenItem[]>([])
  const [name, setName] = useState('')
  const [ttlDays, setTtlDays] = useState('0')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string | null>(null) // полный токен — показывается один раз
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api.tokens()
      setTokens(r.tokens)
    } catch {
      setTokens([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.createToken({ name: name.trim() || 'Токен', ttlDays: parseInt(ttlDays, 10) || 0 })
      if (r.ok && r.token) {
        setCreated(r.token.token)
        setName('')
        setTtlDays('0')
        await refresh()
      } else {
        setMsg(r.error ?? 'error')
      }
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (tk: DownloadTokenItem) => {
    if (!window.confirm(tr(t.tokens.revokeConfirm, { name: tk.name }))) return
    setBusy(true)
    try {
      await api.revokeToken(tk.id)
      await refresh()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" /> {t.tokens.title}
        </CardTitle>
        <CardDescription>{role === 'admin' ? t.tokens.descAdmin : t.tokens.descUser}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {created && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 space-y-1">
            <p className="text-xs text-emerald-800 font-medium">{t.tokens.created}</p>
            <div className="flex gap-2 items-center">
              <code className="flex-1 min-w-0 truncate rounded border border-emerald-300 bg-white px-2 py-1 text-xs font-mono text-emerald-900" title={created}>{created}</code>
              <CopyBtn text={created} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-end">
          <div className="min-w-44 flex-1">
            <Label className="text-foreground">{t.tokens.nameLabel}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="bg-card border-input mt-1" placeholder="Clear NDR node 1" />
          </div>
          <div className="w-44">
            <Label className="text-foreground">{t.tokens.ttlLabel}</Label>
            <Input type="number" min={0} max={365} value={ttlDays} onChange={(e) => setTtlDays(e.target.value)} className="bg-card border-input mt-1" />
          </div>
          <Button onClick={create} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus className="h-4 w-4 mr-1.5" /> {t.tokens.createBtn}
          </Button>
        </div>
        {msg && <p className="text-sm text-red-600">{msg}</p>}

        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.tokens.empty}</p>
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr className="text-muted-foreground text-left">
                  <th className="px-3 py-2 font-medium">{t.tokens.thName}</th>
                  <th className="px-3 py-2 font-medium">{t.tokens.thPrefix}</th>
                  {role === 'admin' && <th className="px-3 py-2 font-medium">{t.tokens.thOwner}</th>}
                  <th className="px-3 py-2 font-medium">{t.tokens.thLastUsed}</th>
                  <th className="px-3 py-2 font-medium">{t.tokens.thDownloads}</th>
                  <th className="px-3 py-2 font-medium">{t.tokens.thExpires}</th>
                  <th className="px-3 py-2 font-medium text-right">{t.tokens.thActions}</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((tk) => {
                  const expired = tk.expiresAt ? new Date(tk.expiresAt).getTime() < Date.now() : false
                  return (
                    <tr key={tk.id} className="border-t border-border/60 text-foreground">
                      <td className="px-3 py-1.5">{tk.name}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {tk.prefix}…
                        {tk.revokedAt && <Badge variant="outline" className="ml-1.5 border-red-300 text-red-600">{t.tokens.revokedBadge}</Badge>}
                        {!tk.revokedAt && expired && <Badge variant="outline" className="ml-1.5 border-amber-400 text-amber-700">{t.tokens.expiredBadge}</Badge>}
                      </td>
                      {role === 'admin' && <td className="px-3 py-1.5 text-muted-foreground">{tk.owner}</td>}
                      <td className="px-3 py-1.5 text-muted-foreground">{tk.lastUsedAt ? fmtTime(tk.lastUsedAt, lang) : t.tokens.neverUsed}</td>
                      <td className="px-3 py-1.5 tabular-nums">{tk.downloadCount.toLocaleString(loc)}{tk.bytesServed > 0 ? ` · ${fmtSize(tk.bytesServed, lang)}` : ''}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{tk.expiresAt ? fmtTime(tk.expiresAt, lang) : t.tokens.noExpiry}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex justify-end gap-1.5">
                          {role === 'user' && tk.own && !tk.revokedAt && !expired && (
                            <CopyBtn
                              text={`${origin}/api/export?token=<${t.tokens.thPrefix.toLowerCase()}>`}
                              copyLabel={t.tokens.urlFile}
                              copiedLabel={t.build.serveCopied}
                            />
                          )}
                          {!tk.revokedAt && (
                            <Button size="sm" variant="outline" className="border-red-300 text-red-600" disabled={busy} onClick={() => revoke(tk)} title={t.tokens.revoke}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CopyBtn({ text, copyLabel, copiedLabel }: { text: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      className="border-input text-foreground shrink-0"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => undefined)
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />} {copied ? copiedLabel : copyLabel}
    </Button>
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
