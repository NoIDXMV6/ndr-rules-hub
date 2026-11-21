'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «RST Cloud» (меню «Интеграции», только администратор) — v1.39.0.
// Вынесена из «Уведомлений и сервисов» (разные сущности: RST Cloud —
// threat-intelligence интеграция, уведомления — каналы доставки сообщений).
// Расширена на весь функционал RST Cloud API (api.rstcloud.net/v1):
//   • ключ + проверка (auth/check: валидность, права, квота);
//   • фиды Threat Feed — состояние IP/URL/SHA-256/домены (RstStatus);
//   • IoC Lookup (диалог RstCheckDialog) + фидбек: POST /ioc «предложить
//     индикатор» и PUT /ioc «сообщить false positive»;
//   • Noise Control batch — пакетная проверка списка значений на «шум»
//     (POST /benign/batch/{type} → /benign/result/{type});
//   • Threat Library — объекты угроз (акторы/malware/кампании/ttps);
//   • Scan API — Cobalt Strike beacon / SSL-сертификат / favicon / HTML;
//   • CTI Assistant — AI-чат (GET /models + POST /chat/completions);
//   • Report Hub — отчёты (список, JSON/STIX/PDF).
// Каждый вызов к RST Cloud тратит квоту ключа (обычно 1000 запросов/день).
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, RstApiResult, RstCheckResult, RstStatus } from '@/components/hub/api'
import { RstCheckDialog } from '@/components/hub/rst-check-dialog'
import { useI18n } from '@/lib/i18n'
import { Eye, EyeOff, SearchCheck, Send, Bot, FileText, Radar, Library as LibIcon, ShieldCheck, MessageSquare } from 'lucide-react'

type D = ReturnType<typeof useI18n>['t']

