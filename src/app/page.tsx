'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SourcesTab } from '@/components/hub/sources-tab'
import { CategoriesTab } from '@/components/hub/categories-tab'
import { RulesTab } from '@/components/hub/rules-tab'
import { BuildTab } from '@/components/hub/build-tab'
import { VpnTab } from '@/components/hub/vpn-tab'
import { UpdateTab } from '@/components/hub/update-tab'
import { OsdTab } from '@/components/hub/osd-tab'
import { SettingsTab } from '@/components/hub/settings-tab'
import { LogsTab } from '@/components/hub/logs-tab'
import { UsersTab } from '@/components/hub/users-tab'
import { HelpTab } from '@/components/hub/help-tab'
import { AboutTab } from '@/components/hub/about-tab'
import { AuthScreen } from '@/components/hub/auth-screen'
import { api, Dashboard, fmtSize, fmtTime, type Me } from '@/components/hub/api'
import { useI18n, type Lang } from '@/lib/i18n'
import { editionLabel } from '@/lib/edition'
import {
  Activity, Database, Download, Globe, Layers, LogOut, RefreshCw, Wifi,
} from 'lucide-react'

type Role = 'admin' | 'user' | 'anon'

export default function Home() {
  const { t, tr, lang, loc } = useI18n()
  const [data, setData] = useState<Dashboard | null>(null)
  const [me, setMe] = useState<Me | null>(null)
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

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me())
    } catch {
      setMe((m) => m) // при сбое /api/auth/me держим прежнее состояние
    }
  }, [])

  useEffect(() => {
    void refreshMe()
    const t = setInterval(() => void refreshMe(), 30000)
    return () => clearInterval(t)
  }, [refreshMe])

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
      setMessage({ ok: f.failed === 0, text: tr(t.messages.cycleFetch, { ok: f.ok, failed: f.failed }) })
      const b = await api.build(true)
      setMessage({
        ok: !!b.ok,
        text: b.ok
          ? tr(t.messages.cycleBuilt, { total: b.total ?? 0, file: b.fileName ?? '—' })
          : tr(t.messages.cycleBuildError, { err: b.error ?? '—' }),
      })
      await refresh()
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  // Экран входа загружается (короткая вспышка при первом открытии)
  if (!me) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        <RefreshCw className="h-5 w-5 mr-2 animate-spin" /> {t.auth.splash}
      </div>
    )
  }

  // Enterprise: не верифицирован / не вошёл — экран входа и ожидания верификации
  if (me.multiUser && (!me.authenticated || me.user?.status === 'pending')) {
    return <AuthScreen me={me} onAuthed={() => void refreshMe()} />
  }

  // Роль: в Community — полные права без аутентификации (как раньше)
  const role: Role = me.multiUser && me.user ? me.user.role : 'admin'
  const isAdmin = role === 'admin'
  const showUsersTab = me.multiUser && role === 'admin'

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border bg-card/95 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="NDR Rules Hub logo" className="h-9 w-9 rounded-lg border border-primary/30" />
            <div>
              <h1 className="text-lg font-bold leading-tight">NDR Rules Hub</h1>
              <p className="text-xs text-muted-foreground leading-tight">{t.header.subtitle}</p>
            </div>
            <Badge variant="outline" className="border-input text-muted-foreground hidden sm:inline-flex">{tr(t.header.editionBadge, { ed: editionLabel() })}</Badge>
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {data && isAdmin && (
              <>
                <Badge variant="outline" className="border-input text-foreground">
                  <Database className="h-3 w-3 mr-1" />
                  {tr(t.header.rulesInDb, { n: data.rules.inDb.toLocaleString(loc) })}
                </Badge>
                <Badge variant="outline" className={data.vpn.available && data.vpn.interfaces.length > 0 ? 'border-emerald-400 text-emerald-700' : 'border-input text-muted-foreground'}>
                  <Wifi className="h-3 w-3 mr-1" />
                  VPN: {data.vpn.available ? (data.vpn.interfaces.length ? tr(t.header.vpnIfaces, { n: data.vpn.interfaces.length }) : t.header.vpnNoTunnels) : t.header.vpnUnavailable}
                </Badge>
                <Badge variant="outline" className={data.sources.error > 0 ? 'border-amber-400 text-amber-700' : 'border-input text-muted-foreground'}>
                  <Activity className="h-3 w-3 mr-1" />
                  {tr(t.header.sourcesOk, { ok: data.sources.ok, enabled: data.sources.enabled })}
                </Badge>
              </>
            )}
            {data && !isAdmin && (
              <Badge variant="outline" className="border-input text-foreground">
                <Database className="h-3 w-3 mr-1" />
                {tr(t.header.rulesInDb, { n: data.rules.inDb.toLocaleString(loc) })}
              </Badge>
            )}
            <Button onClick={runCycle} disabled={busy !== null} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busy === 'cycle' ? 'animate-spin' : ''}`} />
              {t.header.fullCycle}
            </Button>
            <LangSwitch />
            {me.multiUser && me.user && <UserMenu me={me} onLogout={() => void refreshMe()} />}
          </div>
        </div>
        {message && (
          <div className={`px-4 py-1.5 text-sm ${message.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'} border-t border-border`}>
            {message.text}
          </div>
        )}
        {error && (
          <div className="px-4 py-1.5 text-sm bg-red-50 text-red-700 border-t border-border">
            {tr(t.header.apiError, { err: error })}
          </div>
        )}
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="bg-card border border-border flex-wrap h-auto gap-1 p-1">
            <TabsTrigger value="overview" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.overview}</TabsTrigger>
            <TabsTrigger value="sources" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.sources}</TabsTrigger>
            <TabsTrigger value="categories" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.categories}</TabsTrigger>
            <TabsTrigger value="rules" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.rules}</TabsTrigger>
            <TabsTrigger value="build" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.build}</TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="vpn" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.vpn}</TabsTrigger>
            )}
            <TabsTrigger value="update" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.update}</TabsTrigger>
            <TabsTrigger value="osd" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.osd}</TabsTrigger>
            {isAdmin && (
              <>
                <TabsTrigger value="settings" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.settings}</TabsTrigger>
                <TabsTrigger value="logs" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.logs}</TabsTrigger>
              </>
            )}
            {showUsersTab && (
              <TabsTrigger value="users" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.users}</TabsTrigger>
            )}
            <TabsTrigger value="help" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.help}</TabsTrigger>
            <TabsTrigger value="about" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.tabs.about}</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <Overview data={data} onRefresh={refresh} role={role} />
          </TabsContent>
          <TabsContent value="sources" className="mt-4">
            <SourcesTab data={data} onChange={refresh} role={role} selfId={me.user?.id} />
          </TabsContent>
          <TabsContent value="categories" className="mt-4">
            <CategoriesTab data={data} onChange={refresh} />
          </TabsContent>
          <TabsContent value="rules" className="mt-4">
            <RulesTab data={data} />
          </TabsContent>
          <TabsContent value="build" className="mt-4">
            <BuildTab data={data} onChange={refresh} role={role} />
          </TabsContent>
          {isAdmin && (
            <TabsContent value="vpn" className="mt-4">
              <VpnTab data={data} onChange={refresh} />
            </TabsContent>
          )}
          <TabsContent value="update" className="mt-4">
            <UpdateTab data={data} onChange={refresh} />
          </TabsContent>
          <TabsContent value="osd" className="mt-4">
            <OsdTab data={data} onChange={refresh} />
          </TabsContent>
          {isAdmin && (
            <>
              <TabsContent value="settings" className="mt-4">
                <SettingsTab data={data} onChange={refresh} />
              </TabsContent>
              <TabsContent value="logs" className="mt-4">
                <LogsTab />
              </TabsContent>
            </>
          )}
          {showUsersTab && (
            <TabsContent value="users" className="mt-4">
              <UsersTab selfId={me.user?.id ?? ''} />
            </TabsContent>
          )}
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
          <span>{t.footer.tagline}</span>
          <span>
            {t.footer.developer}{' '}
            <a href="https://kozhevatov.ru" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{t.footer.authorName}</a>
            {' '}·{' '}
            <a href="https://github.com/NoIDXMV6/ndr-rules-hub" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{t.footer.repoLink}</a>
          </span>
          <span className="ml-auto">{t.footer.export}</span>
        </div>
      </footer>
    </div>
  )
}

