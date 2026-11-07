'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, fmtTime, VpnState } from '@/components/hub/api'
import { Play, Power, Save, ShieldOff, Trash2, Wifi, Wrench } from 'lucide-react'

const SAMPLE_CONFIG = `# Пример конфигурации wg-quick
[Interface]
PrivateKey = <приватный ключ клиента>
Address = 10.66.66.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <публичный ключ сервера>
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
PersistentKeepalive = 25
`

export function VpnTab({ data, onChange }: { data: unknown; onChange: () => void }) {
  const [vpn, setVpn] = useState<VpnState | null>(null)
  const [name, setName] = useState('wg0')
  const [config, setConfig] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const didAutoLoad = useRef(false)
  const load = useCallback(async () => {
    try {
      const v = await api.vpn()
      setVpn(v)
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
            ? { ok: true, text: `Конфиг валиден: интерфейс ${c.iface}, пиров: ${c.peers}, endpoint: ${c.endpoint ?? '—'}` }
            : { ok: false, text: `Ошибка конфига: ${c?.error ?? 'неизвестная'}` }
        )
        return
      }
      if (r.ok) setMsg({ ok: true, text: (r.detail as string) ?? 'выполнено' })
      else setMsg({ ok: false, text: (r.error as string) ?? 'ошибка' })
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
      setMsg({ ok: true, text: `Профиль «${name}» сохранён — он появился в списке «Сохранённые профили» ниже` })
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
            <Wrench className="h-4 w-4 text-primary" /> Проверка окружения WireGuard
            <Button size="sm" variant="outline" className="ml-auto border-input text-foreground" onClick={() => void load()}>
              Проверить снова
            </Button>
          </CardTitle>
          <CardDescription>
            Для работы туннеля в контейнере требуются: wireguard-tools, /dev/net/tun и права NET_ADMIN
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Check label="wg (утилита)" ok={tools?.wg} />
            <Check label="wg-quick" ok={tools?.wgQuick} />
            <Check label="/dev/net/tun" ok={tools?.tunDevice} />
            <Check label="NET_ADMIN" ok={tools?.netAdmin} />
          </div>
          {tools && tools.notes.length > 0 && (
            <ul className="mt-3 space-y-1">
              {tools.notes.map((n, i) => (
                <li key={i} className="text-xs text-amber-700">⚠ {n}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground space-y-1">
            <p>docker-compose уже содержит необходимые параметры:</p>
            <code className="block text-emerald-700">cap_add: [NET_ADMIN] · devices: [/dev/net/tun] · sysctls: net.ipv4.ip_forward=1</code>
            <p>На хосте достаточно установить wireguard-tools в контейнерном образе — он уже включён.</p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Wifi className="h-4 w-4 text-primary" /> Конфигурация туннеля (wg-quick)
          </CardTitle>
          <CardDescription>
            Вставьте конфиг .conf от вашего WireGuard-сервера. Профили хранятся в БД и переживают
            перезагрузку страницы и рестарт контейнера; при открытии вкладки в редактор
            автоматически подставляется активный (или первый) сохранённый профиль.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="w-48">
              <Label className="text-foreground">Имя интерфейса/профиля</Label>
              <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))} className="bg-card border-input" placeholder="wg0" />
            </div>
            <Button variant="outline" className="border-input text-foreground" onClick={() => setConfig(SAMPLE_CONFIG)}>
              Пример конфига
            </Button>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={save} disabled={busy || !config || !name}>
              <Save className="h-4 w-4 mr-1.5" /> Сохранить
            </Button>
            <Button variant="outline" className="border-emerald-300 text-emerald-700" onClick={() => act('up', { config, name })} disabled={busy || !config}>
              <Play className="h-4 w-4 mr-1.5" /> Поднять туннель
            </Button>
            <Button variant="outline" className="border-red-300 text-red-600" onClick={() => act('down', { name })} disabled={busy}>
              <Power className="h-4 w-4 mr-1.5" /> Опустить
            </Button>
          </div>
          <Textarea
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={10}
            className="bg-card border-input font-mono text-xs"
            placeholder={SAMPLE_CONFIG}
          />
          <div className="flex gap-2">
            <Button variant="outline" className="border-input text-foreground" onClick={() => act('test-config', { config })} disabled={!config}>
              Проверить синтаксис конфига
            </Button>
          </div>
          {msg && <p className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
        </CardContent>
      </Card>

      {vpn?.profiles && vpn.profiles.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Сохранённые профили</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {vpn.profiles.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                <span className="font-mono text-emerald-700">{p.name}</span>
                <Badge variant="outline" className={p.active ? 'border-emerald-300 text-emerald-700' : 'border-input text-muted-foreground'}>
                  {p.active ? 'активен' : 'неактивен'}
                </Badge>
                <span className="text-xs text-muted-foreground">проверен: {fmtTime(p.lastCheckAt)}</span>
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" className="h-8 border-emerald-300 text-emerald-700" onClick={() => act('up', { id: p.id })} disabled={busy}>
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 border-red-300 text-red-600" onClick={() => act('down', { name: p.name })} disabled={busy}>
                    <ShieldOff className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 border-input text-foreground" onClick={() => { setName(p.name); setConfig(p.config) }}>
                    открыть
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 border-red-300 text-red-600" onClick={async () => { await api.vpnDelete(p.id); await load() }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Активные интерфейсы (wg show)</CardTitle>
          <CardDescription>Статус туннелей, handshake, трафик</CardDescription>
        </CardHeader>
        <CardContent>
          {!vpn?.available && (
            <p className="text-sm text-muted-foreground">
              Статус недоступен: {vpn?.error ?? 'wg не установлен в системе'}.
              В контейнере из docker-compose утилиты установлены — проверка заработает после запуска контейнера.
            </p>
          )}
          {vpn?.available && vpn.interfaces.length === 0 && (
            <p className="text-sm text-muted-foreground">Активных туннелей нет. Поднимите профиль выше.</p>
          )}
          {vpn?.interfaces.map((i) => (
            <div key={i.name} className="mb-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap gap-3 text-sm mb-2">
                <span className="font-mono text-emerald-700">{i.name}</span>
                <span className="text-muted-foreground">порт: {i.listeningPort ?? '—'}</span>
                <span className="text-muted-foreground">public key: <code className="text-xs">{i.publicKey?.slice(0, 20) ?? '—'}…</code></span>
              </div>
              {i.peers.length === 0 && <p className="text-xs text-muted-foreground">Пиров нет.</p>}
              {i.peers.map((p, idx) => (
                <div key={idx} className="text-xs text-muted-foreground border-t border-border/60 py-1.5 flex flex-wrap gap-x-4 gap-y-1">
                  <span className={`inline-block h-2 w-2 rounded-full mt-1 ${p.online ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                  <span>endpoint: <code className="text-foreground">{p.endpoint ?? '—'}</code></span>
                  <span>allowed: <code className="text-foreground">{p.allowedIps ?? '—'}</code></span>
                  <span>handshake: {p.latestHandshake ?? '—'}</span>
                  <span>трафик ↓{fmtBytes(p.transferRx)} ↑{fmtBytes(p.transferTx)}</span>
                </div>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function Check({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${ok ? 'border-emerald-300/60 bg-emerald-50' : 'border-red-300/60 bg-red-50'}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className="text-sm font-medium text-foreground">{label}</span>
      </div>
      <p className={`text-xs mt-1 ${ok ? 'text-emerald-700' : 'text-red-600'}`}>{ok ? 'доступно' : 'недоступно'}</p>
    </div>
  )
}

function fmtBytes(v?: string): string {
  if (!v) return '—'
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return v
  if (n < 1024) return `${n} Б`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} КБ`
  return `${(n / 1048576).toFixed(1)} МБ`
}