export function RstTab({ data, onChange }: { data: Dashboard0 | null; onChange: () => void }) {
  void onChange
  const { t, tr } = useI18n()
  const [s, setS] = useState<Record<string, string>>({})
  const [showKey, setShowKey] = useState(false)
  const [keyChecking, setKeyChecking] = useState(false)
  const [keyResult, setKeyResult] = useState<RstCheckResult | null>(null)
  const [rstStatus, setRstStatus] = useState<RstStatus | null>(null)
  const [dialogVisible, setDialogVisible] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Клавиши, отредактированные пользователем: опрос /api/dashboard не затирает ввод
  const editedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (data?.settings) {
      setS((prev) => {
        const next = { ...data.settings }
        for (const k of editedRef.current) if (k in prev) next[k] = prev[k]
        return next
      })
    }
  }, [data?.settings])
  const set = (k: string, v: string) => {
    editedRef.current.add(k)
    setS((prev) => ({ ...prev, [k]: v }))
  }

  const loadRstStatus = useCallback(async () => {
    try {
      setRstStatus(await api.rstStatus())
    } catch {
      setRstStatus(null)
    }
  }, [])
  useEffect(() => {
    void loadRstStatus()
  }, [loadRstStatus])

  const checkKey = async () => {
    setKeyChecking(true)
    setKeyResult(null)
    try {
      await api.saveSettings(s) // сохраняем то, что видно в поле
      const r = await api.rst.check('')
      setKeyResult(r)
      await loadRstStatus()
    } catch (e) {
      setKeyResult({ ok: false, error: (e as Error).message })
    } finally {
      setKeyChecking(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.saveSettings(s)
      setMsg(t.messages.settingsSaved)
      await loadRstStatus()
    } catch (e) {
      setMsg(tr(t.messages.fetchErr, { err: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Ключ и статус интеграции ─────────────────────────────────────────── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="text-base flex items-center gap-2 mr-auto">
              <SearchCheck className="h-4 w-4 text-primary" /> {t.settings.rstCardTitle}
            </CardTitle>
            {rstStatus && (
              <span className={`text-xs rounded-full border px-2 py-0.5 ${rstStatus.keySet ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-amber-300 bg-amber-50 text-amber-700'}`}>
                {rstStatus.keySet ? t.settings.rstKeySet : t.settings.rstKeyMissing}
              </span>
            )}
          </div>
          <CardDescription>{t.settings.rstCardDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xl space-y-2">
            <Label className="text-foreground">{t.settings.rstKey}</Label>
            <div className="flex gap-2">
              <Input
                type={showKey ? 'text' : 'password'}
                value={s.rstApiKey ?? ''}
                onChange={(e) => set('rstApiKey', e.target.value.trim())}
                className="bg-card border-input font-mono"
                placeholder={t.settings.rstPlaceholder}
              />
              <Button variant="outline" className="border-input text-foreground shrink-0" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground whitespace-pre-line">{t.settings.rstHelp}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="outline" className="border-input text-foreground" disabled={keyChecking || !(s.rstApiKey ?? '').trim()} onClick={() => void checkKey()}>
                <ShieldCheck className={`h-4 w-4 mr-1.5 ${keyChecking ? 'animate-pulse' : ''}`} /> {keyChecking ? t.settings.rstChecking : t.settings.rstCheckBtn}
              </Button>
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => setDialogVisible(true)}>
                <SearchCheck className="h-4 w-4 mr-1.5" /> {t.settings.rstCardBtn}
              </Button>
              <Button size="sm" variant="outline" className="border-input text-foreground" onClick={save} disabled={busy}>
                {t.settings.save}
              </Button>
            </div>
            {keyResult && (
              <p className={`text-xs ${keyResult.ok && keyResult.valid ? 'text-emerald-700' : 'text-red-600'}`}>
                {keyResult.ok && keyResult.valid
                  ? t.settings.rstKeyValid + (keyResult.quota?.limit
                      ? ` — ${tr(t.settings.rstKeyQuota, { used: keyResult.quota.used ?? 0, limit: keyResult.quota.limit ?? 0, remaining: keyResult.quota.remaining ?? 0 })}`
                      : '')
                  : `${t.settings.rstKeyInvalid}${keyResult.error ? `: ${keyResult.error}` : ''}`}
              </p>
            )}
            {msg && <p className="text-sm text-emerald-700">{msg}</p>}
          </div>
          {/* фиды Threat Feed: видно, где они живут и включены ли */}
          {rstStatus && (rstStatus.ruleSources.length > 0 || rstStatus.dnsSources.length > 0) ? (
            <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
              <p className="text-xs text-muted-foreground">{t.settings.rstFeedsTitle}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                {rstStatus.ruleSources.map((src) => (
                  <FeedRow key={src.id} name={src.name} on={src.enabled} ok={src.status === 'ok'} count={src.ruleCount} kind={t.settings.rstFeedsRules} onLabel={t.settings.rstFeedOn} offLabel={t.settings.rstFeedOff} />
                ))}
                {rstStatus.dnsSources.map((src) => (
                  <FeedRow key={src.id} name={src.name} on={src.enabled} ok={src.status === 'ok'} count={src.domainCount} kind={t.settings.rstFeedsDomains} onLabel={t.settings.rstFeedOn} offLabel={t.settings.rstFeedOff} />
                ))}
              </div>
            </div>
          ) : rstStatus ? (
            <p className="text-xs text-amber-700">{t.settings.rstFeedsNone}</p>
          ) : null}
          <p className="text-xs text-muted-foreground whitespace-pre-line">{t.settings.rstCardHint}</p>
        </CardContent>
        {dialogVisible && <RstCheckDialog onClose={() => setDialogVisible(false)} />}
      </Card>

      <BatchNoiseCard t={t} tr={tr} />
      <ThreatLibraryCard t={t} tr={tr} />
      <ScanCard t={t} tr={tr} />
      <AssistantCard t={t} tr={tr} />
      <ReportsCard t={t} tr={tr} />
    </div>
  )
}

type Dashboard0 = { settings: Record<string, string> } | null

/** Строка фида Threat Feed: имя, где живёт (Правила/DNS), вкл/выкл, число записей */
function FeedRow({ name, on, ok, count, kind, onLabel, offLabel }: {
  name: string
  on: boolean
  ok: boolean
  count: number
  kind: string
  onLabel: string
  offLabel: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className={`text-xs rounded-full border px-2 py-0.5 ${on ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-input text-muted-foreground'}`}>
        {on ? onLabel : offLabel}
      </span>
      <span className="text-foreground max-w-72 truncate" title={name}>{name}</span>
      <span className="text-xs text-muted-foreground">{kind}</span>
      <span className={`ml-auto text-xs tabular-nums ${ok ? 'text-muted-foreground' : 'text-amber-700'}`}>
        {count.toLocaleString('ru-RU')}
      </span>
    </div>
  )
}

/** Компактный JSON-вьювер результатов (RST отвечает плоскими JSON/массивами) */
function JsonView({ res }: { res: RstApiResult | null }) {
  if (!res) return null
  if (!res.ok) return <p className="text-xs text-red-600 break-words">{res.error}</p>
  const data = res.data ?? {}
  return (
    <pre className="text-xs whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 max-h-72 overflow-auto">
      {JSON.stringify(data, null, 2).slice(0, 8000)}
    </pre>
  )
}

/** Noise Control batch: список значений одного типа → пакетная проверка «шума» */
function BatchNoiseCard({ t, tr }: { t: D; tr: (tpl: string, vars?: Record<string, string | number>) => string }) {
  const [ioctype, setIoctype] = useState('domain')
  const [values, setValues] = useState('')
  const [res, setRes] = useState<RstApiResult | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    setRes(null)
    setToken(null)
    try {
      const list = values.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)
      const r = await api.rst.benignBatch(ioctype, list)
      setRes(r)
      const tk = (r.data as { token?: string } | undefined)?.token ?? null
      setToken(tk)
    } catch (e) {
      setRes({ ok: false, status: 0, error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const fetchResult = async () => {
    if (!token) return
    setBusy(true)
    try {
      setRes(await api.rst.benignResult(ioctype, token))
    } catch (e) {
      setRes({ ok: false, status: 0, error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Radar className="h-4 w-4 text-primary" /> {t.settings.rstBatchTitle}</CardTitle>
        <CardDescription>{t.settings.rstBatchDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Label className="text-foreground">{t.settings.rstBatchType}</Label>
            <Select value={ioctype} onValueChange={setIoctype}>
              <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="domain">domain</SelectItem>
                <SelectItem value="ip">ip</SelectItem>
                <SelectItem value="url">url</SelectItem>
                <SelectItem value="hash">hash</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" disabled={busy || !values.trim()} onClick={() => void run()}>
            <Send className="h-3.5 w-3.5 mr-1.5" /> {t.settings.rstBatchRun}
          </Button>
          {token && (
            <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={() => void fetchResult()}>
              {t.settings.rstBatchFetch}
            </Button>
          )}
        </div>
        <textarea
          value={values}
          onChange={(e) => setValues(e.target.value)}
          rows={4}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm font-mono"
          placeholder={'example.com\nbad.example.net\n…'}
        />
        <p className="text-xs text-muted-foreground">{tr(t.settings.rstBatchHint, {})}</p>
        {res && <JsonView res={res} />}
      </CardContent>
    </Card>
  )
}

/** Threat Library: акторы / malware / кампании / ttps */
function ThreatLibraryCard({ t, tr }: { t: D; tr: (tpl: string, vars?: Record<string, string | number>) => string }) {
  const [type, setType] = useState('actors')
  const [filter, setFilter] = useState('')
  const [res, setRes] = useState<RstApiResult | null>(null)
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)

  const load = async (nextOffset = 0) => {
    setBusy(true)
    try {
      const r = await api.rst.threatObjects(type, { limit: 50, offset: nextOffset, filter: filter.trim() || undefined })
      setRes(r)
      setOffset(nextOffset)
    } catch (e) {
      setRes({ ok: false, status: 0, error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><LibIcon className="h-4 w-4 text-primary" /> {t.settings.rstLibTitle}</CardTitle>
        <CardDescription>{t.settings.rstLibDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Label className="text-foreground">{t.settings.rstLibType}</Label>
            <Select value={type} onValueChange={(v) => { setType(v); setRes(null); setOffset(0) }}>
              <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="actors">actors</SelectItem>
                <SelectItem value="malware">malware</SelectItem>
                <SelectItem value="campaigns">campaigns</SelectItem>
                <SelectItem value="ttps">ttps</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-64">
            <Label className="text-foreground">{t.settings.rstLibFilter}</Label>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="bg-card border-input" placeholder="apt / ransomware / Lazarus…" />
          </div>
          <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" disabled={busy} onClick={() => void load(0)}>
            {t.settings.rstLibLoad}
          </Button>
          {res?.ok && (
            <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy} onClick={() => void load(offset + 50)}>
              {t.settings.rstLibMore}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{tr(t.settings.rstLibHint, {})}</p>
        {res && <JsonView res={res} />}
      </CardContent>
    </Card>
  )
}

/** Scan API: Cobalt Strike beacon / SSL / favicon / HTML */
function ScanCard({ t, tr }: { t: D; tr: (tpl: string, vars?: Record<string, string | number>) => string }) {
  const [target, setTarget] = useState('')
  const [kind, setKind] = useState<'cs-beacon' | 'ssl' | 'favicon' | 'html'>('cs-beacon')
  const [res, setRes] = useState<RstApiResult | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (k: typeof kind) => {
    setBusy(true)
    setKind(k)
    setRes(null)
    try {
      setRes(await api.rst.scan(k, target.trim()))
    } catch (e) {
      setRes({ ok: false, status: 0, error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Radar className="h-4 w-4 text-primary" /> {t.settings.rstScanTitle}</CardTitle>
        <CardDescription>{t.settings.rstScanDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-72">
            <Label className="text-foreground">{t.settings.rstScanTarget}</Label>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} className="bg-card border-input font-mono" placeholder="example.com / 8.8.8.8 / https://…" />
          </div>
          <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy || !target.trim()} onClick={() => void run('cs-beacon')}>cs-beacon</Button>
          <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy || !target.trim()} onClick={() => void run('ssl')}>SSL</Button>
          <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy || !target.trim()} onClick={() => void run('favicon')}>favicon</Button>
          <Button size="sm" variant="outline" className="border-input text-foreground" disabled={busy || !target.trim()} onClick={() => void run('html')}>HTML</Button>
        </div>
        <p className="text-xs text-muted-foreground">{tr(t.settings.rstScanHint, {})}</p>
        {res && <JsonView res={res} />}
      </CardContent>
    </Card>
  )
}

/** CTI Assistant: AI-чат по threat intelligence */
function AssistantCard({ t, tr }: { t: D; tr: (tpl: string, vars?: Record<string, string | number>) => string }) {
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [question, setQuestion] = useState('')
  const [history, setHistory] = useState<Array<{ role: string; content: string }>>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.rst.models()
        const data = r.data as unknown
        const ids: string[] = Array.isArray(data)
          ? (data as Array<{ id?: string }>).map((m) => String(m.id ?? m)).filter(Boolean)
          : Array.isArray((data as { data?: Array<{ id?: string }> })?.data)
            ? (data as { data: Array<{ id?: string }> }).data.map((m) => String(m.id ?? m))
            : []
        setModels(ids)
        if (ids.length > 0 && !model) setModel(ids[0])
        if (!r.ok) setErr(r.error ?? null)
      } catch (e) {
        setErr((e as Error).message)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ask = async () => {
    const q = question.trim()
    if (!q || busy) return
    setBusy(true)
    setErr(null)
    const next = [...history, { role: 'user', content: q }]
    setHistory(next)
    setQuestion('')
    try {
      const r = await api.rst.chat(model, next.slice(-10))
      const data = r.data as { choices?: Array<{ message?: { content?: string } }> } | null
      const answer = data?.choices?.[0]?.message?.content
      if (r.ok && answer) {
        setHistory([...next, { role: 'assistant', content: answer }])
      } else {
        setErr(r.error ?? 'пустой ответ')
        setHistory(next)
      }
    } catch (e) {
      setErr((e as Error).message)
      setHistory(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /> {t.settings.rstAiTitle}</CardTitle>
        <CardDescription>{t.settings.rstAiDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-72">
            <Label className="text-foreground">{t.settings.rstAiModel}</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="bg-card border-input"><SelectValue placeholder={models.length ? undefined : '—'} /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        {history.length > 0 && (
          <div className="space-y-2 max-h-80 overflow-auto rounded-lg border border-border p-3">
            {history.map((m, i) => (
              <div key={i} className={`text-sm whitespace-pre-wrap break-words ${m.role === 'user' ? 'text-foreground' : 'text-emerald-800'}`}>
                <span className="text-xs text-muted-foreground mr-2">{m.role === 'user' ? '→' : 'RST'}</span>
                {m.content}
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-72">
            <Label className="text-foreground">{t.settings.rstAiQuestion}</Label>
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask() } }}
              className="bg-card border-input"
              placeholder={t.settings.rstAiPlaceholder}
            />
          </div>
          <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" disabled={busy || !question.trim() || !model} onClick={() => void ask()}>
            <MessageSquare className="h-3.5 w-3.5 mr-1.5" /> {t.settings.rstAiAsk}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{tr(t.settings.rstAiHint, {})}</p>
        {err && <p className="text-xs text-red-600 break-words">{err}</p>}
      </CardContent>
    </Card>
  )
}

/** Report Hub: список отчётов + просмотр JSON/STIX/PDF */
function ReportsCard({ t, tr }: { t: D; tr: (tpl: string, vars?: Record<string, string | number>) => string }) {
  const [date, setDate] = useState('')
  const [res, setRes] = useState<RstApiResult | null>(null)
  const [view, setView] = useState<RstApiResult & { base64?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    setView(null)
    try {
      setRes(await api.rst.reports(date.trim() || undefined))
    } catch (e) {
      setRes({ ok: false, status: 0, error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const openFile = async (report: string, format: 'json' | 'stix' | 'pdf') => {
    setBusy(true)
    try {
      const r = await api.rst.reportFile(report, format)
      setView(r)
      if (r.ok && format === 'pdf' && r.base64) {
        // PDF скачивается файлом: data URI в новой вкладке
        const blob = Buffer ? null : null
        void blob
        const a = document.createElement('a')
        a.href = `data:application/pdf;base64,${r.base64}`
        a.download = `${report}.pdf`
        a.click()
        setView(null)
      }
    } catch (e) {
      setView({ ok: false, status: 0, error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4 text-primary" /> {t.settings.rstReportsTitle}</CardTitle>
        <CardDescription>{t.settings.rstReportsDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Label className="text-foreground">{t.settings.rstReportsDate}</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-card border-input" />
          </div>
          <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" disabled={busy} onClick={() => void load()}>
            <FileText className="h-3.5 w-3.5 mr-1.5" /> {t.settings.rstReportsLoad}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{tr(t.settings.rstReportsHint, {})}</p>
        {res && res.ok && Array.isArray(res.data) && (res.data as Array<Record<string, unknown>>).length > 0 && (
          <div className="space-y-1 rounded-lg border border-dashed border-border p-3 max-h-64 overflow-auto">
            {(res.data as Array<Record<string, unknown>>).slice(0, 50).map((r, i) => {
              const id = String(r.id ?? r.report_id ?? r.reportId ?? `#${i}`)
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <code className="text-xs text-emerald-700">{id}</code>
                  <span className="text-xs text-muted-foreground truncate max-w-96">{String(r.title ?? r.name ?? r.description ?? '')}</span>
                  <span className="ml-auto flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-6 px-2 text-xs border-input text-foreground" onClick={() => void openFile(id, 'json')}>JSON</Button>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-xs border-input text-foreground" onClick={() => void openFile(id, 'stix')}>STIX</Button>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-xs border-input text-foreground" onClick={() => void openFile(id, 'pdf')}>PDF</Button>
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {view && <JsonView res={view} />}
      </CardContent>
    </Card>
  )
}
