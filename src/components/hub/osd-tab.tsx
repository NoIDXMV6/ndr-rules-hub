'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «Дашборды OpenSearch»: состояние OSD (кластер, плагины, данные),
// применение аналитики (Alerting / Anomaly / Security Analytics) и каталог
// дополнительных дашбордов (packs) с импортом в .kibana.
// Оркестрация — /api/clearndr-osd; исполнение — на хосте по схеме раздела
// «Обновление Clear NDR» (настройки соединения общие).
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { api, fmtTime, type OsdRunStatus, type OsdStatus } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import {
  BarChart3, CheckCircle2, Download, Loader2, Plug, RefreshCw, ShieldCheck,
  Terminal, Trash2, TriangleAlert, XCircle,
} from 'lucide-react'

const PACK_KEYS = ['traffic', 'http', 'dns', 'tls', 'alerts', 'files'] as const
type PackKey = (typeof PACK_KEYS)[number]

const APPLY_KINDS = ['alerting', 'anomaly', 'security'] as const
type ApplyKind = (typeof APPLY_KINDS)[number]

export function OsdTab({ onChange }: { data: unknown; onChange: () => void }) {
  const { t, tr, lang } = useI18n()
  const [st, setSt] = useState<OsdStatus | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<PackKey>>(new Set(['traffic', 'alerts']))
  const [applyWhat, setApplyWhat] = useState<Set<ApplyKind>>(new Set(APPLY_KINDS))
  const [dryRun, setDryRun] = useState(false)
  const [run, setRun] = useState<OsdRunStatus | null>(null)
  const [runActive, setRunActive] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const wasActive = useRef(false)

  const load = useCallback(async () => {
    try {
      const s = await api.osdStatus()
      setSt(s)
      if (s.activeRun) {
        setRunActive(true)
        const rs = await api.osdRun(s.activeRun.runId, 24_000)
        setRun(rs)
      } else if (wasActive.current) {
        wasActive.current = false
        setRunActive(false)
        await api.osdStatus().then(setSt).catch(() => undefined)
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // поллинг: активный прогон — 3с, статус — 20с
  useEffect(() => {
    const iv = setInterval(() => {
      if (runActive) void load()
    }, runActive ? 3_000 : 20_000)
    return () => clearInterval(iv)
  }, [runActive, load])

  // автопрокрутка лога
  useEffect(() => {
    if (logRef.current && runActive) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [run, runActive])

  useEffect(() => { wasActive.current = runActive }, [runActive])

  const togglePack = (k: PackKey) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }
  const toggleApply = (k: ApplyKind) => {
    setApplyWhat((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action + JSON.stringify(extra))
    setMsg(null)
    try {
      const r = await api.osdAction({ action, ...extra })
      if (action === 'probe') {
        const p = r.probe as OsdStatus['probe']
        setMsg({ ok: p.ok, text: p.ok ? tr(t.osd.probeOk, { mode: p.mode }) : tr(t.osd.probeErr, { err: p.error ?? '—' }) })
        await load()
        return
      }
      if (action === 'sync-scripts') {
        setMsg({ ok: true, text: t.osd.synced })
        return
      }
      if (action === 'start') {
        const runId = r.runId as string
        setMsg({ ok: true, text: tr(t.osd.applyStarted, { runId }) })
        wasActive.current = true
        setRunActive(true)
        const rs = await api.osdRun(runId, 24_000)
        setRun(rs)
        return
      }
      if (action === 'cancel') {
        await load()
        return
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const startImport = async (packs: PackKey[]) => {
    if (!packs.length) return
    await act('start', { kind: 'import', packs, dryRun })
  }
  const startRemove = async (packs: PackKey[] | 'all') => {
    await act('start', { kind: 'remove', packs: packs === 'all' ? [] : packs, confirm: true, dryRun })
  }
  const startApply = async (what: 'all' | ApplyKind) => {
    await act('start', { kind: 'apply', what, dryRun })
  }

  const probe = st?.probe
  const packLabel: Record<PackKey, { title: string; desc: string }> = {
    traffic: { title: t.osd.packTraffic, desc: t.osd.packTrafficDesc },
    http: { title: t.osd.packHttp, desc: t.osd.packHttpDesc },
    dns: { title: t.osd.packDns, desc: t.osd.packDnsDesc },
    tls: { title: t.osd.packTls, desc: t.osd.packTlsDesc },
    alerts: { title: t.osd.packAlerts, desc: t.osd.packAlertsDesc },
    files: { title: t.osd.packFiles, desc: t.osd.packFilesDesc },
  }
  const applyLabel: Record<ApplyKind, string> = {
    alerting: t.osd.applyAlerting,
    anomaly: t.osd.applyAnomaly,
    security: t.osd.applySecurity,
  }
  const kindLabel = (k: string) => (k === 'apply' ? t.osd.kindApply : k === 'import' ? t.osd.kindImport : t.osd.kindRemove)

  const pluginBadge = (installed: boolean | undefined, label: string) => (
    <Badge variant="outline" className={installed ? 'border-emerald-400 text-emerald-700' : 'border-amber-400 text-amber-700'}>
      {installed ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
      {label}: {installed ? t.osd.pluginOn : t.osd.pluginOff}
    </Badge>
  )

  return (
    <div className="space-y-4">
      {/* ── Состояние OpenSearch ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" /> {t.osd.title}
          </CardTitle>
          <CardDescription>{t.osd.intro}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Plug className="h-3.5 w-3.5" /> {t.osd.connNote}
            {st && (
              <Badge variant="outline" className="border-input text-muted-foreground ml-1">
                {t.osd.connMode}: {st.settings.updateMode === 'local' ? 'local' : `ssh ${st.settings.sshUser}@${st.settings.sshHost || '—'}`}
              </Badge>
            )}
          </div>

          {probe?.ok ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
              <div className="border border-border rounded-md p-2.5">
                <div className="text-xs text-muted-foreground">{t.osd.cluster}</div>
                <div className="font-medium">{probe.cluster || '—'}</div>
                <div className="text-xs text-muted-foreground">{t.osd.esVersion}: {probe.esVersion || '—'} · {t.osd.osdVersion}: {probe.osdVersion || '—'}</div>
              </div>
              <div className="border border-border rounded-md p-2.5">
                <div className="text-xs text-muted-foreground">{t.osd.data}</div>
                <div className="font-medium">{tr(t.osd.indicesDocs, { indices: probe.indices ?? 0, docs: (probe.docs ?? 0).toLocaleString(lang) })}</div>
              </div>
              <div className="border border-border rounded-md p-2.5">
                <div className="text-xs text-muted-foreground">{t.osd.plugins}</div>
                <div className="flex flex-wrap gap-1 pt-1">
                  {pluginBadge(probe.alerting, t.osd.pluginAlerting)}
                  {pluginBadge(probe.anomaly, t.osd.pluginAnomaly)}
                  {pluginBadge(probe.security, t.osd.pluginSecurity)}
                </div>
              </div>
              <div className="border border-border rounded-md p-2.5">
                <div className="text-xs text-muted-foreground">{t.osd.managed}</div>
                <div className="text-xs space-y-0.5 pt-1">
                  <div>{t.osd.managedMonitors}: <b>{probe.monitors ?? 0}</b></div>
                  <div>{t.osd.managedAdetectors}: <b>{probe.adetectors ?? 0}</b></div>
                  <div>{t.osd.managedSdetectors}: <b>{probe.sdetectors ?? 0}</b></div>
                  <div>{t.osd.managedPacks}: <b>{probe.packs ?? 0}</b></div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-4">
              {probe?.error ? `${t.osd.probeErr.replace('{err}', '')}${probe.error}` : t.osd.noData}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => act('probe')} disabled={busy !== null}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busy === 'probe' ? 'animate-spin' : ''}`} /> {t.osd.probeBtn}
            </Button>
            <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => act('sync-scripts')} disabled={busy !== null}>
              <Download className={`h-4 w-4 mr-1.5 ${busy === 'sync-scripts' ? 'animate-pulse' : ''}`} /> {t.osd.syncBtn}
            </Button>
            {probe?.ranAt && <span className="text-xs text-muted-foreground ml-auto">{fmtTime(probe.ranAt, lang)}</span>}
          </div>
        </CardContent>
      </Card>

      {/* ── Аналитика ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> {t.osd.applyTitle}
          </CardTitle>
          <CardDescription>{t.osd.applyDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {APPLY_KINDS.map((k) => (
              <label key={k} className={`flex items-center gap-1.5 border rounded-md px-2.5 py-1.5 text-sm cursor-pointer select-none ${applyWhat.has(k) ? 'border-primary bg-primary/5' : 'border-input'}`}>
                <Checkbox checked={applyWhat.has(k)} onCheckedChange={() => toggleApply(k)} />
                {applyLabel[k]}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => startApply('all')} disabled={busy !== null || !probe?.ok || applyWhat.size === 0}>
              {busy?.startsWith('start') ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1.5" />}
              {t.osd.applyBtn}
            </Button>
            <div className="flex items-center gap-1.5">
              <Switch checked={dryRun} onCheckedChange={setDryRun} id="osd-dry" />
              <Label htmlFor="osd-dry" className="text-xs text-muted-foreground cursor-pointer">{t.osd.dryRun}</Label>
            </div>
            {!probe?.ok && <span className="text-xs text-amber-700 flex items-center gap-1"><TriangleAlert className="h-3.5 w-3.5" /> {t.osd.probeBtn} →</span>}
          </div>
        </CardContent>
      </Card>

      {/* ── Каталог дашбордов ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" /> {t.osd.packsTitle}
          </CardTitle>
          <CardDescription>{t.osd.packsDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {PACK_KEYS.map((k) => (
              <label key={k} className={`border rounded-md p-3 cursor-pointer select-none ${selected.has(k) ? 'border-primary bg-primary/5' : 'border-input'}`}>
                <div className="flex items-start gap-2">
                  <Checkbox checked={selected.has(k)} onCheckedChange={() => togglePack(k)} className="mt-0.5" />
                  <div>
                    <div className="text-sm font-medium">{packLabel[k].title}</div>
                    <div className="text-xs text-muted-foreground">{packLabel[k].desc}</div>
                  </div>
                </div>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => startImport([...selected])} disabled={busy !== null || selected.size === 0}>
              {busy?.includes('import') ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
              {t.osd.importBtn} ({selected.size})
            </Button>
            <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => startImport([...PACK_KEYS])} disabled={busy !== null}>
              {t.osd.importAllBtn}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" disabled={busy !== null || selected.size === 0}>
                  <Trash2 className="h-4 w-4 mr-1.5" /> {t.osd.removeBtn}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t.osd.removeConfirmTitle}</AlertDialogTitle>
                  <AlertDialogDescription>{t.osd.removeConfirmDesc}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t.osd.removeCancel}</AlertDialogCancel>
                  <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={() => startRemove([...selected])}>
                    {t.osd.removeConfirm}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" disabled={busy !== null}>
                  <Trash2 className="h-4 w-4 mr-1.5" /> {t.osd.removeAllBtn}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t.osd.removeConfirmTitle}</AlertDialogTitle>
                  <AlertDialogDescription>{t.osd.removeConfirmDesc}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t.osd.removeCancel}</AlertDialogCancel>
                  <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={() => startRemove('all')}>
                    {t.osd.removeConfirm}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      {/* ── Сообщения ── */}
      {msg && (
        <div className={`text-sm px-3 py-2 rounded-md border ${msg.ok ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
          {msg.text}
        </div>
      )}

      {/* ── Лог прогона ── */}
      {run && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
              <Terminal className="h-4 w-4 text-primary" /> {t.osd.logTitle}
              <Badge variant="outline" className="border-input text-muted-foreground font-normal">{run.runId}</Badge>
              {run.active ? (
                <Badge variant="outline" className="border-blue-400 text-blue-700">{t.osd.running}</Badge>
              ) : (
                <Badge variant="outline" className={run.exitCode === 0 ? 'border-emerald-400 text-emerald-700' : 'border-red-400 text-red-700'}>
                  {tr(t.osd.exitCode, { code: run.exitCode ?? '—' })}
                </Badge>
              )}
              {runActive && (
                <Button size="sm" variant="outline" className="ml-auto border-input text-foreground" onClick={() => run.runId && act('cancel', { runId: run.runId })}>
                  <XCircle className="h-4 w-4 mr-1.5" /> {t.osd.cancelBtn}
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre ref={logRef} className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 border border-border rounded-md p-3 max-h-96 overflow-y-auto">{run.log || '…'}</pre>
          </CardContent>
        </Card>
      )}

      {/* ── История ── */}
      {st && st.runs.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t.osd.history}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {st.runs.map((r) => (
              <div key={r.runId} className="flex items-center gap-2 text-sm flex-wrap">
                <Badge variant="outline" className="border-input text-muted-foreground shrink-0">{kindLabel(r.kind)}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{r.runId}</span>
                <span className="text-xs text-muted-foreground">{fmtTime(r.startedAt, lang)}</span>
                {!r.finishedAt ? (
                  <Badge variant="outline" className="border-blue-400 text-blue-700">{t.osd.running}</Badge>
                ) : (
                  <Badge variant="outline" className={r.exitCode === 0 ? 'border-emerald-400 text-emerald-700' : 'border-red-400 text-red-700'}>
                    {tr(t.osd.exitCode, { code: r.exitCode ?? '—' })}
                  </Badge>
                )}
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={async () => {
                  try {
                    const rs = await api.osdRun(r.runId, 60_000)
                    setRun(rs)
                    setRunActive(rs.active)
                  } catch (e) {
                    setMsg({ ok: false, text: (e as Error).message })
                  }
                }}>
                  {t.osd.runView}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
