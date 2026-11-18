'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { api, Dashboard, DownloadTokenItem, BuildProgressInfo, fmtSize, fmtTime } from '@/components/hub/api'
import { useI18n, type Lang } from '@/lib/i18n'
import { copyToClipboard } from '@/lib/utils'
import { Ban, Check, Copy, Download, FileArchive, Hammer, KeyRound, Plus, RotateCcw, Send, Trash2 } from 'lucide-react'

export function BuildTab({ data, onChange, role }: { data: Dashboard | null; onChange: () => void; role?: 'admin' | 'user' | 'anon' }) {
  const { t, tr, lang, loc } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [files, setFiles] = useState<Array<{ name: string; size: number; mtime: string }>>([])
  // прогресс сборки: POST /api/build запускает сборку фоном и возвращает jobId,
  // статус опрашивается из GET /api/build/progress (фаза + процент + журнал)
  const [prog, setProg] = useState<BuildProgressInfo | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  // адрес, с которого открыт хаб — для готовых URL подключения в карточке токенов
  const [origin, setOrigin] = useState('')

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

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

/** Токены скачивания правил (Enterprise): создание, готовые URL, отзыв/возврат/удаление */
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

  const restore = async (tk: DownloadTokenItem) => {
    setBusy(true)
    try {
      await api.restoreToken(tk.id)
      await refresh()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (tk: DownloadTokenItem) => {
    if (!window.confirm(tr(t.tokens.deleteConfirm, { name: tk.name }))) return
    setBusy(true)
    try {
      await api.deleteToken(tk.id)
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
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 space-y-2">
            <p className="text-xs text-emerald-800 font-medium">{t.tokens.created}</p>
            <div className="flex gap-2 items-center">
              <code className="flex-1 min-w-0 truncate rounded border border-emerald-300 bg-white px-2 py-1 text-xs font-mono text-emerald-900" title={created}>{created}</code>
              <CopyBtn text={created} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
            </div>
            {/* Адреса для Clear NDR — БЕЗ токена: токен (выше) вставляется в поле
                «Optional authorization key» источника. Так пользователь видит ровно
                то, что нужно вставить в каждое поле формы Clear NDR, без путаницы. */}
            <p className="text-xs text-emerald-800 font-medium pt-1">{t.tokens.createdUrlsTitle}</p>
            <ServeRow label={t.tokens.createdUrlFile} url={`${origin}/api/export`} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
            <ServeRow label={t.tokens.createdUrlArchive} url={`${origin}/api/export?archive=1`} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
            <p className="text-[11px] text-emerald-900/80">{t.tokens.authkeyHint}</p>
            <p className="text-[11px] text-emerald-900/80">{t.tokens.urlOriginNote}</p>
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

        {/* Подробная инструкция подключения Clear NDR по токену (PULL) —
            включая включение периодических обновлений в самом Clear NDR */}
        <details className="rounded-lg border border-border">
          <summary className="px-3 py-2 text-sm font-medium text-foreground cursor-pointer select-none">{t.tokens.howTitle}</summary>
          <ol className="list-decimal ml-5 px-3 pb-3 space-y-1.5 text-sm text-muted-foreground">
            <li>{t.tokens.howStep1}</li>
            <li>{t.tokens.howStep2}</li>
            <li>{t.tokens.howStep3}</li>
            <li>{t.tokens.howStep4}</li>
            <li>{t.tokens.howStep5}</li>
            <li>{t.tokens.howStep6}</li>
            <li>{t.tokens.howStep7}</li>
          </ol>
        </details>

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
                  const canManage = role === 'admin' || tk.own
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
                        {canManage && (
                          <div className="flex justify-end gap-1.5">
                            {!tk.revokedAt && !expired && (
                              <Button size="sm" variant="outline" className="border-amber-300 text-amber-700" disabled={busy} onClick={() => revoke(tk)} title={t.tokens.revoke}>
                                <Ban className="h-4 w-4" />
                              </Button>
                            )}
                            {tk.revokedAt && !expired && (
                              <Button size="sm" variant="outline" className="border-emerald-300 text-emerald-700" disabled={busy} onClick={() => restore(tk)} title={t.tokens.restore}>
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="border-red-300 text-red-600" disabled={busy} onClick={() => remove(tk)} title={t.tokens.deleteBtn}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {/* Полный токен в БД не хранится (SHA-256) — показывается один раз при создании;
            для существующих токенов виден только префикс. Адрес источника в Clear NDR
            от токена не зависит: Uri постоянный, ключ меняется в поле authkey. */}
        {tokens.length > 0 && <p className="text-xs text-muted-foreground mt-1">{t.tokens.prefixUrlNote}</p>}
      </CardContent>
    </Card>
  )
}

function CopyBtn({ text, copyLabel, copiedLabel }: { text: string; copyLabel: string; copiedLabel: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <div className="shrink-0">
      <Button
        size="sm"
        variant="outline"
        className="border-input text-foreground"
        onClick={async () => {
          setFailed(false)
          const ok = await copyToClipboard(text)
          if (ok) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          } else {
            setFailed(true)
            setTimeout(() => setFailed(false), 4000)
          }
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />} {copied ? copiedLabel : copyLabel}
      </Button>
      {failed && <p className="text-[11px] text-red-600 mt-1">{t.build.copyErr}</p>}
    </div>
  )
}

function ServeRow({ label, url, copyLabel, copiedLabel }: { label: string; url: string; copyLabel: string; copiedLabel: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copy = async () => {
    if (!url) return
    setFailed(false)
    const ok = await copyToClipboard(url)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      setFailed(true)
      setTimeout(() => setFailed(false), 4000)
    }
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
      {failed && <p className="text-[11px] text-red-600 mt-1">{t.build.copyErr}</p>}
    </div>
  )
}
