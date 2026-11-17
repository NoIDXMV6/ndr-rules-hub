'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, Dashboard } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Eye, EyeOff, Save, Send, Rocket, Trash2 } from 'lucide-react'

export function SettingsTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr } = useI18n()
  const [s, setS] = useState<Record<string, string>>({})
  const [showOink, setShowOink] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (data?.settings) setS(data.settings)
  }, [data?.settings])

  const set = (k: string, v: string) => setS((prev) => ({ ...prev, [k]: v }))

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.saveSettings(s)
      setMsg(t.messages.settingsSaved)
      onChange()
    } catch (e) {
      setMsg(tr(t.messages.fetchErr, { err: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.settings.snortTitle}</CardTitle>
          <CardDescription>{t.settings.snortDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="max-w-xl">
            <Label className="text-foreground">{t.settings.oinkcode}</Label>
            <div className="flex gap-2">
              <Input
                type={showOink ? 'text' : 'password'}
                value={s.oinkcode ?? ''}
                onChange={(e) => set('oinkcode', e.target.value.trim())}
                className="bg-card border-input font-mono"
                placeholder={t.settings.oinkPlaceholder}
              />
              <Button variant="outline" className="border-input text-foreground shrink-0" onClick={() => setShowOink(!showOink)}>
                {showOink ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t.settings.oinkHelp}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.settings.abusechTitle}</CardTitle>
          <CardDescription>{t.settings.abusechDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="max-w-xl">
            <Label className="text-foreground">{t.settings.abusechKey}</Label>
            <Input
              type="password"
              value={s.abusechAuthKey ?? ''}
              onChange={(e) => set('abusechAuthKey', e.target.value.trim())}
              className="bg-card border-input font-mono"
              placeholder={t.settings.abusechPlaceholder}
            />
            <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">
              {t.settings.abusechHelp}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.settings.dedupTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-foreground">{t.settings.sidStrategy}</Label>
              <Select value={s.dedupSidStrategy ?? 'highest-rev'} onValueChange={(v) => set('dedupSidStrategy', v)}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="highest-rev">{t.settings.strategyHighestRev}</SelectItem>
                  <SelectItem value="source-priority">{t.settings.strategySourcePriority}</SelectItem>
                  <SelectItem value="renumber-private">{t.settings.strategyRenumber}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {t.settings.sidStrategyHelp}
              </p>
            </div>
            <div>
              <Label className="text-foreground">{t.settings.privateSidStart}</Label>
              <Input
                type="number"
                value={s.privateSidStart ?? '1000000'}
                onChange={(e) => set('privateSidStart', e.target.value)}
                className="bg-card border-input"
              />
              <p className="text-xs text-muted-foreground mt-1">{t.settings.privateSidHelp}</p>
            </div>
          </div>
          <div className="space-y-3">
            <SwitchRow label={t.settings.switchDedupContent} checked={(s.dedupContent ?? 'true') === 'true'} onChange={(v) => set('dedupContent', String(v))} />
            <SwitchRow label={t.settings.switchDropIncompatible} checked={(s.dropIncompatible ?? 'true') === 'true'} onChange={(v) => set('dropIncompatible', String(v))} />
            <SwitchRow label={t.settings.switchDropDisabled} checked={(s.dropDisabledMsg ?? 'true') === 'true'} onChange={(v) => set('dropDisabledMsg', String(v))} />
          </div>
          <div className="max-w-sm">
            <Label className="text-foreground">{t.settings.buildFileName}</Label>
            <Input value={s.buildFileName ?? ''} onChange={(e) => set('buildFileName', e.target.value)} className="bg-card border-input" />
          </div>
          <div className="max-w-xl">
            <Label className="text-foreground">{t.settings.buildFormat}</Label>
            <Select value={s.buildFormat ?? 'file'} onValueChange={(v) => set('buildFormat', v)}>
              <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="file">{t.settings.buildFormatFile}</SelectItem>
                <SelectItem value="file+tgz">{t.settings.buildFormatBoth}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {t.settings.buildFormatHelp}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.settings.exportTitle}</CardTitle>
          <CardDescription>{t.settings.exportDesc}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-foreground">{t.settings.mode}</Label>
            <Select value={s.clearndrExportMode ?? 'file'} onValueChange={(v) => set('clearndrExportMode', v)}>
              <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="file">{t.settings.modeFile}</SelectItem>
                <SelectItem value="clearndr">{t.settings.modeClearndr}</SelectItem>
                <SelectItem value="http">{t.settings.modeHttp}</SelectItem>
                <SelectItem value="local-path">{t.settings.modeLocalPath}</SelectItem>
                <SelectItem value="disabled">{t.settings.modeDisabled}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-foreground">{t.settings.exportUrl}</Label>
            <Input value={s.clearndrExportUrl ?? ''} onChange={(e) => set('clearndrExportUrl', e.target.value)} className="bg-card border-input" placeholder="https://clearndr.local" />
          </div>
          <div>
            <Label className="text-foreground">{t.settings.exportAuth}</Label>
            <Select value={s.clearndrExportAuth ?? 'token'} onValueChange={(v) => set('clearndrExportAuth', v)}>
              <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="token">{t.settings.exportAuthToken}</SelectItem>
                <SelectItem value="bearer">{t.settings.exportAuthBearer}</SelectItem>
                <SelectItem value="none">{t.settings.exportAuthNone}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-foreground">{t.settings.exportToken}</Label>
            <Input type="password" value={s.clearndrExportToken ?? ''} onChange={(e) => set('clearndrExportToken', e.target.value)} className="bg-card border-input" />
          </div>
          <div>
            <Label className="text-foreground">{t.settings.exportSource}</Label>
            <Input value={s.clearndrExportSource ?? ''} onChange={(e) => set('clearndrExportSource', e.target.value)} className="bg-card border-input" placeholder="NDR Rules Hub" />
          </div>
          <div className="flex items-end pb-1">
            <SwitchRow label={t.settings.exportApply} checked={(s.clearndrExportApply ?? 'true') === 'true'} onChange={(v) => set('clearndrExportApply', String(v))} />
          </div>
          <div>
            <Label className="text-foreground">{t.settings.exportLocalPath}</Label>
            <Input value={s.clearndrExportLocalPath ?? ''} onChange={(e) => set('clearndrExportLocalPath', e.target.value)} className="bg-card border-input" placeholder="/srv/clearndr/import" />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.settings.cronTitle}</CardTitle>
          <CardDescription>{t.settings.cronDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <SwitchRow label={t.settings.cronEnabled} checked={(s.cronEnabled ?? 'false') === 'true'} onChange={(v) => set('cronEnabled', String(v))} />
            <SwitchRow label={t.settings.cronExport} checked={(s.cronExport ?? 'true') === 'true'} onChange={(v) => set('cronExport', String(v))} />
          </div>
          <div className="max-w-sm">
            <Label className="text-foreground">{t.settings.cronExpr}</Label>
            <Input value={s.cronSchedule ?? ''} onChange={(e) => set('cronSchedule', e.target.value)} className="bg-card border-input font-mono" placeholder="0 4 * * *" />
            <p className="text-xs text-muted-foreground mt-1">{t.settings.cronHelp}</p>
          </div>
          <div className="max-w-sm">
            <Label className="text-foreground">{t.settings.homeNet}</Label>
            <Input value={s.homeNet ?? ''} onChange={(e) => set('homeNet', e.target.value)} className="bg-card border-input" />
          </div>
        </CardContent>
      </Card>

      {/* ── Уведомления: Telegram + Gotify ── */}
      <NotificationsCard s={s} set={set} tr={tr} t={t} />

      {/* ── Диск и автоочистка ── */}
      <DiskCleanupCard s={s} set={set} tr={tr} t={t} />

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
          <Save className="h-4 w-4 mr-1.5" /> {t.settings.save}
        </Button>
        {msg && <span className="text-sm text-emerald-700">{msg}</span>}
      </div>
    </div>
  )
}

/** Карточка «Уведомления»: Telegram (с прокси) и Gotify (+ свой сервер) */
function NotificationsCard({
  s,
  set,
  tr,
  t,
}: {
  s: Record<string, string>
  set: (k: string, v: string) => void
  tr: (tpl: string, vars?: Record<string, string | number>) => string
  t: ReturnType<typeof useI18n>['t']
}) {
  const [tgResult, setTgResult] = useState<string | null>(null)
  const [goResult, setGoResult] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [gotifyRunning, setGotifyRunning] = useState<boolean | null>(null)
  const [gotifyUrl, setGotifyUrl] = useState<string | null>(null)

  const refreshState = useCallback(async () => {
    try {
      const r = await api.notifyState()
      setGotifyRunning(r.gotify.containerRunning)
      setGotifyUrl(r.gotify.url ?? null)
    } catch {
      setGotifyRunning(false)
    }
  }, [])

  useEffect(() => {
    void refreshState()
  }, [refreshState])

  const testChannel = async (channel: 'telegram' | 'gotify') => {
    const setter = channel === 'telegram' ? setTgResult : setGoResult
    setter('…')
    try {
      const r = await api.notifyAction({ action: 'test', channel })
      setter(r.ok ? tr(t.settings.notifyTestOk) : `${t.settings.notifyTestFail}: ${r.error}`)
    } catch (e) {
      setter((e as Error).message)
    }
  }

  const deployGotify = async () => {
    setDeploying(true)
    setGoResult(null)
    try {
      const r = await api.notifyAction({ action: 'gotify-deploy', port: s.gotifyDeployPort || undefined })
      const ok = !!r.ok
      const lines = (r.instructions as string[] | undefined) ?? []
      setGoResult(ok ? [`${t.settings.gotifyDeployed}${r.url ? `: ${String(r.url)}` : ''}`, ...lines].join('\n') : `${t.settings.notifyTestFail}: ${r.error}`)
      await refreshState()
    } catch (e) {
      setGoResult((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  const removeGotify = async () => {
    setDeploying(true)
    try {
      const r = await api.notifyAction({ action: 'gotify-remove' })
      setGoResult(r.ok ? t.settings.gotifyRemoved : `${r.error}`)
      await refreshState()
    } catch (e) {
      setGoResult((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t.settings.notifyTitle}</CardTitle>
        <CardDescription>{t.settings.notifyDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Telegram */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Telegram</p>
              <p className="text-xs text-muted-foreground">{t.settings.notifyTgDesc}</p>
            </div>
            <Switch checked={(s.notifyTgEnabled ?? 'false') === 'true'} onChange={(v) => set('notifyTgEnabled', String(v))} />
          </div>
          {(s.notifyTgEnabled ?? 'false') === 'true' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-foreground">{t.settings.tgBotToken}</Label>
                <Input type="password" value={s.tgBotToken ?? ''} onChange={(e) => set('tgBotToken', e.target.value.trim())} className="bg-card border-input font-mono" placeholder="123456:ABC-DEF…" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.tgBotTokenHelp}</p>
              </div>
              <div>
                <Label className="text-foreground">{t.settings.tgChatId}</Label>
                <Input value={s.tgChatId ?? ''} onChange={(e) => set('tgChatId', e.target.value.trim())} className="bg-card border-input font-mono" placeholder="-1001234567890" />
                <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{t.settings.tgChatIdHelp}</p>
              </div>
              <div>
                <Label className="text-foreground">{t.settings.tgProxy}</Label>
                <Input value={s.tgProxy ?? ''} onChange={(e) => set('tgProxy', e.target.value.trim())} className="bg-card border-input font-mono" placeholder="socks5://user:pass@host:1080" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.tgProxyHelp}</p>
              </div>
              <div>
                <Label className="text-foreground">{t.settings.tgApiBase}</Label>
                <Input value={s.tgApiBase ?? ''} onChange={(e) => set('tgApiBase', e.target.value.trim())} className="bg-card border-input" placeholder="https://api.telegram.org" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.tgApiBaseHelp}</p>
              </div>
              <div className="md:col-span-2">
                <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => void testChannel('telegram')}>
                  <Send className="h-3.5 w-3.5 mr-1.5" /> {t.settings.notifyTest}
                </Button>
                {tgResult && <p className="text-xs mt-2 text-muted-foreground whitespace-pre-wrap">{tgResult}</p>}
                <p className="text-xs text-muted-foreground mt-1">{t.settings.tgEventsHelp}</p>
              </div>
            </div>
          )}
        </div>

        {/* Gotify */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Gotify</p>
              <p className="text-xs text-muted-foreground">{t.settings.notifyGotifyDesc}</p>
            </div>
            <Switch checked={(s.notifyGotifyEnabled ?? 'false') === 'true'} onChange={(v) => set('notifyGotifyEnabled', String(v))} />
          </div>
          {(s.notifyGotifyEnabled ?? 'false') === 'true' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-foreground">{t.settings.gotifyUrlLabel}</Label>
                <Input value={s.gotifyUrl ?? ''} onChange={(e) => set('gotifyUrl', e.target.value.trim())} className="bg-card border-input" placeholder="https://gotify.example.com" />
              </div>
              <div>
                <Label className="text-foreground">{t.settings.gotifyToken}</Label>
                <Input type="password" value={s.gotifyToken ?? ''} onChange={(e) => set('gotifyToken', e.target.value.trim())} className="bg-card border-input font-mono" placeholder="Axxxxxxxxxx" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.gotifyTokenHelp}</p>
              </div>
              <div>
                <Label className="text-foreground">{t.settings.gotifyPriority}</Label>
                <Input type="number" min={0} max={10} value={s.gotifyPriority ?? '5'} onChange={(e) => set('gotifyPriority', e.target.value)} className="bg-card border-input" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.gotifyPriorityHelp}</p>
              </div>
              <div className="flex items-end gap-2">
                <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => void testChannel('gotify')}>
                  <Send className="h-3.5 w-3.5 mr-1.5" /> {t.settings.notifyTest}
                </Button>
              </div>
            </div>
          )}

          {/* Свой сервер Gotify */}
          <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-foreground">{t.settings.gotifySelfTitle}</p>
              {gotifyRunning !== null && (
                <Badge2 ok={gotifyRunning} on={t.settings.gotifyStateOn} off={t.settings.gotifyStateOff} />
              )}
              {gotifyRunning && gotifyUrl && <code className="text-xs text-emerald-700">{gotifyUrl}</code>}
            </div>
            <p className="text-xs text-muted-foreground whitespace-pre-line">{t.settings.gotifySelfDesc}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-40">
                <Label className="text-foreground">{t.settings.gotifyPort}</Label>
                <Input type="number" value={s.gotifyDeployPort ?? '8085'} onChange={(e) => set('gotifyDeployPort', e.target.value)} className="bg-card border-input" />
              </div>
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => void deployGotify()} disabled={deploying}>
                <Rocket className="h-3.5 w-3.5 mr-1.5" /> {t.settings.gotifyDeploy}
              </Button>
              {gotifyRunning && (
                <Button size="sm" variant="outline" className="border-red-300 text-red-600" onClick={() => void removeGotify()} disabled={deploying}>
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" /> {t.settings.gotifyRemove}
                </Button>
              )}
            </div>
            {goResult && <pre className="text-xs whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 max-h-56 overflow-auto">{goResult}</pre>}
            <p className="text-xs text-muted-foreground">{t.settings.gotifyEventsHelp}</p>
          </div>
        </div>

        {/* Какие события слать */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{t.settings.notifyEventsTitle}</p>
          <SwitchRow label={t.settings.notifyOnPipeline} checked={(s.notifyOnPipeline ?? 'true') === 'true'} onChange={(v) => set('notifyOnPipeline', String(v))} />
          <SwitchRow label={t.settings.notifyOnVpn} checked={(s.notifyOnVpn ?? 'true') === 'true'} onChange={(v) => set('notifyOnVpn', String(v))} />
          <SwitchRow label={t.settings.notifyOnDisk} checked={(s.notifyOnDisk ?? 'true') === 'true'} onChange={(v) => set('notifyOnDisk', String(v))} />
        </div>
      </CardContent>
    </Card>
  )
}

