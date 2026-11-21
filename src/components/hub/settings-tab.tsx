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
import { Eye, EyeOff, Save, ShieldCheck } from 'lucide-react'

// Настройки уведомлений и сервисов уведомлений (Telegram, Gotify, рассылка о версиях)
// перенесены на вкладку «Уведомления и сервисы» меню «Интеграции» (integrations-tab.tsx)

export function SettingsTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr } = useI18n()
  const [s, setS] = useState<Record<string, string>>({})
  const [showOink, setShowOink] = useState(false)
  const [showEtPro, setShowEtPro] = useState(false)
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

  // RST Cloud (ключ + проверка) переехал в «Интеграции → RST Cloud» (v1.39.0):
  // разные сущности — threat-intelligence интеграция и настройки источников

  return (
    <div className="space-y-4">
      {/* ── Единая группа «Токены источников»: snort.org, ET Pro, abuse.ch, MISP ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.settings.tokensTitle}</CardTitle>
          <CardDescription>{t.settings.tokensDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* snort.org: oinkcode аккаунта + отдельный код ET Pro */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.snortTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.snortDesc}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
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
                <p className="text-xs text-muted-foreground mt-1">{t.settings.oinkHelp}</p>
              </div>
              <div>
                <Label className="text-foreground">{t.settings.etProOinkcode}</Label>
                <div className="flex gap-2">
                  <Input
                    type={showEtPro ? 'text' : 'password'}
                    value={s.etProOinkcode ?? ''}
                    onChange={(e) => set('etProOinkcode', e.target.value.trim())}
                    className="bg-card border-input font-mono"
                    placeholder={t.settings.etProPlaceholder}
                  />
                  <Button variant="outline" className="border-input text-foreground shrink-0" onClick={() => setShowEtPro(!showEtPro)}>
                    {showEtPro ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{t.settings.etProHelp}</p>
              </div>
            </div>
          </div>

          {/* abuse.ch: Auth-Key (ThreatFox, URLhaus) */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.abusechTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.abusechDesc}</p>
            </div>
            <div className="max-w-xl">
              <Label className="text-foreground">{t.settings.abusechKey}</Label>
              <Input
                type="password"
                value={s.abusechAuthKey ?? ''}
                onChange={(e) => set('abusechAuthKey', e.target.value.trim())}
                className="bg-card border-input font-mono"
                placeholder={t.settings.abusechPlaceholder}
              />
              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{t.settings.abusechHelp}</p>
            </div>
          </div>

          {/* MISP: ключ REST API (источники-фиды; коннекторы — вкладка «MISP») */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.mispTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.mispDesc}</p>
            </div>
            <div className="max-w-xl">
              <Label className="text-foreground">{t.settings.mispKey}</Label>
              <Input
                type="password"
                value={s.mispAuthKey ?? ''}
                onChange={(e) => set('mispAuthKey', e.target.value.trim())}
                className="bg-card border-input font-mono"
                placeholder={t.settings.mispPlaceholder}
              />
              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{t.settings.mispHelp}</p>
              <p className="text-xs text-muted-foreground mt-1">{t.settings.mispTabHint}</p>
            </div>
          </div>

          {/* Open NRD (Stamus Networks): код лицензии — сегмент пути фида */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.openNrdTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.openNrdDesc}</p>
            </div>
            <div className="max-w-xl">
              <Label className="text-foreground">{t.settings.openNrdKey}</Label>
              <Input
                type="password"
                value={s.openNrdLicense ?? ''}
                onChange={(e) => set('openNrdLicense', e.target.value.trim())}
                className="bg-card border-input font-mono"
                placeholder={t.settings.openNrdPlaceholder}
              />
              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{t.settings.openNrdHelp}</p>
            </div>
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
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {t.settings.sidStrategyHelp}
              </p>
            </div>
            <div>
              <Label className="text-foreground">{t.settings.sidConflict}</Label>
              <Select value={s.dedupSidConflict ?? 'drop'} onValueChange={(v) => set('dedupSidConflict', v)}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="drop">{t.settings.sidConflictDrop}</SelectItem>
                  <SelectItem value="reassign">{t.settings.sidConflictReassign}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{t.settings.sidConflictHelp}</p>
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
          {/* DNS-цикл: отдельное расписание — разнос пиков нагрузки */}
          <div className="rounded-lg border border-border p-3 space-y-3 max-w-xl">
            <p className="text-sm font-medium text-foreground">{t.settings.dnsCronTitle}</p>
            <SwitchRow label={t.settings.dnsCronEnabled} checked={(s.dnsCronEnabled ?? 'true') === 'true'} onChange={(v) => set('dnsCronEnabled', String(v))} />
            <div className="max-w-sm">
              <Label className="text-foreground">{t.settings.dnsCronExpr}</Label>
              <Input value={s.dnsCronSchedule ?? ''} onChange={(e) => set('dnsCronSchedule', e.target.value)} className="bg-card border-input font-mono" placeholder="30 4 * * *" />
              <p className="text-xs text-muted-foreground mt-1">{t.settings.dnsCronHelp}</p>
            </div>
          </div>
          <div className="max-w-sm">
            <Label className="text-foreground">{t.settings.homeNet}</Label>
            <Input value={s.homeNet ?? ''} onChange={(e) => set('homeNet', e.target.value)} className="bg-card border-input" />
          </div>
        </CardContent>
      </Card>

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
            <Switch checked={(s.cleanupOsEnabled ?? 'true') === 'true'} onCheckedChange={(v) => set('cleanupOsEnabled', String(v))} />
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
            <Switch checked={(s.cleanupCacheEnabled ?? 'true') === 'true'} onCheckedChange={(v) => set('cleanupCacheEnabled', String(v))} />
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
            <Switch checked={(s.cleanupLogsEnabled ?? 'true') === 'true'} onCheckedChange={(v) => set('cleanupLogsEnabled', String(v))} />
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
            <Switch checked={(s.cleanupFilesEnabled ?? 'false') === 'true'} onCheckedChange={(v) => set('cleanupFilesEnabled', String(v))} />
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

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm text-foreground">{label}</span>
    </div>
  )
}
