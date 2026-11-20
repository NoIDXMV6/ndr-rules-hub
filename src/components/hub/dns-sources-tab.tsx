'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «DNS списки → Источники»: каталог доменных списков (общедоступные
// хостлисты) и импортированная SQL-база. Идеология аналогична «Каталогу правил»:
// источники → записи → сборка → отдача. Раздел доступен администратору
// (вкладка уровня системы: единые списки и единая сборка).
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, fmtTime, type Dashboard, type DomainSourceItem, type ImportDumpResponse } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Ban, Database, Globe, Plus, RefreshCw, Upload } from 'lucide-react'

/** Ключи категорий каталога (показываются как есть, импорт ifaro — label дампа) */
export const DNS_CATEGORY_KEYS = [
  'ads', 'tracking', 'malware', 'phishing', 'gambling',
  'piracy', 'adult', 'spam', 'rkn', 'mixed', 'allowlist',
]

export function DnsSourcesTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, lang, loc } = useI18n()
  const [sources, setSources] = useState<DomainSourceItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importName, setImportName] = useState('')
  const [importDetails, setImportDetails] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dns = data?.dns ?? null

  const refresh = useCallback(async () => {
    try {
      const r = await api.dns.sources()
      setSources(r.sources)
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (s: DomainSourceItem) => {
    setBusy(s.id)
    try {
      await api.dns.patchSource(s.id, { enabled: !s.enabled })
      await refresh()
      onChange()
    } finally {
      setBusy(null)
    }
  }

  const refetch = async (s: DomainSourceItem) => {
    setBusy(s.id)
    setMsg(null)
    try {
      const r = await api.dns.fetchSource(s.id)
      if (r.ok) {
        setMsg({ ok: true, text: `«${s.name}»: ${r.count.toLocaleString(loc)}${r.diff ? ` (${tr(t.dns.diffNote, { a: r.diff.added, r: r.diff.removed })})` : ''}` })
      } else {
        setMsg({ ok: false, text: r.error ?? 'error' })
      }
      await refresh()
      onChange()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const updateAll = async () => {
    setBusy('all')
    setMsg(null)
    try {
      let ok = 0
      let failed = 0
      for (const s of sources) {
        if (!s.enabled || (s.kind === 'upload' && s.format === 'sql')) continue
        const r = await api.dns.fetchSource(s.id)
        if (r.ok) ok++
        else failed++
      }
      setMsg({ ok: failed === 0, text: `${t.dns.updateAll}: OK ${ok}, errors ${failed}` })
      await refresh()
      onChange()
    } finally {
      setBusy(null)
    }
  }

  const remove = async (s: DomainSourceItem) => {
    if (!window.confirm(tr(t.dns.confirmDelete, { name: s.name }))) return
    setBusy(s.id)
    try {
      await api.dns.deleteSource(s.id)
      await refresh()
      onChange()
    } finally {
      setBusy(null)
    }
  }

  const runImport = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    setImporting(true)
    setMsg(null)
    setImportDetails(null)
    try {
      const res: ImportDumpResponse = await api.dns.importDump(file, importName.trim() || undefined)
      if (res.ok && res.stats) {
        const s = res.stats
        setMsg({ ok: true, text: tr(t.dns.importDone, { n: s.domains.toLocaleString(loc), h: (s.urlHosts ?? 0).toLocaleString(loc), c: s.categories, i: s.invalidDomains.toLocaleString(loc) }) })
        setImportDetails(tr(t.dns.importDetails, {
          u: (s.urlCount ?? 0).toLocaleString(loc),
          uh: (s.urlHosts ?? 0).toLocaleString(loc),
          ip: (s.ipCount ?? 0).toLocaleString(loc),
          cidr: (s.cidrCount ?? 0).toLocaleString(loc),
          rx: (s.regexCount ?? 0).toLocaleString(loc),
          ph: (s.phraseCount ?? 0).toLocaleString(loc),
          ipr: (s.ndrIpRules ?? 0).toLocaleString(loc),
          ur: (s.ndrUrlRules ?? 0).toLocaleString(loc),
          rxr: (s.ndrRegexRules ?? 0).toLocaleString(loc),
          phr: (s.ndrPhraseRules ?? 0).toLocaleString(loc),
        }))
        setImportOpen(false)
        await refresh()
        onChange()
      } else {
        setMsg({ ok: false, text: tr(t.dns.importErr, { err: res.error ?? '—' }) })
      }
    } catch (e) {
      setMsg({ ok: false, text: tr(t.dns.importErr, { err: (e as Error).message }) })
    } finally {
      setImporting(false)
    }
  }

  const added = sources.filter((s) => !s.builtin).length

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto">
              <CardTitle className="text-base text-foreground">{t.dns.sourcesCardTitle}</CardTitle>
              <CardDescription>{t.dns.sourcesCardDesc}</CardDescription>
            </div>
            {dns && (
              <>
                <Badge variant="outline" className={dns.sources.error > 0 ? 'border-amber-400 text-amber-700' : 'border-input text-foreground'}>
                  <Globe className="h-3 w-3 mr-1" />
                  {tr(t.dns.badgeSources, { ok: dns.sources.ok, enabled: dns.sources.enabled })}
                </Badge>
                <Badge variant="outline" className="border-input text-foreground">
                  <Database className="h-3 w-3 mr-1" />
                  {tr(t.dns.badgeDomains, { n: dns.domains.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US') })}
                </Badge>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {msg && (
            <div className={`rounded-lg text-sm px-3 py-2 border whitespace-pre-line ${msg.ok ? 'bg-emerald-50 text-emerald-800 border-emerald-200/60' : 'bg-red-50 text-red-700 border-red-200/60'}`}>{msg.text}</div>
          )}
          {importDetails && (
            <div className="rounded-lg text-xs px-3 py-2 border border-sky-200 bg-sky-50 text-sky-800 whitespace-pre-line">{importDetails}</div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={updateAll} disabled={busy !== null} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busy === 'all' ? 'animate-spin' : ''}`} /> {t.dns.updateAll}
            </Button>
            <AddSourceDialog open={addOpen} onOpenChange={setAddOpen} onDone={() => { void refresh(); onChange() }} />
            <Dialog open={importOpen} onOpenChange={(o) => { if (!importing) setImportOpen(o) }}>
              <DialogTrigger asChild>
                <Button variant="outline" className="border-input text-foreground"><Upload className="h-4 w-4 mr-1.5" /> {t.dns.importTitle}</Button>
              </DialogTrigger>
              <DialogContent className="bg-card border-border max-w-2xl">
                <DialogHeader>
                  <DialogTitle className="text-foreground">{t.dns.importTitle}</DialogTitle>
                  <DialogDescription className="text-muted-foreground">{t.dns.importHint}</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label className="text-foreground">{t.dns.importNameLabel}</Label>
                    <Input value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="База фильтрации нежелательных ресурсов" className="bg-card border-input mt-1" />
                  </div>
                  <div>
                    <Label className="text-foreground">{t.dns.importFileLabel}</Label>
                    <Input ref={fileRef} type="file" accept=".sql,.rar" className="bg-card border-input mt-1" />
                  </div>
                  {importing && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{t.dns.importing}</div>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" className="border-input text-foreground" onClick={() => setImportOpen(false)} disabled={importing}>{t.dns.cancel}</Button>
                  <Button onClick={runImport} disabled={importing || !fileRef.current?.files?.[0]} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                    <Upload className="h-4 w-4 mr-1.5" /> {t.dns.importButton}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Badge variant="outline" className="border-input text-muted-foreground ml-auto">{sources.length} ({added} +)</Badge>
          </div>
        </CardContent>
      </Card>

      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.dns.emptySources}</p>
      ) : (
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            <div className="max-h-[32rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/95 backdrop-blur">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t.dns.colName}</th>
                    <th className="px-3 py-2 font-medium hidden md:table-cell">{t.dns.colUrl}</th>
                    <th className="px-3 py-2 font-medium">{t.dns.colCategory}</th>
                    <th className="px-3 py-2 font-medium">{t.dns.colDomains}</th>
                    <th className="px-3 py-2 font-medium">{t.dns.colPriority}</th>
                    <th className="px-3 py-2 font-medium">{t.dns.colStatus}</th>
                    <th className="px-3 py-2 font-medium hidden lg:table-cell">{t.dns.colUpdated}</th>
                    <th className="px-3 py-2 font-medium text-right">{t.dns.colPurpose}</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id} className="border-t border-border/60 hover:bg-muted/40">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Switch checked={s.enabled} onCheckedChange={() => void toggle(s)} disabled={busy === s.id} aria-label={s.name} />
                          <span className={s.enabled ? 'text-foreground font-medium' : 'text-muted-foreground'}>{s.name}</span>
                        </div>
                        {s.lastError && <p className="text-[11px] text-red-600 mt-0.5 max-w-sm truncate" title={s.lastError}>{s.lastError}</p>}
                      </td>
                      <td className="px-3 py-2 hidden md:table-cell max-w-[16rem]">
                        <span className="text-xs text-muted-foreground truncate block" title={s.url ?? ''}>{s.kind === 'upload' && s.format === 'sql' ? 'SQL import' : s.url}</span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="border-input text-muted-foreground">{s.category}</Badge>
                        {s.purpose === 'allow' && <Badge variant="outline" className="border-emerald-400 text-emerald-700 ml-1">{t.dns.purposeAllow}</Badge>}
                      </td>
                      <td className="px-3 py-2 text-foreground">{s.domainCount.toLocaleString(loc)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{s.priority}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={
                          s.status === 'ok' ? 'border-emerald-400 text-emerald-700' : s.status === 'error' ? 'border-red-400 text-red-700' : 'border-input text-muted-foreground'
                        }>
                          {s.status === 'ok' ? t.dns.statusOk : s.status === 'error' ? t.dns.statusError : t.dns.statusNever}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 hidden lg:table-cell text-xs text-muted-foreground">{s.lastFetchAt ? fmtTime(s.lastFetchAt, lang) : '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => void refetch(s)} disabled={busy !== null || (s.kind === 'upload' && s.format === 'sql')} title={t.dns.refresh}>
                            <RefreshCw className={`h-4 w-4 ${busy === s.id ? 'animate-spin' : ''}`} />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void remove(s)} disabled={busy !== null} title={t.dns.del} className="text-red-600 hover:text-red-700">
                            <Ban className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function AddSourceDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState('auto')
  const [category, setCategory] = useState('ads')
  const [purpose, setPurpose] = useState('block')
  const [priority, setPriority] = useState('100')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.dns.addSource({ name: name.trim(), url: url.trim(), format, category, purpose, priority: parseInt(priority, 10) || 100, enabled })
      if (r.source) {
        setName(''); setUrl(''); setPriority('100'); setEnabled(false)
        onOpenChange(false)
        onDone()
      } else setErr(r.error ?? 'error')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-input text-foreground"><Plus className="h-4 w-4 mr-1.5" /> {t.dns.addSource}</Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-foreground">{t.dns.addDialogTitle}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t.dns.addDialogDesc}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <Label className="text-foreground">{t.dns.fieldName}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-card border-input mt-1" />
          </div>
          <div className="md:col-span-2">
            <Label className="text-foreground">{t.dns.fieldUrl}</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="bg-card border-input mt-1" />
          </div>
          <div>
            <Label className="text-foreground">{t.dns.fieldCategory}</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="bg-card border-input mt-1"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border max-h-72">
                {DNS_CATEGORY_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>{k}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-foreground">{t.dns.fieldPurpose}</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger className="bg-card border-input mt-1"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="block">{t.dns.purposeBlock}</SelectItem>
                <SelectItem value="allow">{t.dns.purposeAllow}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-foreground">{t.dns.fieldPriority}</Label>
            <Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} className="bg-card border-input mt-1" />
          </div>
          <div>
            <Label className="text-foreground">{t.dns.fieldFormat}</Label>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger className="bg-card border-input mt-1"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="auto">{t.dns.fmtAuto}</SelectItem>
                <SelectItem value="adguard">{t.dns.fmtAdguard}</SelectItem>
                <SelectItem value="hosts">{t.dns.fmtHosts}</SelectItem>
                <SelectItem value="plain">{t.dns.fmtPlain}</SelectItem>
                <SelectItem value="rst-csv">{t.dns.fmtRstCsv}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 md:col-span-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="dns-src-enabled" />
            <Label htmlFor="dns-src-enabled" className="text-foreground">{t.dns.fieldEnabled}</Label>
          </div>
          {err && <p className="text-sm text-red-600 md:col-span-2">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" className="border-input text-foreground" onClick={() => onOpenChange(false)}>{t.dns.cancel}</Button>
          <Button onClick={create} disabled={busy || !name.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground">{t.dns.create}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