/** Карточка «Диск и очистка»: пороги, автоочистка, что разрешено искать/удалять */
function DiskCleanupCard({
  s,
  set,
  tr,
  t,
}: {
  s: Record<string, string>
  set: (k: string, v: string) => void
  tr: (tpl: string, vars?: Record<string, string | number>) => string
  t: ReturnType<typeof useI18n>['t']
}) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t.settings.cleanupTitle}</CardTitle>
        <CardDescription>{t.settings.cleanupDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Пороги */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label className="text-foreground">{t.settings.diskWarn}</Label>
            <Input type="number" min={50} max={99} value={s.diskWarnPct ?? '85'} onChange={(e) => set('diskWarnPct', e.target.value)} className="bg-card border-input" />
            <p className="text-xs text-muted-foreground mt-1">{t.settings.diskWarnHelp}</p>
          </div>
          <div>
            <Label className="text-foreground">{t.settings.diskCrit}</Label>
            <Input type="number" min={60} max={100} value={s.diskCriticalPct ?? '92'} onChange={(e) => set('diskCriticalPct', e.target.value)} className="bg-card border-input" />
            <p className="text-xs text-muted-foreground mt-1">{t.settings.diskCritHelp}</p>
          </div>
          <div>
            <Label className="text-foreground">{t.settings.cleanupSchedule}</Label>
            <Input value={s.cleanupSchedule ?? ''} onChange={(e) => set('cleanupSchedule', e.target.value)} className="bg-card border-input font-mono" placeholder="17 * * * *" />
            <p className="text-xs text-muted-foreground mt-1">{t.settings.cleanupScheduleHelp}</p>
          </div>
        </div>

        {/* Автоочистка */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <SwitchRow label={t.settings.cleanupAuto} checked={(s.cleanupAutoEnabled ?? 'false') === 'true'} onChange={(v) => set('cleanupAutoEnabled', String(v))} />
          <p className="text-xs text-muted-foreground">{t.settings.cleanupAutoHelp}</p>
          {(s.cleanupAutoEnabled ?? 'false') === 'true' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-foreground">{t.settings.cleanupTrigger}</Label>
                <Input type="number" min={50} max={100} value={s.cleanupTriggerPct ?? '90'} onChange={(e) => set('cleanupTriggerPct', e.target.value)} className="bg-card border-input" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.cleanupTriggerHelp}</p>
              </div>
              <div>
                <Label className="text-foreground">{t.settings.cleanupTarget}</Label>
                <Input type="number" min={10} max={95} value={s.cleanupFreeTargetPct ?? '80'} onChange={(e) => set('cleanupFreeTargetPct', e.target.value)} className="bg-card border-input" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.cleanupTargetHelp}</p>
              </div>
            </div>
          )}
        </div>

        {/* OpenSearch */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.cleanupOsTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.cleanupOsDesc}</p>
            </div>
            <Switch checked={(s.cleanupOsEnabled ?? 'true') === 'true'} onChange={(v) => set('cleanupOsEnabled', String(v))} />
          </div>
          {(s.cleanupOsEnabled ?? 'true') === 'true' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-foreground">{t.settings.cleanupOsDays}</Label>
                <Input type="number" min={1} value={s.cleanupOsKeepDays ?? '14'} onChange={(e) => set('cleanupOsKeepDays', e.target.value)} className="bg-card border-input" />
              </div>
              <div>
                <Label className="text-foreground">{t.settings.cleanupOsMax}</Label>
                <Input type="number" min={1} value={s.cleanupOsMaxDelete ?? '50'} onChange={(e) => set('cleanupOsMaxDelete', e.target.value)} className="bg-card border-input" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.cleanupOsMaxHelp}</p>
              </div>
              <div className="md:col-span-2">
                <Label className="text-foreground">{t.settings.cleanupOsPrefixes}</Label>
                <Input value={s.cleanupOsPrefixes ?? ''} onChange={(e) => set('cleanupOsPrefixes', e.target.value)} className="bg-card border-input font-mono" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.cleanupOsPrefixesHelp}</p>
              </div>
              <div className="md:col-span-2">
                <Label className="text-foreground">{t.settings.cleanupOsUrl}</Label>
                <Input value={s.cleanupOsUrl ?? ''} onChange={(e) => set('cleanupOsUrl', e.target.value.trim())} className="bg-card border-input font-mono" placeholder="https://user:pass@172.17.0.1:9200 (пусто — автопоиск)" />
              </div>
            </div>
          )}
        </div>

        {/* Кэш хаба */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.cleanupCacheTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.cleanupCacheDesc}</p>
            </div>
            <Switch checked={(s.cleanupCacheEnabled ?? 'true') === 'true'} onChange={(v) => set('cleanupCacheEnabled', String(v))} />
          </div>
          {(s.cleanupCacheEnabled ?? 'true') === 'true' && (
            <div className="max-w-xs">
              <Label className="text-foreground">{t.settings.cleanupCacheDays}</Label>
              <Input type="number" min={1} value={s.cleanupCacheKeepDays ?? '14'} onChange={(e) => set('cleanupCacheKeepDays', e.target.value)} className="bg-card border-input" />
            </div>
          )}
        </div>

        {/* Каталоги логов */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.cleanupLogsTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.cleanupLogsDesc}</p>
            </div>
            <Switch checked={(s.cleanupLogsEnabled ?? 'true') === 'true'} onChange={(v) => set('cleanupLogsEnabled', String(v))} />
          </div>
          {(s.cleanupLogsEnabled ?? 'true') === 'true' && (
            <div className="space-y-3">
              <div>
                <Label className="text-foreground">{t.settings.cleanupLogDirs}</Label>
                <Input value={s.cleanupLogDirs ?? ''} onChange={(e) => set('cleanupLogDirs', e.target.value)} className="bg-card border-input font-mono" placeholder="/mnt/suricata-logs, /opt/ClearNDR/logs" />
                <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{t.settings.cleanupLogDirsHelp}</p>
              </div>
              <div className="max-w-xs">
                <Label className="text-foreground">{t.settings.cleanupLogDays}</Label>
                <Input type="number" min={1} value={s.cleanupLogKeepDays ?? '7'} onChange={(e) => set('cleanupLogKeepDays', e.target.value)} className="bg-card border-input" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.cleanupLogDaysHelp}</p>
              </div>
            </div>
          )}
        </div>

        {/* Большие файлы */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.cleanupFilesTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.cleanupFilesDesc}</p>
            </div>
            <Switch checked={(s.cleanupFilesEnabled ?? 'false') === 'true'} onChange={(v) => set('cleanupFilesEnabled', String(v))} />
          </div>
          {(s.cleanupFilesEnabled ?? 'false') === 'true' && (
            <div className="space-y-3">
              <div>
                <Label className="text-foreground">{t.settings.cleanupFileDirs}</Label>
                <Input value={s.cleanupFileDirs ?? ''} onChange={(e) => set('cleanupFileDirs', e.target.value)} className="bg-card border-input font-mono" placeholder="/mnt/data/dumps" />
                <p className="text-xs text-muted-foreground mt-1">{t.settings.cleanupFileDirsHelp}</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <Label className="text-foreground">{t.settings.cleanupFileMin}</Label>
                  <Input type="number" min={1} value={s.cleanupLargeFileMb ?? '500'} onChange={(e) => set('cleanupLargeFileMb', e.target.value)} className="bg-card border-input" />
                </div>
                <div>
                  <Label className="text-foreground">{t.settings.cleanupFileAge}</Label>
                  <Input type="number" min={1} value={s.cleanupFileKeepDays ?? '7'} onChange={(e) => set('cleanupFileKeepDays', e.target.value)} className="bg-card border-input" />
                </div>
                <div className="flex items-end pb-1">
                  <SwitchRow label={t.settings.cleanupFilesDelete} checked={(s.cleanupFilesDelete ?? 'false') === 'true'} onChange={(v) => set('cleanupFilesDelete', String(v))} />
                </div>
              </div>
              <p className="text-xs text-amber-700 whitespace-pre-line">{t.settings.cleanupFilesWarn}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Badge2({ ok, on, off }: { ok: boolean; on: string; off: string }) {
  return (
    <span className={`text-xs rounded-full border px-2 py-0.5 ${ok ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-input text-muted-foreground'}`}>
      {ok ? on : off}
    </span>
  )
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm text-foreground">{label}</span>
    </div>
  )
}