/** Меню пользователя в шапке: имя, роль, выход */
function UserMenu({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t } = useI18n()
  const u = me.user
  if (!u) return null
  return (
    <div className="flex items-center gap-2 rounded-md border border-input px-2 py-1">
      <div className="text-right leading-tight">
        <p className="text-xs font-medium text-foreground">{u.displayName}</p>
        <p className="text-[10px] text-muted-foreground">{u.email}</p>
      </div>
      <Badge variant="outline" className={u.role === 'admin' ? 'border-primary text-primary' : 'border-input text-muted-foreground'}>
        {u.role === 'admin' ? t.users.roleAdmin : t.users.roleUser}
      </Badge>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-muted-foreground hover:text-foreground"
        title={t.header.logout}
        onClick={async () => {
          await api.logout().catch(() => undefined)
          onLogout()
        }}
      >
        <LogOut className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

/** Переключатель языка интерфейса (RU/EN) */
function LangSwitch() {
  const { lang, setLang, t } = useI18n()
  const options: Lang[] = ['ru', 'en']
  return (
    <div className="flex items-center rounded-md border border-input overflow-hidden h-9" role="group" aria-label={t.header.langAria}>
      {options.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          title={l === 'ru' ? 'Русский' : 'English'}
          className={`px-2.5 h-full text-xs font-semibold uppercase tracking-wide transition-colors ${
            lang === l
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
          }`}
        >
          {l}
        </button>
      ))}
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

function Overview({ data, onRefresh, role }: { data: Dashboard | null; onRefresh: () => void; role: Role }) {
  const { t, tr, lang, loc } = useI18n()
  if (!data) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <RefreshCw className="h-5 w-5 mr-2 animate-spin" /> {t.overview.loading}
      </div>
    )
  }
  const b = data.lastBuild
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title={t.overview.statSources} value={`${data.sources.enabled}/${data.sources.total}`} sub={tr(t.overview.statSourcesSub, { n: data.sources.error })} icon={<Globe className="h-3.5 w-3.5" />} />
        <StatCard title={t.overview.statRulesDb} value={data.rules.inDb.toLocaleString(loc)} sub={t.overview.statRulesDbSub} icon={<Database className="h-3.5 w-3.5" />} />
        <StatCard title={t.overview.statRulesBuild} value={b ? b.totalRules.toLocaleString(loc) : '—'} sub={b ? `${b.fileName} · ${fmtSize(b.sizeBytes, lang)}` : t.overview.statRulesBuildSubNo} icon={<Layers className="h-3.5 w-3.5" />} />
        <StatCard title={t.overview.statDups} value={b ? (b.stats.duplicateBySid + b.stats.duplicateByContent).toLocaleString(loc) : '—'} sub={b ? tr(t.overview.statDupsSub, { sid: b.stats.duplicateBySid.toLocaleString(loc), content: b.stats.duplicateByContent.toLocaleString(loc) }) : ''} icon={<Activity className="h-3.5 w-3.5" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base">{t.overview.lastBuild}</CardTitle>
            <CardDescription>{t.overview.lastBuildDesc}</CardDescription>
          </CardHeader>
          <CardContent>
            {b ? (
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <span className="text-muted-foreground">{t.overview.file} <code className="text-emerald-700">{b.fileName}</code></span>
                  <span className="text-muted-foreground">{t.overview.size} {fmtSize(b.sizeBytes, lang)}</span>
                  <span className="text-muted-foreground">{t.overview.created} {fmtTime(b.createdAt, lang)}</span>
                </div>
                <div className="text-xs text-muted-foreground break-all">SHA-256: <code>{b.sha256}</code></div>
                <div className="flex gap-2 pt-1">
                  <a href="/api/export" download>
                    <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground">
                      <Download className="h-4 w-4 mr-1.5" /> {t.overview.downloadFinal}
                    </Button>
                  </a>
                  <Button size="sm" variant="outline" className="border-input text-foreground" onClick={onRefresh}>
                    <RefreshCw className="h-4 w-4 mr-1.5" /> {t.overview.refresh}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t.overview.noBuild}</p>
            )}
          </CardContent>
        </Card>

        {/* VPN-карточка — только администратору */}
        {role === 'admin' && (
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">{t.overview.vpn}</CardTitle>
              <CardDescription>{t.overview.vpnDesc}</CardDescription>
            </CardHeader>
            <CardContent>
              {data.vpn.available ? (
                data.vpn.interfaces.length > 0 ? (
                  <div className="space-y-2">
                    {data.vpn.interfaces.map((i) => (
                      <div key={i.name} className="text-sm flex flex-wrap gap-x-4">
                        <span className="font-mono text-emerald-700">{i.name}</span>
                        <span className="text-muted-foreground">{tr(t.overview.port, { n: i.listeningPort ?? '—' })}</span>
                        <span className="text-muted-foreground">{tr(t.overview.peers, { n: i.peers.length })}</span>
                        {i.peers.some((p) => p.online) && <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-300">{t.overview.handshakeActive}</Badge>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t.overview.wgOkNoTunnels}</p>
                )
              ) : (
                <p className="text-sm text-muted-foreground">{tr(t.overview.vpnStatusUnavailable, { err: data.vpn.error ?? 'wg' })}</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">{t.overview.recentEvents}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {data.logs.length === 0 && <p className="text-sm text-muted-foreground">{t.overview.noEvents}</p>}
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
                <span className="text-muted-foreground shrink-0 tabular-nums text-xs mt-0.5">{fmtTime(l.ts, lang)}</span>
                <span className="text-foreground">{l.message}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
