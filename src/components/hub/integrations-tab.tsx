'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «Уведомления и сервисы» (меню «Интеграции», только администратор):
// каналы уведомлений (Telegram, Gotify), собственный сервер Gotify (docker)
// и рассылка о новых версиях. Перенесено из «Настроек».
//
// Исправления против прежней карточки в «Настройках»:
//  1. Radix-Switch требует onCheckedChange — раньше использовали onChange
//     (DOM-событие change на кнопке не срабатывает), и каналы было невозможно
//     включить переключателем;
//  2. поля токенов/URL видимы ВСЕГДА — раньше они показывались только после
//     «включения» канала, и вставить токен было некуда;
//  3. кнопка «Развернуть Gotify» неактивна, пока контейнер уже запущен
//     (повторное развёртывание невозможно), активна — после удаления.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, Dashboard } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Save, Send, Rocket, Trash2 } from 'lucide-react'

export function IntegrationsTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr } = useI18n()
  const [s, setS] = useState<Record<string, string>>({})
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
      <NotificationsCard s={s} set={set} tr={tr} t={t} />

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
  const [bcMsg, setBcMsg] = useState<string | null>(null)
  const [bcBusy, setBcBusy] = useState(false)

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

  const tgOn = (s.notifyTgEnabled ?? 'false') === 'true'
  const goOn = (s.notifyGotifyEnabled ?? 'false') === 'true'

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t.settings.notifyTitle}</CardTitle>
        <CardDescription>{t.settings.notifyDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Telegram — поля токена видимы всегда: вставить токен можно ДО включения канала */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Telegram</p>
              <p className="text-xs text-muted-foreground">{t.settings.notifyTgDesc}</p>
            </div>
            <Switch checked={tgOn} onCheckedChange={(v) => set('notifyTgEnabled', String(v))} />
          </div>
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
        </div>

        {/* Gotify — поля URL/токена видимы всегда */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Gotify</p>
              <p className="text-xs text-muted-foreground">{t.settings.notifyGotifyDesc}</p>
            </div>
            <Switch checked={goOn} onCheckedChange={(v) => set('notifyGotifyEnabled', String(v))} />
          </div>
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

          {/* Свой сервер Gotify: кнопка развёртывания неактивна, пока контейнер уже запущен */}
          <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-foreground">{t.settings.gotifySelfTitle}</p>
              {gotifyRunning !== null && (
                <Badge2 ok={gotifyRunning} on={t.settings.gotifyStateOn} off={t.settings.gotifyStateOff} />
              )}
              {gotifyRunning && gotifyUrl && (
                <>
                  <code className="text-xs text-emerald-700">{gotifyUrl}</code>
                  {/* подстановка обнаруженного адреса в поле URL — некуда вставлять токен/URL больше не проблема */}
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-input text-foreground" onClick={() => set('gotifyUrl', gotifyUrl)}>
                    {t.settings.gotifyUseUrl}
                  </Button>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground whitespace-pre-line">{t.settings.gotifySelfDesc}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-40">
                <Label className="text-foreground">{t.settings.gotifyPort}</Label>
                <Input
                  type="number"
                  value={s.gotifyDeployPort ?? '8085'}
                  onChange={(e) => set('gotifyDeployPort', e.target.value)}
                  className="bg-card border-input"
                  disabled={deploying || gotifyRunning === true}
                  title={gotifyRunning ? t.settings.gotifyDeployDisabledHint : undefined}
                />
              </div>
              <Button
                size="sm"
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={() => void deployGotify()}
                disabled={deploying || gotifyRunning === true}
                title={gotifyRunning ? t.settings.gotifyDeployDisabledHint : undefined}
              >
                <Rocket className="h-3.5 w-3.5 mr-1.5" /> {t.settings.gotifyDeploy}
              </Button>
              {gotifyRunning && (
                <Button size="sm" variant="outline" className="border-red-300 text-red-600" onClick={() => void removeGotify()} disabled={deploying}>
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" /> {t.settings.gotifyRemove}
                </Button>
              )}
            </div>
            {gotifyRunning && <p className="text-xs text-amber-700">{t.settings.gotifyDeployDisabledHint}</p>}
            {goResult && <pre className="text-xs whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 max-h-56 overflow-auto">{goResult}</pre>}
            <p className="text-xs text-muted-foreground">{t.settings.gotifyEventsHelp}</p>
          </div>
        </div>

        {/* Рассылка о новых версиях */}
        <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t.settings.releaseBcTitle}</p>
              <p className="text-xs text-muted-foreground">{t.settings.releaseBcDesc}</p>
            </div>
            <Switch checked={(s.releaseBroadcastEnabled ?? 'true') === 'true'} onCheckedChange={(v) => set('releaseBroadcastEnabled', String(v))} />
          </div>
          <div className="space-y-2">
            <div>
              <Label className="text-foreground">{t.settings.releaseNotesLabel}</Label>
              <textarea
                value={s.releaseNotes ?? ''}
                onChange={(e) => set('releaseNotes', e.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm mt-1"
                placeholder={t.settings.releaseNotesPlaceholder}
              />
              <p className="text-xs text-muted-foreground mt-1">{t.settings.releaseNotesHelp}</p>
            </div>
            <Button size="sm" variant="outline" className="border-input text-foreground" disabled={bcBusy} onClick={async () => {
              setBcBusy(true)
              setBcMsg(null)
              try {
                const r = await api.notifyAction({ action: 'release-broadcast' })
                setBcMsg(r.skipped ? `${r.skipped}` : `${t.settings.releaseBcDone}: ${r.delivered} ✓, ${r.failed} ✗`)
              } catch (e) {
                setBcMsg((e as Error).message)
              } finally {
                setBcBusy(false)
              }
            }}>
              <Send className="h-3.5 w-3.5 mr-1.5" /> {t.settings.releaseBcSend}
            </Button>
            {bcMsg && <p className="text-xs text-muted-foreground">{bcMsg}</p>}
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
