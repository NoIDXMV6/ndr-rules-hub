'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SourcesTab } from '@/components/hub/sources-tab'
import { RulesTab } from '@/components/hub/rules-tab'
import { BuildTab } from '@/components/hub/build-tab'
import { VpnTab } from '@/components/hub/vpn-tab'
import { SettingsTab } from '@/components/hub/settings-tab'
import { LogsTab } from '@/components/hub/logs-tab'
import { HelpTab } from '@/components/hub/help-tab'
import { AboutTab } from '@/components/hub/about-tab'
import { api, Dashboard, fmtSize, fmtTime } from '@/components/hub/api'
import {
  Activity, Database, Download, Globe, Layers, RefreshCw, Wifi,
} from 'lucide-react'

export default function Home() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const d = await api.dashboard()
      setData(d)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 20000)
    return () => clearInterval(t)
  }, [refresh])

  const runCycle = async () => {
    setBusy('cycle')
    setMessage(null)
    try {
      const f = await api.fetchAll()
      setMessage({ ok: f.failed === 0, text: `Обновление источников: успешно ${f.ok}, ошибок ${f.failed}` })
      const b = await api.build(true)
      setMessage({
        ok: !!b.ok,
        text: b.ok ? `Сборка выполнена: ${b.total} правил → ${b.fileName}` : `Ошибка сборки: ${b.error}`,
      })
      await refresh()
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border bg-card/95 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="Логотип NDR Rules Hub" className="h-9 w-9 rounded-lg border border-primary/30" />
            <div>
              <h1 className="text-lg font-bold leading-tight">NDR Rules Hub</h1>
              <p className="text-xs text-muted-foreground leading-tight">
                Управление источниками правил Snort/Suricata для Clear NDR
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {data && (
              <>
                <Badge variant="outline" className="border-input text-foreground">
                  <Database className="h-3 w-3 mr-1" />
                  {data.rules.inDb.toLocaleString('ru-RU')} правил в базе
                </Badge>
                <Badge variant="outline" className={data.vpn.available && data.vpn.interfaces.length > 0 ? 'border-emerald-400 text-emerald-700' : 'border-input text-muted-foreground'}>
                  <Wifi className="h-3 w-3 mr-1" />
                  VPN: {data.vpn.available ? (data.vpn.interfaces.length ? `${data.vpn.interfaces.length} инт.` : 'нет туннелей') : 'недоступен'}
                </Badge>
                <Badge variant="outline" className={data.sources.error > 0 ? 'border-amber-400 text-amber-700' : 'border-input text-muted-foreground'}>
                  <Activity className="h-3 w-3 mr-1" />
                  Источники: {data.sources.ok}/{data.sources.enabled} ОК
                </Badge>
              </>
            )}
            <Button onClick={runCycle} disabled={busy !== null} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busy === 'cycle' ? 'animate-spin' : ''}`} />
              Полный цикл
            </Button>
          </div>
        </div>
        {message && (
          <div className={`px-4 py-1.5 text-sm ${message.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'} border-t border-border`}>
            {message.text}
          </div>
        )}
        {error && (
          <div className="px-4 py-1.5 text-sm bg-red-50 text-red-700 border-t border-border">
            Ошибка связи с API: {error}
          </div>
        )}
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="bg-card border border-border flex-wrap h-auto gap-1 p-1">
            <TabsTrigger value="overview" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Обзор</TabsTrigger>
            <TabsTrigger value="sources" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Источники</TabsTrigger>
            <TabsTrigger value="rules" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Правила</TabsTrigger>
            <TabsTrigger value="build" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Сборка и экспорт</TabsTrigger>
            <TabsTrigger value="vpn" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">WireGuard VPN</TabsTrigger>
            <TabsTrigger value="settings" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Настройки</TabsTrigger>
            <TabsTrigger value="logs" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Журнал</TabsTrigger>
            <TabsTrigger value="help" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Помощь</TabsTrigger>
            <TabsTrigger value="about" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">О системе</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <Overview data={data} onRefresh={refresh} />
          </TabsContent>
          <TabsContent value="sources" className="mt-4">
            <SourcesTab data={data} onChange={refresh} />
          </TabsContent>
          <TabsContent value="rules" className="mt-4">
            <RulesTab data={data} />
          </TabsContent>
          <TabsContent value="build" className="mt-4">
            <BuildTab data={data} onChange={refresh} />
          </TabsContent>
          <TabsContent value="vpn" className="mt-4">
            <VpnTab data={data} onChange={refresh} />
          </TabsContent>
          <TabsContent value="settings" className="mt-4">
            <SettingsTab data={data} onChange={refresh} />
          </TabsContent>
          <TabsContent value="logs" className="mt-4">
            <LogsTab />
          </TabsContent>
          <TabsContent value="help" className="mt-4">
            <HelpTab />
          </TabsContent>
          <TabsContent value="about" className="mt-4">
            <AboutTab />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="mt-auto border-t border-border bg-card">
        <div className="max-w-7xl mx-auto px-4 py-3 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>NDR Rules Hub — объединение, дедупликация и экспорт наборов правил Snort/Suricata</span>
          <span>Разработчик: <a href="https://kozhevatov.ru" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Павел Кожеватов</a> · <a href="https://github.com/NoIDXMV6/ndr-rules-hub" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">репозиторий</a></span>
          <span className="ml-auto">Экспорт: файл для импорта в Clear NDR · HTTP push · локальный каталог</span>
        </div>
      </footer>
    </div>
  )
}

