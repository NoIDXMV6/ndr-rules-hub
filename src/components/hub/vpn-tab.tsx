'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, fmtTime, VpnState } from '@/components/hub/api'
import { useI18n, type Lang } from '@/lib/i18n'
import { Play, Power, Save, ShieldOff, Trash2, Wifi, Wrench } from 'lucide-react'

const SAMPLE_CONFIGS: Record<Lang, string> = {
  ru: `# Пример конфигурации wg-quick
[Interface]
PrivateKey = <приватный ключ клиента>
Address = 10.66.66.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <публичный ключ сервера>
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
PersistentKeepalive = 25
`,
  en: `# wg-quick configuration example
[Interface]
PrivateKey = <client private key>
Address = 10.66.66.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <server public key>
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
PersistentKeepalive = 25
`,
}

export function VpnTab({ data, onChange }: { data: unknown; onChange: () => void }) {
  const { t, tr, lang } = useI18n()
  const [vpn, setVpn] = useState<VpnState | null>(null)
  const [name, setName] = useState('wg0')
  const [config, setConfig] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // true — последняя попытка загрузки статуса не дошла до API (сервер недоступен,
  // например web UI «завёрнут» в full-tunnel туннель). Карточки при этом НЕ должны
  // показывать «недоступно» — это ложь про окружение; показываем баннер и «нет данных»
  const [connError, setConnError] = useState(false)

  const didAutoLoad = useRef(false)
  const load = useCallback(async () => {
    try {
      const v = await api.vpn()
      setVpn(v)
      setConnError(false)
      // при первом открытии вкладки автоматически подставляем активный
      // (или первый) сохранённый профиль в редактор — иначе после
      // перезагрузки страницы пустое поле выглядит как «конфиг не сохранился»
      if (!didAutoLoad.current) {
        didAutoLoad.current = true
        const ps = v.profiles ?? []
        if (ps.length > 0) {
          const p = ps.find((x) => x.active) ?? ps[0]
          setName(p.name)
          setConfig(p.config)
        }
      }
    } catch (e) {
      setConnError(true)
      setMsg({ ok: false, text: (e as Error).message })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.vpnAction({ action, ...extra })
      if (action === 'test-config') {
        const c = r.configOk as { ok: boolean; error?: string; iface?: string; peers?: number; endpoint?: string } | undefined
        setMsg(
          c?.ok
            ? { ok: true, text: tr(t.vpn.configOk, { iface: c.iface ?? '—', peers: c.peers ?? '—', ep: c.endpoint ?? '—' }) }
            : { ok: false, text: tr(t.vpn.configErr, { err: c?.error ?? '—' }) }
        )
        return
      }
      if (r.ok) {
        const notes = (r.notes as string[] | undefined) ?? []
        setMsg({ ok: true, text: ((r.detail as string) ?? t.vpn.msgDone) + (notes.length ? `\n${notes.join('\n')}` : '') })
        await load()
        onChange()
        // после подъёма ждём первый handshake и обновляем статус ещё раз
        if (action === 'up') setTimeout(() => void load(), 3500)
        return
      }
      const notes = (r.notes as string[] | undefined) ?? []
      setMsg({ ok: false, text: ((r.error as string) ?? t.vpn.msgError) + (notes.length ? `\n${notes.join('\n')}` : '') })
      await load()
      onChange()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.vpnSave(name, config)
      setMsg({ ok: true, text: tr(t.vpn.profileSaved, { name }) })
      await load()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const tools = vpn?.tools

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" /> {t.vpn.envTitle}
            <Button size="sm" variant="outline" className="ml-auto border-input text-foreground" onClick={() => void load()}>
              {t.vpn.recheck}
            </Button>
          </CardTitle>
          <CardDescription>{t.vpn.envDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          {connError && (
            <div className="mb-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-800 space-y-1">
              <p>{t.vpn.connError1}</p>
              <p>
                {t.vpn.connError2}{' '}
                <code className="text-foreground">docker compose exec rules-hub wg-quick down /app/data/wireguard/wg0.conf</code>{' '}
                {t.vpn.connErrorOr}{' '}
                <code className="text-foreground">docker compose restart rules-hub</code>.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Check label={t.vpn.checkWg} ok={tools?.wg} />
            <Check label={t.vpn.checkWgQuick} ok={tools?.wgQuick} />
            <Check label={t.vpn.checkTun} ok={tools?.tunDevice} />
            <Check label={t.vpn.checkNetAdmin} ok={tools?.netAdmin} />
            <Check label={t.vpn.checkSysctl} ok={tools?.sysctl} />
            <Check label={t.vpn.checkSrcValidMark} ok={tools?.srcValidMark} />
          </div>
          {tools && tools.notes.length > 0 && (
            <ul className="mt-3 space-y-1">
              {tools.notes.map((n, i) => (
                <li key={i} className="text-xs text-amber-700">⚠ {n}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground space-y-1">
            <p>{t.vpn.composeInfo1}</p>
            <code className="block text-emerald-700">cap_add: [NET_ADMIN] · devices: [/dev/net/tun] · sysctls: net.ipv4.ip_forward=1</code>
            <p>{t.vpn.composeInfo2}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Wifi className="h-4 w-4 text-primary" /> {t.vpn.configTitle}
          </CardTitle>
          <CardDescription>{t.vpn.configDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="w-48">
              <Label className="text-foreground">{t.vpn.ifaceName}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))} className="bg-card border-input" placeholder="wg0" />
            </div>
            <Button variant="outline" className="border-input text-foreground" onClick={() => setConfig(SAMPLE_CONFIGS[lang])}>
              {t.vpn.sample}
            </Button>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={save} disabled={busy || !config || !name}>
              <Save className="h-4 w-4 mr-1.5" /> {t.vpn.save}
            </Button>
            <Button variant="outline" className="border-emerald-300 text-emerald-700" onClick={() => act('up', { config, name })} disabled={busy || !config}>
              <Play className="h-4 w-4 mr-1.5" /> {t.vpn.up}
            </Button>
            <Button variant="outline" className="border-red-300 text-red-600" onClick={() => act('down', { name })} disabled={busy}>
              <Power className="h-4 w-4 mr-1.5" /> {t.vpn.down}
            </Button>
          </div>
          <Textarea
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={10}
            className="bg-card border-input font-mono text-xs"
            placeholder={SAMPLE_CONFIGS[lang]}
          />
          <div className="flex gap-2">
            <Button variant="outline" className="border-input text-foreground" onClick={() => act('test-config', { config })} disabled={!config}>
              {t.vpn.checkSyntax}
            </Button>
          </div>
          {msg && (msg.ok ? (
            <p className="text-sm text-emerald-700 whitespace-pre-wrap">{msg.text}</p>
          ) : (
            <pre className="text-xs text-red-700 whitespace-pre-wrap rounded-lg border border-red-300/60 bg-red-50 p-3 max-h-64 overflow-auto font-mono">{msg.text}</pre>
          ))}
        </CardContent>
      </Card>

      {vpn?.profiles && vpn.profiles.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t.vpn.profiles}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {vpn.profiles.map((p) => {
              const last = parseLastStatus(p.lastStatusJson)
              return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                <span className="font-mono text-emerald-700">{p.name}</span>
                <Badge variant="outline" className={p.active ? 'border-emerald-300 text-emerald-700' : 'border-input text-muted-foreground'}>
                  {p.active ? t.vpn.active : t.vpn.inactive}
                </Badge>
                <span className="text-xs text-muted-foreground">{tr(t.vpn.checkedAt, { t: fmtTime(p.lastCheckAt, lang) })}</span>
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" className="h-8 border-emerald-300 text-emerald-700" onClick={() => act('up', { id: p.id })} disabled={busy}>
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 border-red-300 text-red-600" onClick={() => act('down', { name: p.name, id: p.id })} disabled={busy}>
                    <ShieldOff className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 border-input text-foreground" onClick={() => { setName(p.name); setConfig(p.config) }}>
                    {t.vpn.open}
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 border-red-300 text-red-600" onClick={async () => { await api.vpnDelete(p.id); await load() }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {last?.ok === false && last.error && (
                  <pre className="w-full text-xs text-red-700 whitespace-pre-wrap rounded border border-red-300/50 bg-red-50 p-2 font-mono max-h-32 overflow-auto">{tr(t.vpn.lastAttempt, { action: last.action ?? '', err: last.error })}</pre>
                )}
                {last?.ok === true && last.notes && last.notes.length > 0 && (
                  <p className="w-full text-xs text-amber-700">⚠ {last.notes.join(' · ')}</p>
                )}
              </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.vpn.ifaces}</CardTitle>
          <CardDescription>{t.vpn.ifacesDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          {!vpn?.available && (
            <p className="text-sm text-muted-foreground">
              {tr(t.vpn.statusUnavailable, { err: vpn?.error ?? 'wg' })}
            </p>
          )}
          {vpn?.available && vpn.interfaces.length === 0 && (
            <p className="text-sm text-muted-foreground">{t.vpn.noTunnels}</p>
          )}
          {vpn?.interfaces.map((i) => (
            <div key={i.name} className="mb-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap gap-3 text-sm mb-2">
                <span className="font-mono text-emerald-700">{i.name}</span>
                <span className="text-muted-foreground">{t.vpn.port} {i.listeningPort ?? '—'}</span>
                <span className="text-muted-foreground">{t.vpn.publicKey} <code className="text-xs">{i.publicKey?.slice(0, 20) ?? '—'}…</code></span>
              </div>
              {i.peers.length === 0 && <p className="text-xs text-muted-foreground">{t.vpn.noPeers}</p>}
              {i.peers.map((p, idx) => (
                <div key={idx} className="text-xs text-muted-foreground border-t border-border/60 py-1.5 flex flex-wrap gap-x-4 gap-y-1">
                  <span className={`inline-block h-2 w-2 rounded-full mt-1 ${p.online ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                  <span>{t.vpn.endpoint} <code className="text-foreground">{p.endpoint ?? '—'}</code></span>
                  <span>{t.vpn.allowed} <code className="text-foreground">{p.allowedIps ?? '—'}</code></span>
                  <span>{t.vpn.handshake} {p.latestHandshake ?? '—'}</span>
                  <span>{t.vpn.traffic} ↓{fmtBytes(p.transferRx, lang)} ↑{fmtBytes(p.transferTx, lang)}</span>
                </div>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

/** Разобрать lastStatusJson профиля: результат последней операции up/down */
function parseLastStatus(json?: string | null): { action?: string; ok?: boolean; error?: string | null; notes?: string[] } | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as { action?: string; ok?: boolean; error?: string | null; notes?: string[] }
    return v
  } catch {
    return null
  }
}

function Check({ label, ok }: { label: string; ok?: boolean }) {
  const { t } = useI18n()
  // три состояния: true — «доступно», false — «недоступно», undefined — данных
  // нет (API не ответил): показывать в этом случае «недоступно» — дезинформация
  const state = ok === undefined ? 'unknown' : ok ? 'ok' : 'fail'
  const box = state === 'ok' ? 'border-emerald-300/60 bg-emerald-50' : state === 'fail' ? 'border-red-300/60 bg-red-50' : 'border-border bg-muted/40'
  const dot = state === 'ok' ? 'bg-emerald-500' : state === 'fail' ? 'bg-red-500' : 'bg-zinc-400'
  const text = state === 'ok' ? t.vpn.stateOk : state === 'fail' ? t.vpn.stateFail : t.vpn.stateUnknown
  const textColor = state === 'ok' ? 'text-emerald-700' : state === 'fail' ? 'text-red-600' : 'text-muted-foreground'
  return (
    <div className={`rounded-lg border p-3 ${box}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      <p className={`text-xs mt-1 ${textColor}`}>{text}</p>
    </div>
  )
}

function fmtBytes(v: string | undefined, lang: Lang): string {
  const u = lang === 'ru' ? { B: 'Б', KB: 'КБ', MB: 'МБ' } : { B: 'B', KB: 'KB', MB: 'MB' }
  if (!v) return '—'
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return v
  if (n < 1024) return `${n} ${u.B}`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} ${u.KB}`
  return `${(n / 1048576).toFixed(1)} ${u.MB}`
}
