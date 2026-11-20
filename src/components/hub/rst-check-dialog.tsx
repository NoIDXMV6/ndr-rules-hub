'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Диалог «Проверка в RST Cloud» (v1.35.0 — универсальный):
//  • открывается с готовым значением (кнопка «Проверить в RST Cloud» у записи
//    в «DNS списки → Записи») или с пустым полем ввода (карточка «Интеграций»,
//    тулбар «Правил») — проверяется ЛЮБОЙ индикатор: домен, IP, URL, хэш;
//  • RST IoC Lookup — балл/теги/описание индикатора (запускается автоматически
//    для переданного значения, для введённого вручную — по кнопке «Проверить»);
//  • RST Noise Control — считается ли значение доброкачественным (false positives);
//  • RST Whois — регистрационные данные домена.
// Каждая проверка тратит 1 запрос квоты ключа RST Cloud (обычно 1000/день).
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, RstLookupResult } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Globe, SearchCheck, Waves } from 'lucide-react'

type Mode = 'ioc' | 'benign' | 'whois'

export function RstCheckDialog({ domain, onClose }: { domain?: string; onClose: () => void }) {
  const { t, tr } = useI18n()
  const [value, setValue] = useState(domain?.trim() ?? '')
  const [busy, setBusy] = useState<Mode | null>(null)
  const [res, setRes] = useState<Partial<Record<Mode, RstLookupResult>>>({})

  const run = useCallback(async (mode: Mode, v: string) => {
    const value = v.trim()
    if (!value) return
    setBusy(mode)
    try {
      const r = await api.rst.lookup(value, mode)
      setRes((prev) => ({ ...prev, [mode]: r }))
    } catch (e) {
      setRes((prev) => ({ ...prev, [mode]: { ok: false, status: 0, mode, value, error: (e as Error).message } as RstLookupResult }))
    } finally {
      setBusy(null)
    }
  }, [])

  // переданное значение (кнопка у записи) проверяется сразу
  useEffect(() => {
    const v = domain?.trim()
    if (v) void run('ioc', v)
  }, [domain, run])

  const ioc = res.ioc
  const iocScore = ioc?.ok ? Math.round(Number((ioc.data?.score as Record<string, unknown> | undefined)?.total ?? 0) || 0) : null
  const iocTags = ioc?.ok && Array.isArray((ioc.data?.tags as Record<string, unknown> | undefined)?.str)
    ? (ioc.data!.tags as { str: string[] }).str
    : []
  const iocFp = ioc?.ok && (ioc.data?.fp as Record<string, unknown> | undefined)?.alarm === 'true'
  const iocDesc = ioc?.ok && typeof ioc.data?.description === 'string' ? ioc.data!.description as string : ''
  const benign = res.benign
  const whois = res.whois
  const shown = domain?.trim() ? tr(t.dns.rstDialogTitle, { domain: domain!.trim() }) : t.dns.rstDialogTitleAny

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="bg-card border-border max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground text-base flex items-center gap-2">
            <SearchCheck className="h-4 w-4 text-primary" /> {shown}
          </DialogTitle>
          <DialogDescription>{t.dns.rstDialogDesc}</DialogDescription>
        </DialogHeader>

        {/* Ручной ввод: домен/IP/URL/хэш — тип определяется на стороне RST Cloud */}
        {!domain?.trim() && (
          <section className="space-y-1.5">
            <div className="flex gap-2">
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && value.trim() && busy === null) void run('ioc', value) }}
                placeholder={t.dns.rstInputPlaceholder}
                className="bg-card border-input font-mono"
                autoFocus
              />
              <Button
                size="sm"
                className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
                disabled={!value.trim() || busy !== null}
                onClick={() => void run('ioc', value)}
              >
                <SearchCheck className="h-4 w-4 mr-1.5" /> {t.dns.rstRunBtn}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t.dns.rstInputHint}</p>
          </section>
        )}

        {/* IoC Lookup — балл и теги */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-foreground">{t.dns.rstIocTitle}</h4>
            {busy === 'ioc' && <span className="text-xs text-muted-foreground animate-pulse">{t.dns.rstLoading}</span>}
          </div>
          {ioc && (
            ioc.ok ? (
              <div className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {iocScore !== null && (
                    <Badge variant="outline" className={iocScore > 0 ? 'border-red-400 text-red-700' : 'border-emerald-400 text-emerald-700'}>
                      {tr(t.dns.rstIocScore, { n: iocScore })}
                    </Badge>
                  )}
                  {iocTags.map((tag) => (
                    <Badge key={tag} variant="outline" className="border-input text-muted-foreground">{tag}</Badge>
                  ))}
                  {iocFp && <Badge variant="outline" className="border-amber-400 text-amber-700">{t.dns.rstIocFpAlarm}</Badge>}
                  {iocScore === 0 && <Badge variant="outline" className="border-emerald-400 text-emerald-700">{t.dns.rstIocNotFound}</Badge>}
                </div>
                {iocDesc && <p className="text-xs text-muted-foreground whitespace-pre-line break-words">{iocDesc}</p>}
              </div>
            ) : (
              <p className="text-xs text-red-600">{tr(t.dns.rstErr, { err: ioc.error ?? String(ioc.status) })}</p>
            )
          )}
        </section>

        {/* Noise Control (benign) + Whois */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <Waves className="h-3.5 w-3.5 text-muted-foreground" />
              <h4 className="text-sm font-medium text-foreground">{t.dns.rstBenignTitle}</h4>
            </div>
            <Button variant="outline" size="sm" className="border-input text-foreground" disabled={busy !== null || !value.trim()} onClick={() => void run('benign', value)}>
              {busy === 'benign' ? t.dns.rstLoading : t.dns.rstBenignBtn}
            </Button>
            {benign && (
              benign.ok ? <GenericResult data={benign.data ?? {}} fallback={t.dns.rstBenignUnknown} /> : <p className="text-xs text-red-600">{tr(t.dns.rstErr, { err: benign.error ?? String(benign.status) })}</p>
            )}
          </section>
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              <h4 className="text-sm font-medium text-foreground">{t.dns.rstWhoisTitle}</h4>
            </div>
            <Button variant="outline" size="sm" className="border-input text-foreground" disabled={busy !== null || !value.trim()} onClick={() => void run('whois', value)}>
              {busy === 'whois' ? t.dns.rstLoading : t.dns.rstWhoisBtn}
            </Button>
            {whois && (
              whois.ok ? (
                <dl className="rounded-lg border border-border p-3 text-xs space-y-1">
                  {whoisField(whois.data, 'status') && <Row k={t.dns.rstWhoisStatus} v={whoisField(whois.data, 'status') ?? ''} />}
                  {whoisField(whois.data, 'registrar') && <Row k={t.dns.rstWhoisRegistrar} v={whoisField(whois.data, 'registrar') ?? ''} />}
                  {whoisField(whois.data, 'created_on') && <Row k={t.dns.rstWhoisCreated} v={whoisField(whois.data, 'created_on') ?? ''} />}
                  {whoisField(whois.data, 'expires_on') && <Row k={t.dns.rstWhoisExpires} v={whoisField(whois.data, 'expires_on') ?? ''} />}
                  {typeof whois.data?.age === 'number' && <Row k={t.dns.rstWhoisAge} v={String(whois.data!.age)} />}
                </dl>
              ) : (
                <p className="text-xs text-red-600">{tr(t.dns.rstErr, { err: whois.error ?? String(whois.status) })}</p>
              )
            )}
          </section>
        </div>

        <p className="text-[11px] text-muted-foreground">{t.dns.rstQuotaNote}</p>
      </DialogContent>
    </Dialog>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground shrink-0">{k}:</dt>
      <dd className="text-foreground break-words">{v}</dd>
    </div>
  )
}

function whoisField(data: Record<string, unknown> | undefined, key: string): string | null {
  const v = data?.[key]
  if (typeof v !== 'string' || !v || v === 'unknown') return null
  return v
}

/** Общий вывод результата Noise Control: ключевые поля или JSON-фрагмент */
function GenericResult({ data, fallback }: { data: Record<string, unknown>; fallback: string }) {
  const known: Array<[string, unknown]> = Object.entries(data)
    .filter(([k]) => ['value', 'benign', 'is_benign', 'score', 'category', 'verdict', 'message', 'status'].includes(k))
    .slice(0, 6)
  if (known.length === 0) {
    const json = JSON.stringify(data, null, 1)
    return <pre className="rounded-lg border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-28 overflow-auto">{json.length > 600 ? `${json.slice(0, 600)}…` : json || fallback}</pre>
  }
  return (
    <dl className="rounded-lg border border-border p-3 text-xs space-y-1">
      {known.map(([k, v]) => <Row key={k} k={k} v={typeof v === 'object' ? JSON.stringify(v) : String(v)} />)}
    </dl>
  )
}
