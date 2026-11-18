'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «MISP» (меню «Интеграции», только администратор):
//  1. Связь с MISP (URL + API-ключ) — общая для коннекторов, webhook-приёмника
//     и источников-фидов MISP (ключ тот же, что в «Токенах источников»).
//  2. Автоматическое развёртывание стека MISP через docker compose
//     (по образцу развёртывания Gotify на вкладке «Уведомления и сервисы»).
//  3. Коннекторы событий: Clear NDR, Wazuh, Zabbix, MikroTik (+ webhook для
//     uuWAF и прочих источников без готового коннектора).
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, fmtTime, Dashboard } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Save, Send, Rocket, Trash2, Eye, EyeOff, Play } from 'lucide-react'

interface MispState {
  connection: { url: string; authKeySet: boolean; ok: boolean; version?: string | null; error?: string }
  deploy: { containerRunning: boolean; url?: string; port: number }
  ingest: { tokenSet: boolean }
  connectors: Array<{ id: string; enabled: boolean; interval: number; lastRun: string; lastStatus: string; lastCount: number }>
}

export function MispTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr } = useI18n()
  const [s, setS] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<MispState | null>(null)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [deployMsg, setDeployMsg] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [connMsg, setConnMsg] = useState<Record<string, string>>({})
  const [showKey, setShowKey] = useState(false)
  const [tokenShown, setTokenShown] = useState<string | null>(null)
  // отредактированные ключи переживают опрос /api/dashboard (см. integrations-tab)
  const editedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (data?.settings) {
      setS((prev) => {
        const next = { ...data.settings }
        for (const k of editedRef.current) if (k in prev) next[k] = prev[k]
        return next
      })
    }
  }, [data?.settings])

  const set = (k: string, v: string) => {
    editedRef.current.add(k)
    setS((prev) => ({ ...prev, [k]: v }))
  }

  const refreshState = useCallback(async () => {
    try {
      const r = await api.mispState()
      setState(r)
    } catch {
      /* состояние придёт при следующем опросе */
    }
  }, [])

  useEffect(() => {
    void refreshState()
    const id = setInterval(() => void refreshState(), 20_000)
    return () => clearInterval(id)
  }, [refreshState])

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

  const testConnection = async () => {
    setTestMsg('…')
    try {
      await api.saveSettings({ mispUrl: s.mispUrl ?? '', mispAuthKey: s.mispAuthKey ?? '' })
      const r = await api.mispAction({ action: 'test', url: s.mispUrl ?? '', key: s.mispAuthKey ?? '' })
      setTestMsg(r.ok ? tr(t.misp.testOk, { version: String(r.version ?? '?') }) : `${t.misp.testFail}: ${r.error}`)
      await refreshState()
    } catch (e) {
      setTestMsg((e as Error).message)
    }
  }

  const deployMisp = async () => {
    setDeploying(true)
    setDeployMsg(null)
    try {
      await api.saveSettings({ mispDeployPort: s.mispDeployPort ?? '', mispDeployBaseUrl: s.mispDeployBaseUrl ?? '' })
      const r = await api.mispAction({ action: 'deploy', port: s.mispDeployPort || undefined, baseUrl: s.mispDeployBaseUrl || undefined })
      const lines = (r.instructions as string[] | undefined) ?? []
      setDeployMsg(!!r.ok ? [`${t.misp.deployed}${r.url ? `: ${String(r.url)}` : ''}`, ...lines].join('\n') : `${t.misp.testFail}: ${r.error}`)
      await refreshState()
    } catch (e) {
      setDeployMsg((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  const removeMisp = async () => {
    setDeploying(true)
    try {
      const r = await api.mispAction({ action: 'remove' })
      setDeployMsg(r.ok ? t.misp.removed : String(r.error ?? t.misp.testFail))
      await refreshState()
    } catch (e) {
      setDeployMsg((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  const runConnector = async (id: string) => {
    setConnMsg((prev) => ({ ...prev, [id]: '…' }))
    try {
      const r = await api.mispAction({ action: 'run-connector', id })
      setConnMsg((prev) => ({
        ...prev,
        [id]: r.ok ? (r.empty ? t.misp.connEmpty : tr(t.misp.connRunOk, { n: String(r.count ?? 0), id: String(r.eventId ?? '—') })) : `${t.misp.testFail}: ${r.error}`,
      }))
      await refreshState()
    } catch (e) {
      setConnMsg((prev) => ({ ...prev, [id]: (e as Error).message }))
    }
  }

  const regenToken = async () => {
    try {
      const r = await api.mispAction({ action: 'regen-ingest-token' })
      if (r.ok && typeof r.token === 'string') setTokenShown(r.token)
      await refreshState()
    } catch (e) {
      setTokenShown((e as Error).message)
    }
  }

  const running = state?.deploy.containerRunning === true
  const conn = state?.connection
  const ingestToken = tokenShown ?? (state?.ingest.tokenSet ? s.mispIngestToken || t.misp.webhookTokenSet : '')

  return (
    <div className="space-y-4">
      {/* ── Связь с MISP ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.misp.connTitle}</CardTitle>
          <CardDescription>{t.misp.connDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge ok={!!conn?.ok} on={conn?.version ? tr(t.misp.statusOn, { version: conn.version }) : t.misp.statusOn} off={t.misp.statusOff} />
            {conn?.error && <span className="text-xs text-red-600 truncate max-w-full">{conn.error}</span>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <Label className="text-foreground">{t.misp.connUrl}</Label>
              <Input value={s.mispUrl ?? ''} onChange={(e) => set('mispUrl', e.target.value.trim())} className="bg-card border-input" placeholder="https://misp.example.local (или http://172.17.0.1:8408)" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-foreground">{t.misp.connKey}</Label>
              <div className="relative">
                <Input type={showKey ? 'text' : 'password'} value={s.mispAuthKey ?? ''} onChange={(e) => set('mispAuthKey', e.target.value.trim())} className="bg-card border-input font-mono pr-9" placeholder={t.settings.mispPlaceholder} />
                <button type="button" tabIndex={-1} aria-label={showKey ? 'hide' : 'show'} onClick={() => setShowKey((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-1 whitespace-pre-line">{t.misp.connKeyHelp}</p>
            </div>
            <div>
              <Label className="text-foreground">{t.misp.connDist}</Label>
              <Select value={s.mispDistribution ?? '1'} onValueChange={(v) => set('mispDistribution', v)}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="0">{t.misp.distOrg}</SelectItem>
                  <SelectItem value="1">{t.misp.distCommunity}</SelectItem>
                  <SelectItem value="2">{t.misp.distConnected}</SelectItem>
                  <SelectItem value="3">{t.misp.distAll}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">{t.misp.connThreat}</Label>
              <Select value={s.mispThreatLevel ?? '2'} onValueChange={(v) => set('mispThreatLevel', v)}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="1">{t.misp.threatHigh}</SelectItem>
                  <SelectItem value="2">{t.misp.threatMedium}</SelectItem>
                  <SelectItem value="3">{t.misp.threatLow}</SelectItem>
                  <SelectItem value="4">{t.misp.threatUndefined}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end pb-1">
              <SwitchRow label={t.misp.connPublished} checked={(s.mispPublished ?? 'false') === 'true'} onChange={(v) => set('mispPublished', String(v))} />
            </div>
            <div>
              <Label className="text-foreground">{t.misp.connTagPrefix}</Label>
              <Input value={s.mispTagPrefix ?? ''} onChange={(e) => set('mispTagPrefix', e.target.value.trim())} className="bg-card border-input font-mono" />
              <p className="text-xs text-muted-foreground mt-1">{t.misp.connTagPrefixHelp}</p>
            </div>
            <div className="flex items-end">
              <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => void testConnection()}>
                <Send className="h-3.5 w-3.5 mr-1.5" /> {t.misp.test}
              </Button>
            </div>
          </div>
          {testMsg && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{testMsg}</p>}
        </CardContent>
      </Card>

      {/* ── Развёртывание MISP (docker compose) ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.misp.deployTitle}</CardTitle>
          <CardDescription>{t.misp.deployDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge ok={running} on={t.misp.deployOn} off={t.misp.deployOff} />
            {running && state?.deploy.url && <code className="text-xs text-emerald-700">{state.deploy.url}</code>}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-36">
              <Label className="text-foreground">{t.misp.deployPort}</Label>
              <Input type="number" value={s.mispDeployPort ?? '8408'} onChange={(e) => set('mispDeployPort', e.target.value)} className="bg-card border-input" disabled={deploying || running} />
            </div>
            <div className="min-w-56 flex-1 max-w-md">
              <Label className="text-foreground">{t.misp.deployBaseUrl}</Label>
              <Input value={s.mispDeployBaseUrl ?? ''} onChange={(e) => set('mispDeployBaseUrl', e.target.value.trim())} className="bg-card border-input" placeholder={t.misp.deployBaseUrlPh} disabled={deploying || running} />
            </div>
            <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => void deployMisp()} disabled={deploying || running} title={running ? t.misp.deployDisabledHint : undefined}>
              <Rocket className="h-3.5 w-3.5 mr-1.5" /> {t.misp.deployBtn}
            </Button>
            {running && (
              <Button size="sm" variant="outline" className="border-red-300 text-red-600" onClick={() => void removeMisp()} disabled={deploying}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> {t.misp.remove}
              </Button>
            )}
          </div>
          {running && <p className="text-xs text-amber-700">{t.misp.deployDisabledHint}</p>}
          {deployMsg && <pre className="text-xs whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 max-h-56 overflow-auto">{deployMsg}</pre>}
        </CardContent>
      </Card>

      {/* ── Коннекторы ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.misp.connCardTitle}</CardTitle>
          <CardDescription>{t.misp.connCardDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConnectorRow
            id="clearndr"
            title={t.misp.connClearndrTitle}
            desc={t.misp.connClearndrDesc}
            s={s}
            set={set}
            state={state}
            result={connMsg.clearndr}

            t={t}
            onRun={() => void runConnector('clearndr')}
            extra={
              <div>
                <Label className="text-foreground">{t.misp.connClearndrIndex}</Label>
                <Input value={s.mispConnClearndrIndex ?? ''} onChange={(e) => set('mispConnClearndrIndex', e.target.value.trim())} className="bg-card border-input font-mono" />
              </div>
            }
          />
          <ConnectorRow
            id="wazuh"
            title={t.misp.connWazuhTitle}
            desc={t.misp.connWazuhDesc}
            s={s}
            set={set}
            state={state}
            result={connMsg.wazuh}

            t={t}
            onRun={() => void runConnector('wazuh')}
            extra={
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full">
                <div className="md:col-span-2">
                  <Label className="text-foreground">{t.misp.connWazuhUrl}</Label>
                  <Input value={s.mispConnWazuhUrl ?? ''} onChange={(e) => set('mispConnWazuhUrl', e.target.value.trim())} className="bg-card border-input font-mono" placeholder="https://wazuh-indexer.local:9200" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connWazuhUser}</Label>
                  <Input value={s.mispConnWazuhUser ?? ''} onChange={(e) => set('mispConnWazuhUser', e.target.value.trim())} className="bg-card border-input" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connWazuhPass}</Label>
                  <Input type="password" value={s.mispConnWazuhPass ?? ''} onChange={(e) => set('mispConnWazuhPass', e.target.value.trim())} className="bg-card border-input font-mono" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connWazuhIndex}</Label>
                  <Input value={s.mispConnWazuhIndex ?? ''} onChange={(e) => set('mispConnWazuhIndex', e.target.value.trim())} className="bg-card border-input font-mono" />
                </div>
              </div>
            }
          />
          <ConnectorRow
            id="zabbix"
            title={t.misp.connZabbixTitle}
            desc={t.misp.connZabbixDesc}
            s={s}
            set={set}
            state={state}
            result={connMsg.zabbix}

            t={t}
            onRun={() => void runConnector('zabbix')}
            extra={
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full">
                <div className="md:col-span-2">
                  <Label className="text-foreground">{t.misp.connZabbixUrl}</Label>
                  <Input value={s.mispConnZabbixUrl ?? ''} onChange={(e) => set('mispConnZabbixUrl', e.target.value.trim())} className="bg-card border-input font-mono" placeholder="http://zabbix.local/api_jsonrpc.php" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connZabbixUser}</Label>
                  <Input value={s.mispConnZabbixUser ?? ''} onChange={(e) => set('mispConnZabbixUser', e.target.value.trim())} className="bg-card border-input" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connZabbixPassword}</Label>
                  <Input type="password" value={s.mispConnZabbixPassword ?? ''} onChange={(e) => set('mispConnZabbixPassword', e.target.value.trim())} className="bg-card border-input font-mono" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connZabbixToken}</Label>
                  <Input type="password" value={s.mispConnZabbixToken ?? ''} onChange={(e) => set('mispConnZabbixToken', e.target.value.trim())} className="bg-card border-input font-mono" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connZabbixMinSev}</Label>
                  <Select value={s.mispConnZabbixMinSeverity ?? '2'} onValueChange={(v) => set('mispConnZabbixMinSeverity', v)}>
                    <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      <SelectItem value="0">{t.misp.sev0}</SelectItem>
                      <SelectItem value="1">{t.misp.sev1}</SelectItem>
                      <SelectItem value="2">{t.misp.sev2}</SelectItem>
                      <SelectItem value="3">{t.misp.sev3}</SelectItem>
                      <SelectItem value="4">{t.misp.sev4}</SelectItem>
                      <SelectItem value="5">{t.misp.sev5}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            }
          />
          <ConnectorRow
            id="mikrotik"
            title={t.misp.connMikrotikTitle}
            desc={t.misp.connMikrotikDesc}
            s={s}
            set={set}
            state={state}
            result={connMsg.mikrotik}

            t={t}
            onRun={() => void runConnector('mikrotik')}
            extra={
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full">
                <div className="md:col-span-2">
                  <Label className="text-foreground">{t.misp.connMikrotikUrl}</Label>
                  <Input value={s.mispConnMikrotikUrl ?? ''} onChange={(e) => set('mispConnMikrotikUrl', e.target.value.trim())} className="bg-card border-input font-mono" placeholder="https://192.168.88.1/rest" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connMikrotikUser}</Label>
                  <Input value={s.mispConnMikrotikUser ?? ''} onChange={(e) => set('mispConnMikrotikUser', e.target.value.trim())} className="bg-card border-input" />
                </div>
                <div>
                  <Label className="text-foreground">{t.misp.connMikrotikPass}</Label>
                  <Input type="password" value={s.mispConnMikrotikPass ?? ''} onChange={(e) => set('mispConnMikrotikPass', e.target.value.trim())} className="bg-card border-input font-mono" />
                </div>
                <div className="md:col-span-2">
                  <Label className="text-foreground">{t.misp.connMikrotikLists}</Label>
                  <Input value={s.mispConnMikrotikLists ?? ''} onChange={(e) => set('mispConnMikrotikLists', e.target.value)} className="bg-card border-input font-mono" placeholder="blacklist, malware" />
                </div>
              </div>
            }
          />
        </CardContent>
      </Card>

      {/* ── Webhook-приёмник ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.misp.webhookTitle}</CardTitle>
          <CardDescription>{t.misp.webhookDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-72 flex-1 max-w-xl">
              <Label className="text-foreground">{t.misp.webhookToken}</Label>
              <Input readOnly value={ingestToken} className="bg-muted/40 border-input font-mono text-xs" placeholder={t.misp.webhookTokenSet} />
            </div>
            <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => void regenToken()}>
              {t.misp.webhookRegen}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t.misp.webhookTokenHelp}</p>
          <pre className="text-xs rounded-lg border border-border bg-muted/40 p-3 overflow-auto whitespace-pre-wrap">{curlExample(ingestToken)}</pre>
          <p className="text-xs text-muted-foreground">{t.misp.webhookExample}</p>
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

/** Строка коннектора: вкл/интервал/запуск/состояние + специфичные поля */
function ConnectorRow({
  id,
  title,
  desc,
  s,
  set,
  state,
  result,
  onRun,
  extra,
  t,
}: {
  id: string
  title: string
  desc: string
  s: Record<string, string>
  set: (k: string, v: string) => void
  state: MispState | null
  result?: string
  onRun: () => void
  extra?: React.ReactNode
  t: ReturnType<typeof useI18n>['t']
}) {
  const row = state?.connectors.find((c) => c.id === id)
  const cap = id.charAt(0).toUpperCase() + id.slice(1)
  const status = row?.lastStatus
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
        <Switch checked={row?.enabled === true} onCheckedChange={(v) => set(`mispConn${cap}Enabled`, String(v))} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-28">
          <Label className="text-foreground">{t.misp.connInterval}</Label>
          <Input type="number" min={1} value={s[`mispConn${cap}Interval`] ?? ''} onChange={(e) => set(`mispConn${cap}Interval`, e.target.value)} className="bg-card border-input" placeholder={String(row?.interval ?? 15)} />
        </div>
        <div className="flex flex-col gap-1">
          <Button size="sm" variant="outline" className="border-input text-foreground" onClick={onRun}>
            <Play className="h-3.5 w-3.5 mr-1.5" /> {t.misp.connRun}
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          <p>
            {t.misp.connLast}: {row?.lastRun ? fmtTime(row.lastRun, 'ru') : t.misp.connNever}
            {row?.lastRun && row.lastCount > 0 ? ` · ${row.lastCount} ${t.misp.connCount}` : ''}
          </p>
          <p className="mt-0.5">
            {status === 'ok' && <span className="text-emerald-700">{t.misp.connOk}</span>}
            {status === 'empty' && <span>{t.misp.connEmpty}</span>}
            {status === 'error' && <span className="text-red-600">{t.misp.connError}</span>}
            {!status && <span>{t.misp.connNever}</span>}
          </p>
        </div>
      </div>
      {extra}
      {result && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{result}</p>}
    </div>
  )
}

function StateBadge({ ok, on, off }: { ok: boolean; on: string; off: string }) {
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

/** curl-пример для webhook-приёмника (обрезанный токен — не светим целиком) */
function curlExample(token: string): string {
  const t = token && !token.includes(' ') ? token.slice(0, 14) + '…' : '<TOKEN>'
  return [
    `curl -k -X POST https://<адрес-хаба>:3080/api/misp/ingest \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H 'x-ingest-token: ${t}' \\`,
    `  -d '{"source":"uuwaf","info":"uuWAF: атака","type":"ip-src","values":["203.0.113.7"],"tags":["waf"]}'`,
  ].join('\n')
}
