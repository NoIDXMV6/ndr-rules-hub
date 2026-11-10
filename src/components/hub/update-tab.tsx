'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «Обновление Clear NDR»: версия → последний релиз → опции → запуск
// скрипта clearndr-update.sh на хосте → живой лог → проверки результата
// (контейнеры, web UI, REST API). Оркестрация — /api/clearndr-update.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { api, fmtTime, UpdateOptionsUi, UpdateRunStatus, UpdateSettingsUi, UpdateStatus } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import {
  ArrowUpCircle, CheckCircle2, Download, HardDriveDownload, Loader2, RefreshCw,
  ServerCog, Square, Terminal, XCircle,
} from 'lucide-react'

const MASK = '********'

const DEFAULT_OPTIONS: UpdateOptionsUi = {
  version: '',
  opensearchData: 'keep',
  pgStrategy: 'restore',
  updateCli: false,
  skipDbDump: false,
  skipVolume: false,
  fullConfig: false,
  skipMikrocataCheck: false,
  healthTimeout: 600,
}

export function UpdateTab({ onChange }: { data: unknown; onChange: () => void }) {
  const { t, tr, lang } = useI18n()
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [cfg, setCfg] = useState<UpdateSettingsUi | null>(null)
  const [opts, setOpts] = useState<UpdateOptionsUi>(DEFAULT_OPTIONS)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // показываемый прогон: активный (поллинг) или исторический (разовый лог)
  const [run, setRun] = useState<UpdateRunStatus | null>(null)
  const [runActive, setRunActive] = useState(false)
  const [tick, setTick] = useState(0) // для секундомера активного прогона
  const logRef = useRef<HTMLPreElement>(null)
  const wasActive = useRef(false)

  const load = useCallback(async () => {
    try {
      const s = await api.updateStatus()
      setSt(s)
      setCfg((prev) => prev ?? {
        updateMode: s.settings.updateMode,
        sshHost: s.settings.sshHost,
        sshPort: s.settings.sshPort,
        sshUser: s.settings.sshUser,
        sshKey: '',
        sudoMode: s.settings.sudoMode,
        instanceDir: s.settings.instanceDir,
        scriptPath: s.settings.scriptPath,
        healthUrl: s.settings.healthUrl,
        apiToken: s.settings.apiToken ? MASK : '',
        osdEsUrl: s.settings.osdEsUrl || '',
      })
      if (s.activeRun) {
        setRunActive(true)
        const rs = await api.updateRun(s.activeRun.runId, 24_000)
        setRun(rs)
      } else if (wasActive.current) {
        // прогон только что завершился — обновляем карточки состояния стека
        wasActive.current = false
        setRunActive(false)
        onChange()
        setSt((await api.updateStatus()))
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }, [onChange])

  useEffect(() => { void load() }, [load])

  // поллинг: активный прогон — 3с, обычный статус — 20с
  useEffect(() => {
    const iv = setInterval(() => {
      if (runActive) void load()
      else setTick((x) => x + 1)
    }, runActive ? 3_000 : 20_000)
    return () => clearInterval(iv)
  }, [runActive, load])

  // секундомер для активного прогона
  useEffect(() => {
    if (!runActive) return
    const iv = setInterval(() => setTick((x) => x + 1), 1_000)
    return () => clearInterval(iv)
  }, [runActive])

  // автопрокрутка лога
  useEffect(() => {
    if (logRef.current && runActive) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [run, runActive])

  useEffect(() => { wasActive.current = runActive }, [runActive])

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action)
    setMsg(null)
    try {
      const r = await api.updateAction({ action, ...extra })
      if (action === 'probe') {
        const p = r.probe as UpdateStatus['host']
        setMsg({ ok: p.ok, text: p.ok ? tr(t.update.hostOk, { mode: p.mode }) : tr(t.update.hostErr, { err: p.error ?? '—' }) })
        await load()
        return
      }
      if (action === 'sync-script') {
        setMsg({ ok: true, text: t.update.synced })
        return
      }
      if (action === 'start') {
        const runId = r.runId as string
        setMsg({ ok: true, text: tr(t.update.runStarted, { runId }) })
        wasActive.current = true
        setRunActive(true)
        const rs = await api.updateRun(runId, 24_000)
        setRun(rs)
        return
      }
      if (action === 'cancel') {
        setMsg({ ok: true, text: t.update.cancelBtn })
        await load()
        return
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const saveSettings = async () => {
    if (!cfg) return
    setBusy('save')
    setMsg(null)
    try {
      await api.updateSaveSettings(cfg)
      setMsg({ ok: true, text: t.update.saved })
      await load()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const openHistoryLog = async (runId: string) => {
    setBusy('log')
    try {
      const rs = await api.updateRun(runId, 60_000)
      setRun(rs)
      setRunActive(rs.active)
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const probe = st?.host
  const latest = st?.latest
  const installed = probe?.stackVersion
  const canRun = st?.updateAvailable === true && !!probe?.ok && !runActive
  const mapOk = (probe?.maxMapCount ?? 0) >= 262144
  const memOk = (probe?.memAvailMb ?? 0) >= 3072
  const diskOk = (probe?.diskFreeMb ?? 0) >= 5 * 1024

  const osDataText = opts.opensearchData === 'wipe' ? t.update.optOsWipe : t.update.optOsKeep

  return (
    <div className="space-y-4">
      {/* ── 1. Версия ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <ArrowUpCircle className="h-4 w-4 text-primary" /> {t.update.versionTitle}
            <Badge variant="outline" className={
              st?.updateAvailable === true ? 'border-amber-400 text-amber-700' :
              st?.updateAvailable === false ? 'border-emerald-400 text-emerald-700' : 'border-input text-muted-foreground'
            }>
              {st?.updateAvailable === true ? t.update.badgeUpdate : st?.updateAvailable === false ? t.update.badgeActual : t.update.badgeUnknown}
            </Badge>
            <Button size="sm" variant="outline" className="ml-auto border-input text-foreground" onClick={() => void load()} disabled={busy !== null}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${busy === 'load' ? 'animate-spin' : ''}`} /> {t.update.checkNow}
            </Button>
          </CardTitle>
          <CardDescription>{t.update.versionDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <VerBox
              label={t.update.installed}
              value={installed || t.update.installedUnknown}
              sub={probe?.osTag ? `OpenSearch ${probe.osTag.split(':').pop() ?? ''} · PostgreSQL ${probe.pgTag?.split(':').pop() ?? ''}` : undefined}
              ok={!!installed}
            />
            <VerBox
              label={t.update.latest}
              value={latest?.tag || '—'}
              sub={latest?.publishedAt ? fmtTime(latest.publishedAt, lang) : undefined}
              ok={!!latest?.tag}
            />
            <VerBox
              label="stamusctl"
              value={probe?.stamusctl ? probe.stamusctl.replace(/^stamusctl version\s*/i, '') : '—'}
              sub={probe?.suricataInterfaces ? `suricata.interfaces: ${probe.suricataInterfaces}` : undefined}
              ok={!!probe?.stamusctl && probe.stamusctl !== 'missing'}
            />
          </div>
          {latest?.error && (
            <p className="text-xs text-amber-700">{tr(t.update.latestError, { err: latest.error })}</p>
          )}
          {st?.updateAvailable === true && (
            <p className="text-sm text-amber-700 font-medium">{tr(t.update.updateTo, { from: installed ?? '?', to: latest?.tag ?? '?' })}</p>
          )}
          {st?.updateAvailable === false && (
            <p className="text-sm text-emerald-700">{t.update.upToDate}</p>
          )}
        </CardContent>
      </Card>

      {/* ── 2. Подключение к хосту ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ServerCog className="h-4 w-4 text-primary" /> {t.update.connTitle}
          </CardTitle>
          <CardDescription>{t.update.connDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {cfg && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
                <div>
                  <Label className="text-foreground">{t.update.mode}</Label>
                  <Select value={cfg.updateMode} onValueChange={(v) => setCfg({ ...cfg, updateMode: v })}>
                    <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ssh">{t.update.modeSsh}</SelectItem>
                      <SelectItem value="local">{t.update.modeLocal}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {cfg.updateMode === 'ssh' && (
                  <>
                    <div>
                      <Label className="text-foreground">{t.update.sshHost}</Label>
                      <Input value={cfg.sshHost} onChange={(e) => setCfg({ ...cfg, sshHost: e.target.value.trim() })} className="bg-card border-input" placeholder="192.168.1.10" />
                    </div>
                    <div>
                      <Label className="text-foreground">{t.update.sshPort}</Label>
                      <Input value={cfg.sshPort} onChange={(e) => setCfg({ ...cfg, sshPort: e.target.value.replace(/\D/g, '') || '22' })} className="bg-card border-input" placeholder="22" />
                    </div>
                    <div>
                      <Label className="text-foreground">{t.update.sshUser}</Label>
                      <Input value={cfg.sshUser} onChange={(e) => setCfg({ ...cfg, sshUser: e.target.value.trim() })} className="bg-card border-input" placeholder="root" />
                    </div>
                  </>
                )}
              </div>

              {cfg.updateMode === 'ssh' && (
                <>
                  <div>
                    <Label className="text-foreground">{t.update.sshKey}</Label>
                    <SecretInput value={cfg.sshKey} onChange={(v) => setCfg({ ...cfg, sshKey: v })} placeholder={st?.settings.sshKeySet ? t.update.sshKeySet : '-----BEGIN OPENSSH PRIVATE KEY-----'} />
                    {st?.settings.sshKeySet && <p className="text-xs text-muted-foreground mt-1">{t.update.sshKeySet}</p>}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                    <div>
                      <Label className="text-foreground">{t.update.sudoMode}</Label>
                      <Select value={cfg.sudoMode} onValueChange={(v) => setCfg({ ...cfg, sudoMode: v })}>
                        <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">{t.update.sudoAuto}</SelectItem>
                          <SelectItem value="sudo">{t.update.sudoSudo}</SelectItem>
                          <SelectItem value="plain">{t.update.sudoPlain}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-foreground">{t.update.instanceDir}</Label>
                      <Input value={cfg.instanceDir} onChange={(e) => setCfg({ ...cfg, instanceDir: e.target.value.trim() })} className="bg-card border-input" placeholder="/opt/ClearNDR" />
                    </div>
                    <div>
                      <Label className="text-foreground">{t.update.scriptPath}</Label>
                      <Input value={cfg.scriptPath} onChange={(e) => setCfg({ ...cfg, scriptPath: e.target.value.trim() })} className="bg-card border-input" placeholder="/opt/ClearNDR/clearndr-update.sh" />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{t.update.sshHelp}</p>
                </>
              )}
              {cfg.updateMode === 'local' && <p className="text-xs text-muted-foreground">{t.update.localHelp}</p>}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
                <div>
                  <Label className="text-foreground">{t.update.healthUrl}</Label>
                  <Input value={cfg.healthUrl} onChange={(e) => setCfg({ ...cfg, healthUrl: e.target.value.trim() })} className="bg-card border-input" placeholder="https://localhost/" />
                </div>
                <div>
                  <Label className="text-foreground">{t.update.apiToken}</Label>
                  <Input value={cfg.apiToken} onChange={(e) => setCfg({ ...cfg, apiToken: e.target.value.trim() })} className="bg-card border-input" type="password" placeholder="—" />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={saveSettings} disabled={busy !== null}>
                  <HardDriveDownload className="h-4 w-4 mr-1.5" /> {t.update.save}
                </Button>
                {cfg.updateMode === 'ssh' && (
                  <Button variant="outline" className="border-input text-foreground" onClick={() => void act('probe')} disabled={busy !== null || !cfg.sshHost || !cfg.sshUser}>
                    {busy === 'probe' ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ServerCog className="h-4 w-4 mr-1.5" />} {t.update.testConn}
                  </Button>
                )}
                <Button variant="outline" className="border-input text-foreground" onClick={() => void act('sync-script')} disabled={busy !== null}>
                  <Download className="h-4 w-4 mr-1.5" /> {t.update.syncScript}
                </Button>
              </div>
            </>
          )}

          {/* предпроверки хоста */}
          {probe && (
            <div className="pt-1">
              <p className="text-sm font-medium mb-2">{t.update.hostChecks}</p>
              {!probe.ok && probe.error && (
                <p className="text-xs text-red-700 mb-2 rounded-lg border border-red-300/60 bg-red-50 p-2 font-mono">{probe.error}</p>
              )}
              {probe.ok && probe.composeOk === false && (
                <p className="text-xs text-red-800 mb-2 rounded-lg border border-red-300/60 bg-red-50 p-2 font-mono break-words">
                  {t.update.composeBroken} {probe.composeErr ?? '—'}
                  <br />
                  {t.update.composeRepairHint}
                </p>
              )}
              {probe.ok && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Pill label={t.update.checkMapCount} ok={mapOk} warnText={probe?.maxMapCount !== undefined ? String(probe.maxMapCount) : undefined} okText="≥ 262144" />
                  <Pill label={t.update.checkMem} ok={memOk} warnText={probe?.memAvailMb !== undefined ? `${probe.memAvailMb} MB` : undefined} okText="≥ 3 ГБ" />
                  <Pill label={t.update.checkDisk} ok={diskOk} warnText={probe?.diskFreeMb !== undefined ? `${probe.diskFreeMb} MB` : undefined} okText="≥ 5 ГБ" />
                  <Pill label={t.update.checkCompose} ok={probe.composeOk !== false} neutral={probe.composeOk === undefined} warnText={probe.composeOk === false ? t.update.composeBrokenShort : probe.composeOk === undefined ? undefined : 'OK'} />
                  <Pill label="mikrocata2selks" ok={true} neutral warnText={probe?.mikrocata ? t.update.mikrocataFound : t.update.mikrocataNone} />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 3. Параметры и запуск ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Terminal className="h-4 w-4 text-primary" /> {t.update.optTitle}
          </CardTitle>
          <CardDescription>{t.update.optDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <Label className="text-foreground">{t.update.optVersion}</Label>
              <Input value={opts.version} onChange={(e) => setOpts({ ...opts, version: e.target.value.trim() })} className="bg-card border-input" placeholder={t.update.optVersionPh} />
            </div>
            <div>
              <Label className="text-foreground">{t.update.optOsData}</Label>
              <Select value={opts.opensearchData} onValueChange={(v) => setOpts({ ...opts, opensearchData: v as 'keep' | 'wipe' })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">{t.update.optOsKeep}</SelectItem>
                  <SelectItem value="wipe">{t.update.optOsWipe}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">{t.update.optHealthTimeout}</Label>
              <Input
                value={opts.healthTimeout}
                onChange={(e) => setOpts({ ...opts, healthTimeout: parseInt(e.target.value.replace(/\D/g, ''), 10) || 600 })}
                className="bg-card border-input" inputMode="numeric"
              />
            </div>
          </div>
          <div>
            <Label className="text-foreground">{t.update.optPg}</Label>
            <p className="text-sm text-muted-foreground mt-1">{t.update.optPgRestore}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <OptSwitch label={t.update.optUpdateCli} checked={opts.updateCli} onChange={(v) => setOpts({ ...opts, updateCli: v })} />
            <OptSwitch label={t.update.optSkipDump} checked={opts.skipDbDump} onChange={(v) => setOpts({ ...opts, skipDbDump: v })} />
            <OptSwitch label={t.update.optSkipVolume} checked={opts.skipVolume} onChange={(v) => setOpts({ ...opts, skipVolume: v })} />
            <OptSwitch label={t.update.optFullConfig} checked={opts.fullConfig} onChange={(v) => setOpts({ ...opts, fullConfig: v })} />
            <OptSwitch label={t.update.optSkipMikrocata} checked={opts.skipMikrocataCheck} onChange={(v) => setOpts({ ...opts, skipMikrocataCheck: v })} />
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button className="bg-amber-600 hover:bg-amber-600/90 text-white" disabled={!canRun || busy !== null}>
                  <ArrowUpCircle className="h-4 w-4 mr-1.5" /> {t.update.runBtn}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-card border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-foreground">{t.update.confirmTitle}</AlertDialogTitle>
                  <AlertDialogDescription className="space-y-2 text-muted-foreground">
                    <span className="block">{t.update.confirmDesc}</span>
                    <span className="block rounded-lg border border-border bg-muted p-2 text-xs">
                      {tr(t.update.updateTo, { from: installed ?? '?', to: latest?.tag ?? '?' })} · OpenSearch: {osDataText} · PostgreSQL: {t.update.optPgRestore}
                      {opts.skipDbDump ? ' · дамп: НЕТ' : ''}
                      {opts.skipVolume ? ' · volume: НЕТ' : ''}
                      {opts.updateCli ? ' · +stamusctl' : ''}
                    </span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-input text-foreground">{t.update.confirmNo}</AlertDialogCancel>
                  <AlertDialogAction className="bg-amber-600 hover:bg-amber-600/90 text-white" onClick={() => void act('start', { options: opts })}>
                    {t.update.confirmYes}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {!canRun && !runActive && (
              <span className="text-xs text-muted-foreground">{t.update.runBlocked}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── 4. Живой лог / выбранный прогон ── */}
      {run && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
              {runActive ? <Loader2 className="h-4 w-4 animate-spin text-amber-600" /> : run.exitCode === 0 ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
              {t.update.logTitle}
              <code className="text-xs text-muted-foreground">{run.runId}</code>
              {runActive && run.startedAt && (
                <Badge variant="outline" className="border-amber-400 text-amber-700" data-tick={tick}>
                  {t.update.running} · {fmtElapsed(run.startedAt)}
                </Badge>
              )}
              <div className="ml-auto flex gap-2">
                {runActive && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="outline" className="border-red-300 text-red-600">
                        <Square className="h-3.5 w-3.5 mr-1" /> {t.update.cancelBtn}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="bg-card border-border">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-foreground">{t.update.cancelBtn}</AlertDialogTitle>
                        <AlertDialogDescription className="text-muted-foreground">{t.update.cancelConfirm}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="border-input text-foreground">{t.update.confirmNo}</AlertDialogCancel>
                        <AlertDialogAction className="bg-red-600 hover:bg-red-600/90 text-white" onClick={() => void act('cancel', { runId: run.runId })}>
                          {t.update.confirmYes}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
                {!runActive && (
                  <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => setRun(null)}>
                    {t.update.closeLog}
                  </Button>
                )}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {!runActive && run.exitCode !== undefined && (
              <div className={`rounded-lg border p-3 text-sm ${run.exitCode === 0 ? 'border-emerald-300/60 bg-emerald-50 text-emerald-800' : run.exitCode === 143 || run.cancelled ? 'border-amber-300/60 bg-amber-50 text-amber-800' : 'border-red-300/60 bg-red-50 text-red-700'}`}>
                {run.exitCode === 0 ? t.update.finishedOk : run.exitCode === 143 || run.cancelled ? t.update.stoppedNote : tr(t.update.finishedFail, { code: run.exitCode })}
                <p className="text-xs mt-1 text-muted-foreground">
                  {run.exitCode === 0 ? t.update.rcHint0 : run.exitCode === 143 || run.cancelled ? t.update.rcHint143 : run.exitCode === 1 ? t.update.rcHint1 : run.exitCode === 90 ? t.update.rcHint90 : t.update.rcHint2}
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t.update.runningHint}</p>
            <pre ref={logRef} className="rounded-lg border border-border bg-zinc-950 text-zinc-100 p-3 text-xs font-mono max-h-96 overflow-auto whitespace-pre-wrap">
              {run.log || t.update.logEmpty}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* ── 5. Состояние стека (проверка результата) ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t.update.stackState}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-sm text-muted-foreground">{t.update.webUi}:</span>
            {probe?.webHttp ? (
              <Badge variant="outline" className={/^(200|301|302)$/.test(probe.webHttp) ? 'border-emerald-300 text-emerald-700' : 'border-red-300 text-red-600'}>
                HTTP {probe.webHttp}
              </Badge>
            ) : <span className="text-sm text-muted-foreground">—</span>}
            <span className="text-sm text-muted-foreground ml-2">{t.update.restApi}:</span>
            {probe?.apiHttp ? (
              <Badge variant="outline" className={probe.apiHttp === '200' ? 'border-emerald-300 text-emerald-700' : 'border-amber-300 text-amber-700'}>
                HTTP {probe.apiHttp}{probe.apiSources ? ` · ${tr(t.update.restApiSources, { n: probe.apiSources })}` : ''}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">{t.update.restApiOff}</span>
            )}
          </div>
          {(!probe?.containers || probe.containers.length === 0) ? (
            <p className="text-sm text-muted-foreground">{t.update.noContainers}</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {probe.containers.map((c) => (
                <div key={c.name} className="flex items-center gap-2 text-sm rounded-lg border border-border px-2.5 py-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${c.up ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <span className="font-mono text-xs text-foreground truncate">{c.name}</span>
                  <span className={`text-xs ml-auto ${c.up ? 'text-emerald-700' : 'text-red-600'}`}>{c.status}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 6. История прогонов ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.update.history}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(!st?.runs || st.runs.length === 0) && <p className="text-sm text-muted-foreground">{t.update.historyEmpty}</p>}
          {st?.runs.map((r) => (
            <div key={r.runId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <Badge variant="outline" className={
                r.finishedAt ? (r.exitCode === 0 ? 'border-emerald-300 text-emerald-700' : r.exitCode === 143 || r.cancelled ? 'border-amber-300 text-amber-700' : 'border-red-300 text-red-600') : 'border-amber-300 text-amber-700'
              }>
                {r.finishedAt ? (r.exitCode === 0 ? 'OK' : r.exitCode === 143 || r.cancelled ? t.update.stoppedShort : `rc=${r.exitCode}`) : '…'}
              </Badge>
              <code className="text-xs text-foreground">{r.runId}</code>
              <span className="text-xs text-muted-foreground">{tr(t.update.started, { t: fmtTime(r.startedAt, lang) })}</span>
              <span className="text-xs text-muted-foreground">{tr(t.update.modeLabel, { m: r.mode })}</span>
              <Button size="sm" variant="outline" className="ml-auto h-7 border-input text-foreground" onClick={() => void openHistoryLog(r.runId)} disabled={busy !== null}>
                {t.update.viewLog}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {msg && (msg.ok ? (
        <p className="text-sm text-emerald-700 whitespace-pre-wrap">{msg.text}</p>
      ) : (
        <pre className="text-xs text-red-700 whitespace-pre-wrap rounded-lg border border-red-300/60 bg-red-50 p-3 font-mono max-h-64 overflow-auto">{msg.text}</pre>
      ))}
    </div>
  )
}

/** Секретное поле (ключ/токен): Input с моно-шрифтом без автозаполнения */
function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-card border-input font-mono text-xs"
      type="password"
      placeholder={placeholder}
      autoComplete="off"
    />
  )
}

function OptSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 cursor-pointer hover:bg-muted/40">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm text-foreground">{label}</span>
    </label>
  )
}

function VerBox({ label, value, sub, ok }: { label: string; value: string; sub?: string; ok?: boolean }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${ok ? 'text-foreground' : 'text-muted-foreground'}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

/** Индикатор предпроверки: ok / мало / нет данных */
function Pill({ label, ok, warnText, okText, neutral }: { label: string; ok?: boolean; warnText?: string; okText?: string; neutral?: boolean }) {
  const state = warnText === undefined ? 'unknown' : neutral ? 'neutral' : ok ? 'ok' : 'warn'
  const box = state === 'ok' ? 'border-emerald-300/60 bg-emerald-50' : state === 'warn' ? 'border-amber-300/60 bg-amber-50' : 'border-border bg-muted/40'
  const dot = state === 'ok' ? 'bg-emerald-500' : state === 'warn' ? 'bg-amber-500' : 'bg-zinc-400'
  return (
    <div className={`rounded-lg border p-3 ${box}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="text-xs font-medium text-foreground">{label}</span>
      </div>
      <p className={`text-xs mt-1 ${state === 'ok' ? 'text-emerald-700' : state === 'warn' ? 'text-amber-700' : 'text-muted-foreground'}`}>
        {warnText ?? '—'}
        {okText && state !== 'ok' && warnText !== undefined ? ` (нужно ${okText})` : ''}
      </p>
    </div>
  )
}

function fmtElapsed(startedIso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(startedIso).getTime()) / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
