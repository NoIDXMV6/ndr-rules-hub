'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «Аккаунт» (Enterprise, все пользователи): сведения об учётной записи
// и управление двухфакторной аутентификацией:
//   - метод Telegram: username + привязка чата (/start боту) + код;
//   - метод TOTP: QR/ключ + код из приложения;
//   - выключение 2FA — с подтверждением паролем.
// Смена метода требует подтверждения кодом НОВОГО метода — нельзя заблокировать
// сам себя неправильной настройкой. При потере доступа — сброс 2FA администратором.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { api, type AccountInfo } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { ExternalLink, KeyRound, MessageSquare, RefreshCw, Send, ShieldCheck, Timer, Unplug } from 'lucide-react'

export function AccountTab() {
  const { t, tr } = useI18n()
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // форма Telegram
  const [tgUsername, setTgUsername] = useState('')
  // коды подтверждения — РАЗДЕЛЬНЫЕ по методам: раньше один общий state привязывался
  // к обоим инпутам, и ввод кода «зеркалился» в соседнее поле (Telegram/TOTP)
  const [tgCode, setTgCode] = useState('')
  const [totpCode, setTotpCode] = useState('')
  // TOTP
  const [totpSetup, setTotpSetup] = useState<{ otpauth: string; qrDataUrl: string | null; manualKey: string } | null>(null)
  // выключение 2FA
  const [disablePassword, setDisablePassword] = useState('')

  const load = useCallback(async () => {
    try {
      const a = await api.account()
      setInfo(a)
      setTgUsername(a.telegramUsername ?? '')
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (body: Record<string, unknown>) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.accountAction(body)
      setMsg({ ok: !!r.ok, text: (r.message as string) ?? (r.error as string) ?? t.account.done })
      await load()
      return r
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
      return null
    } finally {
      setBusy(false)
    }
  }

  if (!info) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-8 flex items-center justify-center text-muted-foreground text-sm">
          <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> {t.account.loading}
        </CardContent>
      </Card>
    )
  }

  const m = info.twoFactor

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Сведения об учётной записи */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> {t.account.profileTitle}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          <Row label={t.auth.displayName} value={info.displayName} />
          <Row label={t.auth.email} value={info.email} mono />
          <Row label={t.account.role} value={info.role === 'admin' ? t.users.roleAdmin : t.users.roleUser} />
          <Row label={t.account.status} value={info.status} />
        </CardContent>
      </Card>

      {/* Текущее состояние 2FA */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" /> {t.account.title}
          </CardTitle>
          <CardDescription>{t.account.desc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={m === 'none' ? 'border-amber-300 text-amber-700' : 'border-emerald-300 text-emerald-700'}>
              {m === 'none' ? t.account.stateNone : m === 'telegram' ? t.account.stateTelegram : t.account.stateTotp}
            </Badge>
            {m === 'telegram' && (
              <>
                <span className="text-xs text-muted-foreground">@{info.telegramUsername ?? '—'}</span>
                <Badge variant="outline" className={info.telegramBound ? 'border-emerald-300 text-emerald-700' : 'border-amber-300 text-amber-700'}>
                  {info.telegramBound ? t.account.chatBound : t.account.chatNotBound}
                </Badge>
              </>
            )}
          </div>

          {msg && <p className={`text-sm whitespace-pre-wrap ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}

          {/* ── Telegram ── */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">{t.account.tgTitle}</p>
              {m === 'telegram' && <Badge variant="outline" className="border-emerald-300 text-emerald-700 px-1 py-0 text-[10px]">{t.account.active}</Badge>}
            </div>
            <p className="text-xs text-muted-foreground whitespace-pre-line">{t.account.tgDesc}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-56">
                <Label className="text-foreground">{t.auth.telegramUsernameLabel}</Label>
                <Input
                  value={tgUsername}
                  onChange={(e) => setTgUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                  className="bg-card border-input font-mono mt-1"
                  placeholder="@username"
                  maxLength={32}
                />
              </div>
              <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy || !tgUsername} onClick={() => void act({ action: 'save-telegram', username: tgUsername })}>
                {t.account.tgSave}
              </Button>
              <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy || !info.telegramUsername} onClick={() => void act({ action: 'send-telegram-code' })}>
                <Send className="h-3.5 w-3.5 mr-1.5" /> {t.account.tgSendCode}
              </Button>
              {info.telegramBound && (
                <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={() => void act({ action: 'send-test' })}>
                  {t.account.tgTest}
                </Button>
              )}
              {info.botLink && (
                <a href={info.botLink} target="_blank" rel="noreferrer" className="text-sm text-primary underline underline-offset-2 inline-flex items-center gap-0.5">
                  {t.account.openBot} <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {info.telegramUsername && !info.telegramBound && (
              <p className="text-xs text-amber-700">⚠ {t.account.tgNotBound}</p>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-40">
                <Label className="text-foreground">{t.account.codeLabel}</Label>
                <Input
                  value={tgCode}
                  onChange={(e) => setTgCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="bg-card border-input font-mono tracking-widest mt-1 text-center"
                  maxLength={6}
                  placeholder="••••••"
                  aria-label={t.account.tgCodeAria}
                />
              </div>
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" disabled={busy || tgCode.length !== 6} onClick={() => void act({ action: 'switch-telegram', code: tgCode }).then(() => setTgCode(''))}>
                {t.account.tgEnable}
              </Button>
            </div>
          </div>

          {/* ── TOTP ── */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">{t.account.totpTitle}</p>
              {m === 'totp' && <Badge variant="outline" className="border-emerald-300 text-emerald-700 px-1 py-0 text-[10px]">{t.account.active}</Badge>}
            </div>
            <p className="text-xs text-muted-foreground whitespace-pre-line">{t.account.totpDesc}</p>
            <div className="flex flex-wrap items-end gap-3">
              {/* «Показать QR» — картинка ТЕКУЩЕГО секрета без перевыпуска: повторный показ
                  не инвалидирует уже отсканированный QR (потеря картинки при смене вкладки/
                  перезагрузке больше не ломает привязку) */}
              <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={async () => {
                const r = await act({ action: 'show-totp-qr' })
                if (r?.ok) setTotpSetup({ otpauth: r.otpauth as string, qrDataUrl: (r.qrDataUrl as string) ?? null, manualKey: r.manualKey as string })
                setTotpCode('')
              }}>
                {t.account.totpShowQr}
              </Button>
              {/* «Пересоздать» — явный перевыпуск секрета: старый QR/ключ перестают действовать,
                  после него обязателен повторный скан */}
              {info.twoFactor !== 'totp' && (
                <Button size="sm" variant="outline" className="border-input text-muted-foreground" disabled={busy} onClick={async () => {
                  const r = await act({ action: 'setup-totp' })
                  if (r?.ok) setTotpSetup({ otpauth: r.otpauth as string, qrDataUrl: (r.qrDataUrl as string) ?? null, manualKey: r.manualKey as string })
                  setTotpCode('')
                }}>
                  {t.account.totpSetup}
                </Button>
              )}
            </div>
            {totpSetup && (
              <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
                {totpSetup.qrDataUrl
                  ? <img src={totpSetup.qrDataUrl} alt="TOTP QR" className="mx-auto rounded border border-border bg-white p-1 w-[220px]" />
                  : <p className="text-xs text-amber-700">⚠ {t.account.totpQrFailed}</p>}
                <p className="text-xs text-muted-foreground break-all">
                  {t.auth.totpManualKey}: <code className="text-foreground font-mono">{totpSetup.manualKey}</code>
                </p>
                <p className="text-xs text-muted-foreground">{t.account.totpScanHint}</p>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-40">
                <Label className="text-foreground">{t.account.codeLabel}</Label>
                <Input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="bg-card border-input font-mono tracking-widest mt-1 text-center"
                  maxLength={6}
                  placeholder="••••••"
                  aria-label={t.account.totpCodeAria}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </div>
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" disabled={busy || totpCode.length !== 6} onClick={() => void act({ action: 'switch-totp', code: totpCode }).then(() => setTotpCode(''))}>
                {t.account.totpEnable}
              </Button>
            </div>
          </div>

          {/* ── Выключение ── */}
          <div className="space-y-3 rounded-lg border border-red-300/50 p-3">
            <div className="flex items-center gap-2">
              <Unplug className="h-4 w-4 text-red-500" />
              <p className="text-sm font-medium text-foreground">{t.account.disableTitle}</p>
            </div>
            <p className="text-xs text-muted-foreground">{t.account.disableDesc}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-64">
                <Label className="text-foreground">{t.auth.password}</Label>
                <Input type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} className="bg-card border-input mt-1" autoComplete="current-password" />
              </div>
              <Button size="sm" variant="outline" className="border-red-300 text-red-600" disabled={busy || !disablePassword} onClick={() => void act({ action: 'disable-2fa', password: disablePassword }).then(() => setDisablePassword(''))}>
                {t.account.disableBtn}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className={mono ? 'font-mono text-foreground break-all' : 'text-foreground'}>{value}</span>
    </div>
  )
}