function StatCard({ title, value, sub, icon }: { title: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-1">
        <CardDescription className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {icon}
          {title}
        </CardDescription>
        <CardTitle className="text-2xl text-foreground tabular-nums">{value}</CardTitle>
      </CardHeader>
      {sub && <CardContent className="text-xs text-muted-foreground">{sub}</CardContent>}
    </Card>
  )
}

function Overview({ data, onRefresh }: { data: Dashboard | null; onRefresh: () => void }) {
  if (!data) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <RefreshCw className="h-5 w-5 mr-2 animate-spin" /> Загрузка данных…
      </div>
    )
  }
  const b = data.lastBuild
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Источники" value={`${data.sources.enabled}/${data.sources.total}`} sub={`включено / всего · ошибок: ${data.sources.error}`} icon={<Globe className="h-3.5 w-3.5" />} />
        <StatCard title="Правил в базе" value={data.rules.inDb.toLocaleString('ru-RU')} sub="по всем загруженным источникам" icon={<Database className="h-3.5 w-3.5" />} />
        <StatCard title="Правил в сборке" value={b ? b.totalRules.toLocaleString('ru-RU') : '—'} sub={b ? `${b.fileName} · ${fmtSize(b.sizeBytes)}` : 'сборка ещё не выполнялась'} icon={<Layers className="h-3.5 w-3.5" />} />
        <StatCard title="Дубликатов устранено" value={b ? (b.stats.duplicateBySid + b.stats.duplicateByContent).toLocaleString('ru-RU') : '—'} sub={b ? `по SID: ${b.stats.duplicateBySid.toLocaleString('ru-RU')} · по содержимому: ${b.stats.duplicateByContent.toLocaleString('ru-RU')}` : ''} icon={<Activity className="h-3.5 w-3.5" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base">Последняя сборка</CardTitle>
            <CardDescription>Итоговый файл для импорта в Clear NDR</CardDescription>
          </CardHeader>
          <CardContent>
            {b ? (
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <span className="text-muted-foreground">Файл: <code className="text-emerald-700">{b.fileName}</code></span>
                  <span className="text-muted-foreground">Размер: {fmtSize(b.sizeBytes)}</span>
                  <span className="text-muted-foreground">Создан: {fmtTime(b.createdAt)}</span>
                </div>
                <div className="text-xs text-muted-foreground break-all">SHA-256: <code>{b.sha256}</code></div>
                <div className="flex gap-2 pt-1">
                  <a href="/api/export" download>
                    <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground">
                      <Download className="h-4 w-4 mr-1.5" /> Скачать итоговый файл
                    </Button>
                  </a>
                  <Button size="sm" variant="outline" className="border-input text-foreground" onClick={onRefresh}>
                    <RefreshCw className="h-4 w-4 mr-1.5" /> Обновить
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Сборка ещё не выполнялась. Перейдите на вкладку «Сборка и экспорт» или нажмите «Полный цикл».
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base">WireGuard VPN</CardTitle>
            <CardDescription>Туннель для загрузки правил</CardDescription>
          </CardHeader>
          <CardContent>
            {data.vpn.available ? (
              data.vpn.interfaces.length > 0 ? (
                <div className="space-y-2">
                  {data.vpn.interfaces.map((i) => (
                    <div key={i.name} className="text-sm flex flex-wrap gap-x-4">
                      <span className="font-mono text-emerald-700">{i.name}</span>
                      <span className="text-muted-foreground">порт {i.listeningPort ?? '—'}</span>
                      <span className="text-muted-foreground">пиров: {i.peers.length}</span>
                      {i.peers.some((p) => p.online) && <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-300">handshake активен</Badge>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Инструменты wg доступны, активных туннелей нет.</p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">Статус недоступен: {data.vpn.error ?? 'wg не установлен'}. Настройте профиль на вкладке «WireGuard VPN».</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Последние события</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {data.logs.length === 0 && <p className="text-sm text-muted-foreground">Пока нет событий.</p>}
            {data.logs.slice(0, 20).map((l) => (
              <div key={l.id} className="flex items-start gap-2 text-sm">
                <Badge
                  variant="outline"
                  className={
                    l.level === 'success' ? 'border-emerald-300 text-emerald-700 shrink-0' :
                    l.level === 'error' ? 'border-red-300 text-red-600 shrink-0' :
                    l.level === 'warn' ? 'border-amber-300 text-amber-700 shrink-0' :
                    'border-input text-muted-foreground shrink-0'
                  }
                >
                  {l.scope}
                </Badge>
                <span className="text-muted-foreground shrink-0 tabular-nums text-xs mt-0.5">{fmtTime(l.ts)}</span>
                <span className="text-foreground">{l.message}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
