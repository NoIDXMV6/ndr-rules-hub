'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SourcesTab } from '@/components/hub/sources-tab'
import { CategoriesTab } from '@/components/hub/categories-tab'
import { RulesTab } from '@/components/hub/rules-tab'
import { BuildTab } from '@/components/hub/build-tab'
import { VpnTab } from '@/components/hub/vpn-tab'
import { UpdateTab } from '@/components/hub/update-tab'
import { OsdTab } from '@/components/hub/osd-tab'
import { IntegrationsTab } from '@/components/hub/integrations-tab'
import { MispTab } from '@/components/hub/misp-tab'
import { SettingsTab } from '@/components/hub/settings-tab'
import { LogsTab } from '@/components/hub/logs-tab'
import { UsersTab } from '@/components/hub/users-tab'
import { HelpTab } from '@/components/hub/help-tab'
import { AboutTab } from '@/components/hub/about-tab'
import { AuthScreen } from '@/components/hub/auth-screen'
import { AccountTab } from '@/components/hub/account-tab'
import { SystemPanel } from '@/components/hub/system-panel'
import { api, Dashboard, fmtSize, fmtTime, type Me } from '@/components/hub/api'
import { useI18n, type Dictionary, type Lang } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  Activity, Bell, Blocks, ChartColumn, Check, ChevronDown, CircleHelp, Database,
  Download, FolderTree, Globe, Info, Layers, LayoutDashboard, Library,
  LifeBuoy, LogOut, Network, Package, RefreshCw, ScrollText, Settings,
  Share2, Shield, UserRound, Users, Wifi, Wrench,
} from 'lucide-react'

type Role = 'admin' | 'user' | 'anon'

