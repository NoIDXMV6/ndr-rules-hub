'use client'

// ─────────────────────────────────────────────────────────────────────────────
// «Токены и доступ» — карточка персональных токенов скачивания (Enterprise),
// v1.31.0: переехала из «Сборка и экспорт» в раздел «Аккаунт» → «Токены и
// доступ»: выдача токенов — операция учётной записи (scope правила/домены),
// а не настройка сборки; карточка сборки становится компактнее.
// Создание (полный токен показывается один раз, готовые Uri — БЕЗ токена:
// токен вставляется в поле authkey источника Clear NDR), отзыв, возврат,
// удаление, статистика скачиваний. У пользователя — только свои, у админа — все.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, DownloadTokenItem, fmtSize, fmtTime } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { copyToClipboard } from '@/lib/utils'
import { Ban, Check, Copy, KeyRound, Plus, RotateCcw, Trash2 } from 'lucide-react'

export function TokensCard({ role }: { role: 'admin' | 'user' }) {
  const { t, tr, loc, lang } = useI18n()
  const [tokens, setTokens] = useState<DownloadTokenItem[]>([])
  const [name, setName] = useState('')
  const [ttlDays, setTtlDays] = useState('0')
  // scope: правила (историческое поведение) | домены (DNS-фильтрация) | оба списка
  const [scope, setScope] = useState('rules')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [createdScope, setCreatedScope] = useState<string>('rules') // scope созданного токена
  const [msg, setMsg] = useState<string | null>(null)
  // адрес, с которого открыт хаб — для готовых URL подключения в карточке токенов
  const [origin, setOrigin] = useState('')

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const r = await api.tokens()
      setTokens(r.tokens)
    } catch {
      setTokens([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.createToken({ name: name.trim() || 'Токен', ttlDays: parseInt(ttlDays, 10) || 0, scope })
      if (r.ok && r.token) {
        setCreated(r.token.token)
        setCreatedScope(r.token.scope ?? 'rules')
        setName('')
        setTtlDays('0')
        setScope('rules')
        await refresh()
      } else {
        setMsg(r.error ?? 'error')
      }
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (tk: DownloadTokenItem) => {
    if (!window.confirm(tr(t.tokens.revokeConfirm, { name: tk.name }))) return
    setBusy(true)
    try {
      await api.revokeToken(tk.id)
      await refresh()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (tk: DownloadTokenItem) => {
    setBusy(true)
    try {
      await api.restoreToken(tk.id)
      await refresh()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (tk: DownloadTokenItem) => {
    if (!window.confirm(tr(t.tokens.deleteConfirm, { name: tk.name }))) return
    setBusy(true)
    try {
      await api.deleteToken(tk.id)
      await refresh()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" /> {t.tokens.title}
        </CardTitle>
        <CardDescription>{role === 'admin' ? t.tokens.descAdmin : t.tokens.descUser}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {created && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 space-y-2">
            <p className="text-xs text-emerald-800 font-medium">{t.tokens.created}</p>
            <div className="flex gap-2 items-center">
              <code className="flex-1 min-w-0 truncate rounded border border-emerald-300 bg-white px-2 py-1 text-xs font-mono text-emerald-900" title={created}>{created}</code>
              <CopyBtn text={created} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
            </div>
            {/* Адреса для Clear NDR — БЕЗ токена: токен (выше) вставляется в поле
                «Optional authorization key» источника. Так пользователь видит ровно
                то, что нужно вставить в каждое поле формы Clear NDR, без путаницы. */}
            <p className="text-xs text-emerald-800 font-medium pt-1">{t.tokens.createdUrlsTitle}</p>
            {(createdScope === 'rules' || createdScope === 'both') && (
              <>
                <ServeRow label={t.tokens.createdUrlFile} url={`${origin}/api/export`} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
                <ServeRow label={t.tokens.createdUrlArchive} url={`${origin}/api/export?archive=1`} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
              </>
            )}
            {(createdScope === 'domains' || createdScope === 'both') && (
              <ServeRow label={t.tokens.createdUrlDomains} url={`${origin}/api/dns/export`} copyLabel={t.build.serveCopy} copiedLabel={t.build.serveCopied} />
            )}
            <p className="text-[11px] text-emerald-900/80">{t.tokens.authkeyHint}</p>
            <p className="text-[11px] text-emerald-900/80">{t.tokens.urlOriginNote}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-end">
          <div className="min-w-44 flex-1">
            <Label className="text-foreground">{t.tokens.nameLabel}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="bg-card border-input mt-1" placeholder="Clear NDR node 1" />
          </div>
          <div className="w-44">
            <Label className="text-foreground">{t.tokens.ttlLabel}</Label>
            <Input type="number" min={0} max={365} value={ttlDays} onChange={(e) => setTtlDays(e.target.value)} className="bg-card border-input mt-1" />
          </div>
          <div className="w-56">
            <Label className="text-foreground">{t.tokens.scopeLabel}</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="bg-card border-input mt-1"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="rules">{t.tokens.scopeRules}</SelectItem>
                <SelectItem value="domains">{t.tokens.scopeDomains}</SelectItem>
                <SelectItem value="both">{t.tokens.scopeBoth}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={create} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus className="h-4 w-4 mr-1.5" /> {t.tokens.createBtn}
          </Button>
        </div>
        {msg && <p className="text-sm text-red-600">{msg}</p>}

        {/* Подробная инструкция подключения Clear NDR по токену (PULL) —
            включая включение периодических обновлений в самом Clear NDR */}
        <details className="rounded-lg border border-border">
          <summary className="px-3 py-2 text-sm font-medium text-foreground cursor-pointer select-none">{t.tokens.howTitle}</summary>
          <ol className="list-decimal ml-5 px-3 pb-3 space-y-1.5 text-sm text-muted-foreground">
            <li>{t.tokens.howStep1}</li>
            <li>{t.tokens.howStep2}</li>
            <li>{t.tokens.howStep3}</li>
            <li>{t.tokens.howStep4}</li>
            <li>{t.tokens.howStep5}</li>
            <li>{t.tokens.howStep6}</li>
            <li>{t.tokens.howStep7}</li>
          </ol>
        </details>

        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.tokens.empty}</p>
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr className="text-muted-foreground text-left">
                  <th className="px-3 py-2 font-medium">{t.tokens.thName}</th>
                  <th className="px-3 py-2 font-medium">{t.tokens.thPrefix}</th>
                  <th className="px-3 py-2 font-medium">{t.tokens.thScope}</th>
                  {role === 'admin' && <th className="px-3 py-2 font-medium">{t.tokens.thOwner}</th>}
                  <th className="px-3 py-2 font-medium">{t.tokens.thLastUsed}</th>
                  <th className="px-3 py-2 font-medium">{t.tokens.thDownloads}</th>
                  <th className="px-3 py-2 font-medium">{t.tokens.thExpires}</th>
                  <th className="px-3 py-2 font-medium text-right">{t.tokens.thActions}</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((tk) => {
                  const expired = tk.expiresAt ? new Date(tk.expiresAt).getTime() < Date.now() : false
                  const canManage = role === 'admin' || tk.own
                  return (
                    <tr key={tk.id} className="border-t border-border/60 text-foreground">
                      <td className="px-3 py-1.5">{tk.name}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {tk.prefix}…
                        {tk.revokedAt && <Badge variant="outline" className="ml-1.5 border-red-300 text-red-600">{t.tokens.revokedBadge}</Badge>}
                        {!tk.revokedAt && expired && <Badge variant="outline" className="ml-1.5 border-amber-400 text-amber-700">{t.tokens.expiredBadge}</Badge>}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge variant="outline" className={tk.scope === 'both' ? 'border-emerald-400 text-emerald-700' : tk.scope === 'domains' ? 'border-input text-foreground' : 'border-input text-muted-foreground'}>
                          {tk.scope === 'domains' ? t.tokens.scopeDomains : tk.scope === 'both' ? t.tokens.scopeBoth : t.tokens.scopeRules}
                        </Badge>
                      </td>
                      {role === 'admin' && <td className="px-3 py-1.5 text-muted-foreground">{tk.owner}</td>}
                      <td className="px-3 py-1.5 text-muted-foreground">{tk.lastUsedAt ? fmtTime(tk.lastUsedAt, lang) : t.tokens.neverUsed}</td>
                      <td className="px-3 py-1.5 tabular-nums">{tk.downloadCount.toLocaleString(loc)}{tk.bytesServed > 0 ? ` · ${fmtSize(tk.bytesServed, lang)}` : ''}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{tk.expiresAt ? fmtTime(tk.expiresAt, lang) : t.tokens.noExpiry}</td>
                      <td className="px-3 py-1.5">
                        {canManage && (
                          <div className="flex justify-end gap-1.5">
                            {!tk.revokedAt && !expired && (
                              <Button size="sm" variant="outline" className="border-amber-300 text-amber-700" disabled={busy} onClick={() => revoke(tk)} title={t.tokens.revoke}>
                                <Ban className="h-4 w-4" />
                              </Button>
                            )}
                            {tk.revokedAt && !expired && (
                              <Button size="sm" variant="outline" className="border-emerald-300 text-emerald-700" disabled={busy} onClick={() => restore(tk)} title={t.tokens.restore}>
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="border-red-300 text-red-600" disabled={busy} onClick={() => remove(tk)} title={t.tokens.deleteBtn}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {/* Полный токен в БД не хранится (SHA-256) — показывается один раз при создании;
            для существующих токенов виден только префикс. Адрес источника в Clear NDR
            от токена не зависит: Uri постоянный, ключ меняется в поле authkey. */}
        {tokens.length > 0 && <p className="text-xs text-muted-foreground mt-1">{t.tokens.prefixUrlNote}</p>}
      </CardContent>
    </Card>
  )
}

function CopyBtn({ text, copyLabel, copiedLabel }: { text: string; copyLabel: string; copiedLabel: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <div className="shrink-0">
      <Button
        size="sm"
        variant="outline"
        className="border-input text-foreground"
        onClick={async () => {
          setFailed(false)
          const ok = await copyToClipboard(text)
          if (ok) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          } else {
            setFailed(true)
            setTimeout(() => setFailed(false), 4000)
          }
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />} {copied ? copiedLabel : copyLabel}
      </Button>
      {failed && <p className="text-[11px] text-red-600 mt-1">{t.build.copyErr}</p>}
    </div>
  )
}

function ServeRow({ label, url, copyLabel, copiedLabel }: { label: string; url: string; copyLabel: string; copiedLabel: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copy = async () => {
    if (!url) return
    setFailed(false)
    const ok = await copyToClipboard(url)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      setFailed(true)
      setTimeout(() => setFailed(false), 4000)
    }
  }
  return (
    <div>
      <Label className="text-foreground">{label}</Label>
      <div className="mt-1 flex gap-2 items-center">
        <code className="flex-1 min-w-0 truncate rounded-md border border-border bg-muted px-2 py-1.5 text-xs font-mono text-foreground" title={url}>{url || '…'}</code>
        <Button size="sm" variant="outline" className="border-input text-foreground shrink-0" onClick={copy} disabled={!url}>
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />} {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
      {failed && <p className="text-[11px] text-red-600 mt-1">{t.build.copyErr}</p>}
    </div>
  )
}
