'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, Dashboard } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Eye, EyeOff, Save } from 'lucide-react'

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

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
          <Save className="h-4 w-4 mr-1.5" /> {t.settings.save}
        </Button>
        {msg && <span className="text-sm text-emerald-700">{msg}</span>}
      </div>
    </div>
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
