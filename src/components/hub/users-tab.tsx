'use client'

// Вкладка «Пользователи» (только администратор, только Enterprise):
// верификация регистраций, отключение/включение, роли, удаление,
// управление регистрацией и журнал событий безопасности.

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, fmtTime, type AuthEventItem, type UserItem } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { CheckCircle2, Lock, RefreshCw, ShieldOff, Trash2, UserCheck } from 'lucide-react'

export function UsersTab({ selfId }: { selfId: string }) {
  const { t, tr, loc } = useI18n()
  const [users, setUsers] = useState<UserItem[]>([])
  const [regOpen, setRegOpen] = useState(true)
  const [events, setEvents] = useState<AuthEventItem[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const [u, e] = await Promise.all([api.users(), api.authEvents(100)])
      setUsers(u.users)
      setRegOpen(u.registrationOpen)
      setEvents(e.events)
      setMsg(null)
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (id: string, action: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(true)
    try {
      await api.userAction(id, action)
      await refresh()
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const del = async (u: UserItem) => {
    if (!window.confirm(tr(t.users.deleteConfirm, { email: u.email }))) return
    setBusy(true)
    try {
      await api.userDelete(u.id)
      await refresh()
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const statusBadge = (u: UserItem) => {
    if (u.status === 'pending') return <Badge variant="outline" className="border-amber-400 text-amber-700">{t.users.statusPending}</Badge>
    if (u.status === 'disabled') return <Badge variant="outline" className="border-red-300 text-red-600">{t.users.statusDisabled}</Badge>
    return <Badge variant="outline" className="border-emerald-300 text-emerald-700">{t.users.statusActive}</Badge>
  }

  const roleBadge = (u: UserItem) =>
    u.role === 'admin'
      ? <Badge className="bg-primary text-primary-foreground">{t.users.roleAdmin}</Badge>
      : <Badge variant="outline" className="border-input text-muted-foreground">{t.users.roleUser}</Badge>

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <CardTitle className="text-base">{t.users.title}</CardTitle>
              <CardDescription>{t.users.desc}</CardDescription>
            </div>
            <Button variant="outline" className="border-input text-foreground" onClick={refresh} disabled={busy}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busy ? 'animate-spin' : ''}`} /> {t.users.refresh}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {msg && <p className="text-sm text-red-600">{msg}</p>}

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <Lock className={`h-4 w-4 ${regOpen ? 'text-emerald-600' : 'text-red-500'}`} />
            <div className="mr-auto">
              <p className="text-sm font-medium text-foreground">{t.users.regOpenTitle}</p>
              <p className="text-xs text-muted-foreground">{regOpen ? t.users.regOpenOn : t.users.regOpenOff}</p>
            </div>
            <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={async () => { await api.registrationOpen(!regOpen); await refresh() }}>
              {regOpen ? t.users.regSwitchOff : t.users.regSwitchOn}
            </Button>
          </div>

          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr className="text-muted-foreground text-left">
                  <th className="px-3 py-2 font-medium">{t.users.thEmail}</th>
                  <th className="px-3 py-2 font-medium">{t.users.thName}</th>
                  <th className="px-3 py-2 font-medium">{t.users.thRole}</th>
                  <th className="px-3 py-2 font-medium">{t.users.thStatus}</th>
                  <th className="px-3 py-2 font-medium">{t.users.thLastLogin}</th>
                  <th className="px-3 py-2 font-medium">{t.users.thSessions} · {t.users.thTokens}</th>
                  <th className="px-3 py-2 font-medium text-right">{t.users.thActions}</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-4 text-muted-foreground">{t.users.empty}</td></tr>
                )}
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-border/60 text-foreground align-top">
                    <td className="px-3 py-2">
                      <span className="font-medium">{u.email}</span>
                      {u.id === selfId && <Badge variant="outline" className="ml-2 border-sky-400 text-sky-700">{t.users.selfBadge}</Badge>}
                      {u.lockedUntil && u.lockedUntil.length && new Date(u.lockedUntil).getTime() > Date.now() && (
                        <p className="text-xs text-amber-700 mt-0.5">{tr(t.users.lockedUntil, { time: fmtTime(u.lockedUntil, loc === 'ru-RU' ? 'ru' : 'en') })}</p>
                      )}
                    </td>
                    <td className="px-3 py-2">{u.displayName}</td>
                    <td className="px-3 py-2">{roleBadge(u)}</td>
                    <td className="px-3 py-2">{statusBadge(u)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{u.lastLoginAt ? fmtTime(u.lastLoginAt, loc === 'ru-RU' ? 'ru' : 'en') : '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{u.activeSessions ?? 0} · {u.tokens ?? 0}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {u.status === 'pending' && (
                          <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" disabled={busy} onClick={() => act(u.id, 'verify')} title={t.users.verify}>
                            <UserCheck className="h-4 w-4 mr-1" /> {t.users.verify}
                          </Button>
                        )}
                        {u.status === 'disabled' && (
                          <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={() => act(u.id, 'enable')}>
                            <CheckCircle2 className="h-4 w-4 mr-1" /> {t.users.enable}
                          </Button>
                        )}
                        {u.status === 'active' && u.id !== selfId && (
                          <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={() => act(u.id, 'disable')} title={t.users.disable}>
                            <ShieldOff className="h-4 w-4 mr-1" /> {t.users.disable}
                          </Button>
                        )}
                        {u.role === 'user' && u.status === 'active' && (
                          <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={() => act(u.id, 'promote')} title={t.users.promote}>
                            ↑ admin
                          </Button>
                        )}
                        {u.role === 'admin' && u.id !== selfId && (
                          <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={() => act(u.id, 'demote')} title={t.users.demote}>
                            ↓ admin
                          </Button>
                        )}
                        {u.id !== selfId && (
                          <Button size="sm" variant="outline" className="border-red-300 text-red-600" disabled={busy} onClick={() => del(u)} title={t.users.delete}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t.users.eventsTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 && <p className="text-sm text-muted-foreground">{t.users.eventsEmpty}</p>}
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {events.map((e) => (
              <div key={e.id} className="flex items-start gap-2 text-sm border-b border-border/50 py-1">
                <Badge
                  variant="outline"
                  className={
                    e.kind.endsWith('_fail') || e.kind === 'ratelimit' || e.kind === 'login_lock' || e.kind === 'download_denied' ? 'border-red-300 text-red-600 shrink-0' :
                    e.kind === 'login_ok' || e.kind === 'register' || e.kind === 'verify' || e.kind === 'download' ? 'border-emerald-300 text-emerald-700 shrink-0' :
                    e.kind === 'login_pending' || e.kind === 'login_disabled' || e.kind === 'disable' ? 'border-amber-300 text-amber-700 shrink-0' :
                    'border-input text-muted-foreground shrink-0'
                  }
                >
                  {e.kind}
                </Badge>
                <span className="text-muted-foreground shrink-0 tabular-nums text-xs mt-0.5">{fmtTime(e.ts, loc === 'ru-RU' ? 'ru' : 'en')}</span>
                <span className="text-foreground min-w-0">
                  {e.email ?? '—'}{e.ip ? ` · ${e.ip}` : ''}{e.detail ? ` — ${e.detail}` : ''}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
