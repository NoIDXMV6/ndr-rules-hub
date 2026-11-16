'use client'

// Экран входа/регистрации (только Enterprise). Пока пользователь не верифицирован,
// личный кабинет недоступен — после регистрации показывается экран ожидания,
// который сам перезапрашивает статус (верификация подхватится без перезахода).

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, type Me } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { LogOut, ShieldCheck } from 'lucide-react'

export function AuthScreen({ me, onAuthed }: { me: Me; onAuthed: () => void }) {
  const { t, tr } = useI18n()
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground px-4">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-2.5 justify-center">
          <img src="/logo.svg" alt="NDR Rules Hub logo" className="h-10 w-10 rounded-lg border border-primary/30" />
          <div>
            <h1 className="text-lg font-bold leading-tight">NDR Rules Hub</h1>
            <p className="text-xs text-muted-foreground leading-tight">{t.auth.subtitle}</p>
          </div>
        </div>

        {me.user?.status === 'pending' ? (
          <PendingScreen email={me.user.email} onRefresh={onAuthed} />
        ) : (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t.auth.title}</CardTitle>
              <CardDescription>
                {me.needsBootstrap ? t.auth.bootstrapHint : t.auth.registerNote}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="login">
                <TabsList className="bg-muted/60 border border-border w-full">
                  <TabsTrigger value="login" className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.auth.loginTab}</TabsTrigger>
                  <TabsTrigger value="register" disabled={me.registrationOpen === false} className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">{t.auth.registerTab}{me.registrationOpen === false ? ' 🔒' : ''}</TabsTrigger>
                </TabsList>
                <TabsContent value="login" className="mt-4">
                  <LoginForm onAuthed={onAuthed} />
                </TabsContent>
                <TabsContent value="register" className="mt-4">
                  <RegisterForm onRegistered={onAuthed} />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        <p className="text-center text-xs text-muted-foreground">{t.auth.editionEnterpriseNote}</p>
      </div>
    </div>
  )
}

function LoginForm({ onAuthed }: { onAuthed: () => void }) {
  const { t, tr } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login({ email, password })
      onAuthed()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <Label htmlFor="login-email" className="text-foreground">{t.auth.email}</Label>
        <Input id="login-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value.trim())} className="bg-card border-input mt-1" />
      </div>
      <div>
        <Label htmlFor="login-password" className="text-foreground">{t.auth.password}</Label>
        <Input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="bg-card border-input mt-1" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">
        {busy ? t.auth.loggingIn : t.auth.loginBtn}
      </Button>
    </form>
  )
}

function RegisterForm({ onRegistered }: { onRegistered: () => void }) {
  const { t, tr } = useI18n()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.register({ email, displayName, password })
      setDone(r.message ?? t.auth.registerNote)
      setTimeout(onRegistered, 1200)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
        <span>{done}</span>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <Label htmlFor="reg-email" className="text-foreground">{t.auth.email}</Label>
        <Input id="reg-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value.trim())} className="bg-card border-input mt-1" />
      </div>
      <div>
        <Label htmlFor="reg-name" className="text-foreground">{t.auth.displayName}</Label>
        <Input id="reg-name" required maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="bg-card border-input mt-1" />
      </div>
      <div>
        <Label htmlFor="reg-password" className="text-foreground">{t.auth.password}</Label>
        <Input id="reg-password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="bg-card border-input mt-1" />
        <p className="text-xs text-muted-foreground mt-1">{tr('{n}+ символов, буквы и цифры', { n: '8' })}</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">
        {busy ? t.auth.registering : t.auth.registerBtn}
      </Button>
    </form>
  )
}

/** Экран ожидания верификации: опрашивает /api/auth/me раз в 10 секунд */
function PendingScreen({ email, onRefresh }: { email: string; onRefresh: () => void }) {
  const { t, tr } = useI18n()
  useEffect(() => {
    const id = setInterval(onRefresh, 10_000)
    return () => clearInterval(id)
  }, [onRefresh])
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-amber-600" /> {t.auth.pendingTitle}
        </CardTitle>
        <CardDescription>{tr(t.auth.pendingDesc, { email })}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          className="border-input text-foreground w-full"
          onClick={async () => {
            await api.logout().catch(() => undefined)
            onRefresh()
          }}
        >
          <LogOut className="h-4 w-4 mr-1.5" /> {t.auth.logoutHere}
        </Button>
      </CardContent>
    </Card>
  )
}