export default function Home() {
  const { t, tr, lang, loc } = useI18n()
  const [data, setData] = useState<Dashboard | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // Активная вкладка управляется меню-баром (прямые кнопки + drop-down группы)
  const [tab, setTab] = useState('overview')
  // Липкость: хидер и меню-бар — ОДИН sticky-блок (CSS), высота адаптируется сама.
  // Раньше top меню считался из JS-измерения высоты шапки (useState(68) + useEffect с
  // пустыми deps + ResizeObserver), но эффект срабатывал на сплэше (шапки ещё нет,
  // headerRef.current === null → ранний выход) и БОЛЬШЕ НЕ ЗАПУСКАЛСЯ: top навсегда
  // оставался 68px. У пользователя с однострочным хидером (64px) это выглядело
  // нормально, а у администратора хидер выше (бейджи переносятся, 113px) — меню
  // уезжало ПОД шапку и выглядело «не прилепленным».

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

  // Смена пользователя/роли (вход, выход, верификация) может закрыть часть вкладок —
  // если активная вкладка стала недоступной, возвращаемся к «Обзору».
  useEffect(() => {
    const admin = !me?.multiUser || me.user?.role === 'admin'
    const allowed = new Set(['overview', 'sources', 'categories', 'rules', 'build', 'update', 'osd', 'help', 'about'])
    if (me?.multiUser) allowed.add('account') // кабинет доступен всем вошедшим
    if (admin) {
      allowed.add('vpn')
      allowed.add('integrations') // «Уведомления и сервисы» в меню «Интеграции»
      allowed.add('misp') // платформа threat intelligence + коннекторы
      allowed.add('settings')
      allowed.add('logs')
      if (me?.multiUser) allowed.add('users')
    }
    if (!allowed.has(tab)) setTab('overview')
  }, [tab, me])

  const runCycle = async () => {
    setBusy('cycle')
    setMessage(null)
    try {
      const f = await api.fetchAll()
      // диф обновления: сколько правил добавлено/изменено/удалено суммарно;
      // изменений нет — переимпорт правил в Suricata не требуется
      const diffTxt = f.failed === 0 && (f.changesTotal ?? 0) === 0
        ? t.messages.fetchAllNoChanges
        : tr(t.messages.fetchAllDiff, { a: f.diff?.added ?? 0, c: f.diff?.changed ?? 0, rm: f.diff?.removed ?? 0, u: f.unchangedSources ?? 0 })
      const fetchTxt = tr(t.messages.cycleFetch, { ok: f.ok, failed: f.failed, diff: diffTxt })
      setMessage({ ok: f.failed === 0, text: fetchTxt })
      // сборка идёт фоном: buildWait опрашивает /api/build/progress до завершения
      const b = await api.buildWait(true)
      const chgTxt = b?.ok && b.changes
        ? (b.unchanged ? t.messages.buildNoChanges : tr(t.messages.buildChanges, { a: b.changes.added, c: b.changes.changed, rm: b.changes.removed }))
        : ''
      setMessage({
        ok: !!b?.ok,
        text: b?.ok
          ? `${fetchTxt}\n${tr(t.messages.cycleBuilt, { total: b.total ?? 0, file: b.fileName ?? '—', changes: chgTxt })}`
          : tr(t.messages.cycleBuildError, { err: b?.error ?? '—' }),
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
    return <AuthScreen me={me} onAuthed={() => { void refreshMe(); void refresh() }} />
  }

  // Роль: в Community — полные права без аутентификации (как раньше)
  const role: Role = me.multiUser && me.user ? me.user.role : 'admin'
  const isAdmin = role === 'admin'
  const showUsersTab = me.multiUser && role === 'admin'

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Хидер и меню-бар прилипают одним блоком: и у админа, и у пользователя,
          при любой высоте шапки (перенос бейджей/кнопок на узких экранах) меню
          остаётся сразу под шапкой — без JS-измерения высоты */}
      <div className="sticky top-0 z-40">
        <header className="border-b border-border bg-card/95 backdrop-blur">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <img src="/logo.svg" alt="NDR Rules Hub logo" className="h-9 w-9 rounded-lg border border-primary/30" />
              <div>
                <h1 className="text-lg font-bold leading-tight">NDR Rules Hub</h1>
                <p className="text-xs text-muted-foreground leading-tight">{t.header.subtitle}</p>
              </div>
              {/* редакция приходит от API (/api/auth/me): клиентский process.env.NDR_EDITION не виден в браузере */}
              <Badge variant="outline" className="border-input text-muted-foreground hidden sm:inline-flex">{tr(t.header.editionBadge, { ed: me.edition === 'enterprise' ? 'Enterprise' : 'Community' })}</Badge>
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
        </header>
        <div className="bg-background pt-1 pb-2">
          <div className="max-w-7xl mx-auto px-4">
            <MenuBar value={tab} onValue={setTab} isAdmin={isAdmin} showUsers={showUsersTab} showAccount={!!me.multiUser} />
          </div>
        </div>
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        {/* баннеры сообщений — вне липкого блока, чтобы высота блока была постоянной */}
        {message && (
          <div className={`my-2 rounded-lg text-sm whitespace-pre-line ${message.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200/60' : 'bg-red-50 text-red-700 border border-red-200/60'} px-3 py-2`}>
            {message.text}
          </div>
        )}
        {error && (
          <div className="my-2 rounded-lg text-sm bg-red-50 text-red-700 border border-red-200/60 px-3 py-2">
            {tr(t.header.apiError, { err: error })}
          </div>
        )}
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsContent value="overview" className="mt-4">
            <Overview data={data} onRefresh={refresh} role={role} onSettings={() => setTab('settings')} />
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
              <TabsContent value="integrations" className="mt-4">
                <IntegrationsTab data={data} onChange={refresh} />
              </TabsContent>
              <TabsContent value="misp" className="mt-4">
                <MispTab data={data} onChange={refresh} />
              </TabsContent>
            </>
          )}
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
          {me.multiUser && (
            <TabsContent value="account" className="mt-4">
              <AccountTab />
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

/** Пункт меню: вкладка + подпись + иконка */
type MenuItemDef = { value: string; label: string; icon: React.ReactNode }

/** Группа меню: прямая кнопка-вкладка или drop-down с несколькими вкладками; grow — относительная ширина пункта (по длине подписи) */
type MenuGroupDef =
  | { kind: 'direct'; key: string; item: MenuItemDef; grow?: number }
  | { kind: 'dropdown'; key: string; label: string; icon: React.ReactNode; items: MenuItemDef[]; grow?: number }

/**
 * Структура главного меню: пункты сгруппированы по типу функционала.
 * Обзор и Сборка/экспорт — прямые кнопки (главный экран и главный рабочий процесс),
 * остальное собрано в drop-down группы; видимость зависит от роли.
 */
function buildMenu(t: Dictionary, isAdmin: boolean, showUsers: boolean, showAccount: boolean): MenuGroupDef[] {
  const ico = (Icon: React.ComponentType<{ className?: string }>) => <Icon className="h-4 w-4 shrink-0 opacity-80" />

  const integrations: MenuItemDef[] = [
    { value: 'update', label: t.tabs.update, icon: ico(Download) },
    { value: 'osd', label: t.tabs.osd, icon: ico(ChartColumn) },
  ]
  if (isAdmin) {
    integrations.push({ value: 'misp', label: t.tabs.misp, icon: ico(Share2) })
    integrations.push({ value: 'vpn', label: t.tabs.vpn, icon: ico(Network) })
  }

  const groups: MenuGroupDef[] = [
    { kind: 'direct', key: 'overview', item: { value: 'overview', label: t.tabs.overview, icon: ico(LayoutDashboard) } },
    {
      kind: 'dropdown',
      key: 'catalog',
      grow: 1.15,
      label: t.menu.catalog,
      icon: ico(Library),
      items: [
        { value: 'sources', label: t.tabs.sources, icon: ico(Globe) },
        { value: 'categories', label: t.tabs.categories, icon: ico(FolderTree) },
        { value: 'rules', label: t.tabs.rules, icon: ico(Shield) },
      ],
    },
    { kind: 'direct', key: 'build', grow: 1.25, item: { value: 'build', label: t.tabs.build, icon: ico(Package) } },
    {
      kind: 'dropdown', key: 'integrations', label: t.menu.integrations, icon: ico(Blocks), items: [
        // настройки уведомлений и сервисов уведомлений (Telegram/Gotify) — перенесены из «Настроек»
        ...(isAdmin ? [{ value: 'integrations', label: t.tabs.notificationsServices, icon: ico(Bell) }] : []),
        ...integrations,
      ],
    },
  ]

  if (isAdmin) {
    const adminItems: MenuItemDef[] = [
      { value: 'settings', label: t.tabs.settings, icon: ico(Settings) },
      { value: 'logs', label: t.tabs.logs, icon: ico(ScrollText) },
    ]
    if (showUsers) adminItems.push({ value: 'users', label: t.tabs.users, icon: ico(Users) })
    groups.push({ kind: 'dropdown', key: 'admin', grow: 1.35, label: t.menu.admin, icon: ico(Wrench), items: adminItems })
  }

  // Личный кабинет (только Enterprise): настройки 2FA своей учётной записи
  if (showAccount) {
    groups.push({ kind: 'direct', key: 'account', item: { value: 'account', label: t.tabs.account, icon: ico(UserRound) } })
  }

  groups.push({
    kind: 'dropdown',
    key: 'help',
    label: t.menu.help,
    icon: ico(LifeBuoy),
    items: [
      { value: 'help', label: t.tabs.help, icon: ico(CircleHelp) },
      { value: 'about', label: t.tabs.about, icon: ico(Info) },
    ],
  })

  return groups
}

/**
 * Меню-бар вместо плоского списка вкладок: пункты распределены по всей ширине
 * строки (flex-1), группы функционала раскрываются drop-down'ом. Группа, в которой
 * лежит активная вкладка, подсвечена; конкретная вкладка отмечена галочкой в меню.
 */
function MenuBar({ value, onValue, isAdmin, showUsers, showAccount }: { value: string; onValue: (v: string) => void; isAdmin: boolean; showUsers: boolean; showAccount: boolean }) {
  const { t } = useI18n()
  const groups = buildMenu(t, isAdmin, showUsers, showAccount)
  const triggerCls =
    'flex-1 basis-[7.5rem] min-w-0 h-9 inline-flex items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
  const activeCls = 'bg-primary text-primary-foreground shadow-sm'
  const idleCls = 'text-muted-foreground hover:text-foreground hover:bg-muted/60'

  return (
    <nav aria-label={t.menu.aria} className="bg-card border border-border rounded-lg p-1 flex flex-wrap gap-1">
      {groups.map((g) =>
        g.kind === 'direct' ? (
          <button
            key={g.key}
            type="button"
            style={{ flexGrow: g.grow ?? 1 }}
            onClick={() => onValue(g.item.value)}
            aria-current={value === g.item.value ? 'true' : undefined}
            className={cn(triggerCls, value === g.item.value ? activeCls : idleCls)}
          >
            {g.item.icon}
            <span className="truncate">{g.item.label}</span>
          </button>
        ) : (
          <DropdownMenu key={g.key}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                style={{ flexGrow: g.grow ?? 1 }}
                className={cn(triggerCls, g.items.some((i) => i.value === value) ? activeCls : idleCls)}
              >
                {g.icon}
                <span className="truncate">{g.label}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-60 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-60">
              {g.items.map((i) => {
                const active = i.value === value
                return (
                  <DropdownMenuItem key={i.value} onSelect={() => onValue(i.value)} className={cn(active && 'bg-accent font-medium')}>
                    {i.icon}
                    <span className="truncate">{i.label}</span>
                    {active && <Check className="ml-auto h-4 w-4 text-primary" />}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      )}
    </nav>
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

function Overview({ data, onRefresh, role, onSettings }: { data: Dashboard | null; onRefresh: () => void; role: Role; onSettings: () => void }) {
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

      {/* ── Системные дашборды: сервер/диски/контейнеры/сеть/туннель/очистка — только администратору (API /api/system — admin) ── */}
      {role === 'admin' && <SystemPanel onSettings={onSettings} />}

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
