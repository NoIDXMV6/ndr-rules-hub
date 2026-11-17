'use client'

// Экран входа/регистрации (только Enterprise).
// Шаги безопасности:
//   1) КАПЧА — одноразовый искажённый SVG с сервера (ответ не покидает сервер,
//      сгорает после каждой попытки, лимит выдачи на IP) — обязательна на
//      входе и регистрации;
//   2) учётные данные;
//   3) ВТОРОЙ ФАКТОР — код в Telegram (бот) или TOTP из приложения-аутентификатора,
//      метод выбирается при регистрации и меняется в кабинете («Аккаунт»);
//   4) сессия выдаётся только после успешного второго фактора.

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, type Captcha, type Me } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { LogOut, RefreshCw, ShieldCheck, ExternalLink } from 'lucide-react'

export function AuthScreen({ me, onAuthed }: { me: Me; onAuthed: () => void }) {
  const { t } = useI18n()
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

// ── Капча ────────────────────────────────────────────────────────────────────

function CaptchaBox({ captcha, onReload, value, onChange, error }: {
  captcha: Captcha | null
  onReload: () => void
  value: string
  onChange: (v: string) => void
  error?: string | null
}) {
  const { t } = useI18n()
  return (
    <div>
      <Label htmlFor="captcha-input" className="text-foreground">{t.auth.captchaLabel}</Label>
      <div className="flex items-center gap-2 mt-1">
        <div
          className="rounded border border-input bg-muted/30 overflow-hidden shrink-0 h-[62px] w-[190px]"
          data-testid="captcha-box"
          dangerouslySetInnerHTML={{ __html: captcha?.svg ?? '' }}
        />
        <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0 border-input text-muted-foreground" onClick={onReload} title={t.auth.captchaReload}>
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Input
          id="captcha-input"
          className="bg-card border-input uppercase tracking-widest font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))}
          maxLength={8}
          autoComplete="off"
          placeholder="•••••"
        />
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        {t.auth.captchaHint}
        {error && <span className="text-red-600"> · {error}</span>}
      </p>
    </div>
  )
}

function useCaptcha() {
  const [captcha, setCaptcha] = useState<Captcha | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      // setState только после await — без синхронных каскадных рендеров в эффекте
      const c = await api.captcha()
      setCaptcha(c)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    // Загрузка капчи при монтировании — setState строго после await;
    // правило react-hooks/set-state-in-effect не отличает async-загрузку
    // от синхронного setState, поэтому точечное подавление.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  return { captcha, error, reload: load, setError }
}

// ── Вход: шаг 1 (капча + пароль) → шаг 2 (код 2FA) ───────────────────────────

function LoginForm({ onAuthed }: { onAuthed: () => void }) {
  const { t, tr } = useI18n()
  const cap = useCaptcha()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // шаг 2: код из Telegram / TOTP
  const [mfa, setMfa] = useState<'telegram' | 'totp' | null>(null)
  const [mfaSent, setMfaSent] = useState(true)
  const [mfaBotLink, setMfaBotLink] = useState<string | null>(null)
  const [code, setCode] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.login({ email, password, captchaId: cap.captcha?.captchaId, captchaAnswer })
      if (r.mfa === 'telegram' || r.mfa === 'totp') {
        setMfa(r.mfa as 'telegram' | 'totp')
        setMfaSent(r.sent !== false)
        setMfaBotLink((r.botLink as string) ?? null)
        setCode('')
        return
      }
      onAuthed()
    } catch (err) {
      setError((err as Error).message)
      // капча могла сгореть/устареть — новая картинка в любом случае
      setCaptchaAnswer('')
      await cap.reload()
    } finally {
      setBusy(false)
    }
  }

  const verify = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.loginVerify(code)
      if (r.ok) onAuthed()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (mfa) {
    return (
      <form onSubmit={verify} className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5 text-sm">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
          <div className="space-y-1">
            <p>
              {mfa === 'telegram'
                ? (mfaSent ? t.auth.mfaTgSent : t.auth.mfaTgNotSent)
                : t.auth.mfaTotpPrompt}
            </p>
            {mfa === 'telegram' && !mfaSent && mfaBotLink && (
              <a href={mfaBotLink} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5">
                {t.auth.openBot} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
        <div>
          <Label htmlFor="mfa-code" className="text-foreground">{t.auth.mfaCodeLabel}</Label>
          <Input
            id="mfa-code"
            inputMode={mfa === 'telegram' ? 'numeric' : undefined}
            autoComplete="one-time-code"
            className="bg-card border-input font-mono tracking-widest mt-1 text-center text-lg"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            maxLength={6}
            placeholder="••••••"
            autoFocus
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={busy || code.length !== 6} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">
          {busy ? t.auth.verifying : t.auth.verifyBtn}
        </Button>
        <Button type="button" variant="outline" className="w-full border-input text-muted-foreground" onClick={() => { setMfa(null); setCode(''); void cap.reload() }}>
          {t.auth.backToCredentials}
        </Button>
      </form>
    )
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
      <CaptchaBox captcha={cap.captcha} onReload={() => void cap.reload()} value={captchaAnswer} onChange={setCaptchaAnswer} error={cap.error} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={busy || !cap.captcha || !captchaAnswer} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">
        {busy ? t.auth.loggingIn : t.auth.loginBtn}
      </Button>
    </form>
  )
}

// ── Регистрация: шаг 1 (форма + капча + выбор 2FA) → шаг 2 (подтверждение) ──

function RegisterForm({ onRegistered }: { onRegistered: () => void }) {
  const { t, tr } = useI18n()
  const cap = useCaptcha()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [method, setMethod] = useState<'telegram' | 'totp'>('telegram')
  const [tgUsername, setTgUsername] = useState('')
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // шаг 2
  const [step2, setStep2] = useState<Record<string, unknown> | null>(null)
  const [code, setCode] = useState('')
  const [info, setInfo] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.register({
        email,
        displayName,
        password,
        twoFactor: method,
        telegramUsername: method === 'telegram' ? tgUsername : undefined,
        captchaId: cap.captcha?.captchaId,
        captchaAnswer,
      })
      setStep2(r)
      setInfo((r.message as string) ?? null)
      setCode('')
      if (method === 'totp') setMethod('totp')
    } catch (err) {
      setError((err as Error).message)
      setCaptchaAnswer('')
      await cap.reload()
    } finally {
      setBusy(false)
    }
  }

  const verify = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.registerVerify(code)
      setInfo((r.message as string) ?? t.auth.registered)
      setTimeout(onRegistered, 1500)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (step2) {
    const botLink = (step2.botLink as string) ?? null
    const otpauth = step2.otpauth as string | undefined
    const qr = step2.qrDataUrl as string | null | undefined
    const manualKey = step2.manualKey as string | undefined
    const tgName = step2.telegramUsername as string | undefined
    const isFirst = step2.isFirst as boolean | undefined
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{info ?? t.auth.registerNote}</span>
        </div>

        {method === 'totp' && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm text-foreground">{t.auth.totpScan}</p>
            {qr && <img src={qr} alt="TOTP QR" className="mx-auto rounded border border-border bg-white p-1" />}
            {manualKey && (
              <p className="text-xs text-muted-foreground break-all">
                {t.auth.totpManualKey}: <code className="text-foreground font-mono">{manualKey}</code>
              </p>
            )}
            {otpauth && <p className="text-[10px] text-muted-foreground/60 break-all">{otpauth}</p>}
          </div>
        )}

        {method === 'telegram' && (
          <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p className="text-foreground">{tr(t.auth.tgWaitCode, { u: tgName ? `@${tgName}` : '' })}</p>
            <ol className="list-decimal ml-4 space-y-1 text-xs text-muted-foreground">
              <li>{t.auth.tgStep1}</li>
              <li>
                {t.auth.tgStep2}
                {botLink && (
                  <>
                    {' '}
                    <a href={botLink} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5">
                      {botLink.replace('https://', '')} <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                )}
              </li>
              <li>{t.auth.tgStep3}</li>
            </ol>
          </div>
        )}

        <form onSubmit={verify} className="space-y-3">
          <div>
            <Label htmlFor="reg-code" className="text-foreground">{t.auth.mfaCodeLabel}</Label>
            <Input
              id="reg-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="bg-card border-input font-mono tracking-widest mt-1 text-center text-lg"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              placeholder="••••••"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={busy || code.length !== 6} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">
            {busy ? t.auth.verifying : t.auth.finishRegistration}
          </Button>
        </form>
        {isFirst && <p className="text-xs text-muted-foreground">{t.auth.bootstrapNote}</p>}
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

      {/* Выбор метода 2FA */}
      <div className="rounded-lg border border-border p-3 space-y-2">
        <p className="text-sm font-medium text-foreground">{t.auth.twoFaTitle}</p>
        <p className="text-xs text-muted-foreground">{t.auth.twoFaDesc}</p>
        <div className="grid grid-cols-2 gap-2">
          <MethodOption
            active={method === 'telegram'}
            title={t.auth.twoFaTelegram}
            sub={t.auth.twoFaTelegramSub}
            onClick={() => setMethod('telegram')}
          />
          <MethodOption
            active={method === 'totp'}
            title={t.auth.twoFaTotp}
            sub={t.auth.twoFaTotpSub}
            onClick={() => setMethod('totp')}
          />
        </div>
        {method === 'telegram' && (
          <div>
            <Label htmlFor="reg-tg" className="text-foreground">{t.auth.telegramUsernameLabel}</Label>
            <Input
              id="reg-tg"
              required
              value={tgUsername}
              onChange={(e) => setTgUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
              className="bg-card border-input font-mono mt-1"
              placeholder="@username"
              maxLength={32}
            />
            <p className="text-xs text-muted-foreground mt-1">{t.auth.telegramUsernameHelp}</p>
          </div>
        )}
      </div>

      <CaptchaBox captcha={cap.captcha} onReload={() => void cap.reload()} value={captchaAnswer} onChange={setCaptchaAnswer} error={cap.error} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={busy || !cap.captcha || !captchaAnswer} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">
        {busy ? t.auth.registering : t.auth.registerBtn}
      </Button>
    </form>
  )
}

function MethodOption({ active, title, sub, onClick }: { active: boolean; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-lg border p-2.5 transition-colors ${active ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/40'}`}
    >
      <p className={`text-sm font-medium ${active ? 'text-primary' : 'text-foreground'}`}>{title}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
    </button>
  )
}

/** Экран ожидания: опрашивает /api/auth/me раз в 10 секунд */
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
