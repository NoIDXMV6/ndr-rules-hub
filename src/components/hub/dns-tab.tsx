'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «DNS-фильтрация»: источники доменных списков, категории, записи
// (поиск и дубликаты), сборка списка заблокированных доменов и экспорт.
// Идеология аналогична правилам NDR: источники → записи → сборка → отдача.
// Раздел доступен администратору (вкладка системы, не рабочего пространства).
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, fmtSize, fmtTime, type Dashboard, type DomainCategoryItem, type DomainRecordRow, type DomainSourceItem, type DnsBuildProgressInfo, type DomainBuildItem, type ImportDumpResponse } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Ban, Building2, Database, Download, Globe, ListChecks, RefreshCw, Search, ShieldBan, Upload } from 'lucide-react'

/** Ключи категорий каталога (показываются как есть, импорт ifaro — label дампа) */
const DNS_CATEGORY_KEYS = [
  'ads', 'tracking', 'malware', 'phishing', 'gambling',
  'piracy', 'adult', 'spam', 'rkn', 'mixed', 'allowlist',
]

export function DnsTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, lang } = useI18n()
  const [sub, setSub] = useState('sources')
  const dns = data?.dns ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-lg font-bold leading-tight">{t.dns.title}</h2>
          <p className="text-xs text-muted-foreground">{t.dns.subtitle}</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
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
              <Badge variant="outline" className="border-input text-foreground">
                <ShieldBan className="h-3 w-3 mr-1" />
                {dns.lastBuild ? tr(t.dns.badgeBuild, { n: dns.lastBuild.totalDomains.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US') }) : t.dns.noBuild}
              </Badge>
            </>
          )}
        </div>
      </div>

      <Tabs value={sub} onValueChange={setSub} className="w-full">
        <TabsList className="bg-muted/60 border border-border w-full">
          <TabsTrigger value="sources" className="flex-1"><Globe className="h-4 w-4 mr-1.5" />{t.dns.subSources}</TabsTrigger>
          <TabsTrigger value="categories" className="flex-1"><ListChecks className="h-4 w-4 mr-1.5" />{t.dns.subCategories}</TabsTrigger>
          <TabsTrigger value="records" className="flex-1"><Search className="h-4 w-4 mr-1.5" />{t.dns.subRecords}</TabsTrigger>
          <TabsTrigger value="build" className="flex-1"><Building2 className="h-4 w-4 mr-1.5" />{t.dns.subBuild}</TabsTrigger>
        </TabsList>
        <TabsContent value="sources" className="mt-4">
          <SourcesSection onChange={onChange} />
        </TabsContent>
        <TabsContent value="categories" className="mt-4">
          <CategoriesSection />
        </TabsContent>
        <TabsContent value="records" className="mt-4">
          <RecordsSection />
        </TabsContent>
        <TabsContent value="build" className="mt-4">
          <BuildSection data={data} onChange={onChange} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Источники ────────────────────────────────────────────────────────────────

function SourcesSection({ onChange }: { onChange: () => void }) {
  const { t, tr, lang, loc } = useI18n()
  const [sources, setSources] = useState<DomainSourceItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importName, setImportName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

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
    try {
      const res: ImportDumpResponse = await api.dns.importDump(file, importName.trim() || undefined)
      if (res.ok && res.stats) {
        setMsg({ ok: true, text: tr(t.dns.importDone, { n: res.stats.domains.toLocaleString(loc), c: res.stats.categories, o: res.stats.otherTypes.toLocaleString(loc), i: res.stats.invalidDomains.toLocaleString(loc) }) })
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
    <div className="space-y-3">
      {msg && (
        <div className={`rounded-lg text-sm px-3 py-2 border ${msg.ok ? 'bg-emerald-50 text-emerald-800 border-emerald-200/60' : 'bg-red-50 text-red-700 border-red-200/60'}`}>{msg.text}</div>
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
        <Button variant="outline" className="border-input text-foreground"><Globe className="h-4 w-4 mr-1.5" /> {t.dns.addSource}</Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-foreground">{t.dns.addDialogTitle}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t.dns.importHint}</DialogDescription>
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

// ── Категории ────────────────────────────────────────────────────────────────

function CategoriesSection() {
  const { t, tr, loc } = useI18n()
  const [cats, setCats] = useState<DomainCategoryItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api.dns.categories()
      // каталог (ключи) сверху, категории импорта — по убыванию счётчика
      const catalog = r.categories.filter((c) => DNS_CATEGORY_KEYS.includes(c.name))
      const imported = r.categories.filter((c) => !DNS_CATEGORY_KEYS.includes(c.name)).sort((a, b) => b.domains - a.domains)
      setCats([...catalog, ...imported])
    } catch {
      setCats([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (c: DomainCategoryItem) => {
    setBusy(c.id)
    try {
      await api.dns.patchCategory(c.id, { enabled: !c.enabled })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const [showImported, setShowImported] = useState(true)

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t.dns.catIfaroNote}</p>
      {cats.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.dns.emptyCategories}</p>
      ) : (
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            <div className="max-h-[32rem] overflow-y-auto divide-y divide-border/60">
              {cats.filter((c) => DNS_CATEGORY_KEYS.includes(c.name) || showImported).map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                  <Switch checked={c.enabled} onCheckedChange={() => void toggle(c)} disabled={busy === c.id} aria-label={c.name} />
                  <div className="min-w-0 flex-1">
                    <span className={`text-sm ${c.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {c.name.startsWith('ifaro:') ? (c.label ?? c.name) : c.name}
                    </span>
                    {c.name.startsWith('ifaro:') && <span className="text-[11px] text-muted-foreground ml-2">{c.name}</span>}
                  </div>
                  <Badge variant="outline" className="border-input text-muted-foreground shrink-0">{tr(t.dns.catDomains, { n: c.domains.toLocaleString(loc) })}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
        <input type="checkbox" checked={showImported} onChange={(e) => setShowImported(e.target.checked)} className="accent-primary" />
        ifaro ({cats.filter((c) => c.name.startsWith('ifaro:')).length})
      </label>
    </div>
  )
}

// ── Записи: поиск, дубликаты, ручные решения ────────────────────────────────

function RecordsSection() {
  const { t, tr, loc } = useI18n()
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<DomainRecordRow[]>([])
  const [dups, setDups] = useState<Array<{ domain: string; sources: number }>>([])
  const [total, setTotal] = useState<number | null>(null)
  const [mode, setMode] = useState<'search' | 'dups'>('search')
  const [busy, setBusy] = useState(false)
  const [searched, setSearched] = useState(false)

  const run = useCallback(async (q: string, dup: boolean) => {
    setBusy(true)
    try {
      const r = await api.dns.records({ search: q || undefined, duplicates: dup })
      setRows(r.rows ?? [])
      setDups(r.duplicates ?? [])
      setTotal(r.total ?? null)
      setSearched(true)
    } finally {
      setBusy(false)
    }
  }, [])

  const setOverride = async (domain: string, enabled: boolean, force: boolean) => {
    await api.dns.setOverride(domain, enabled, force)
    await run(search, mode === 'dups')
  }

  const resetOverride = async (domain: string) => {
    await api.dns.resetOverride(domain)
    await run(search, mode === 'dups')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setMode('search'); void run(search, false) } }}
          placeholder={t.dns.searchPlaceholder}
          className="bg-card border-input max-w-md"
        />
        <Button onClick={() => { setMode('search'); void run(search, false) }} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
          <Search className="h-4 w-4 mr-1.5" /> {t.dns.searchBtn}
        </Button>
        <Button variant="outline" className="border-input text-foreground" onClick={() => { setMode('dups'); setTotal(null); void run('', true) }} disabled={busy}>
          <Database className="h-4 w-4 mr-1.5" /> {t.dns.duplicatesBtn}
        </Button>
        <Button variant="ghost" className="text-muted-foreground" onClick={() => { setSearch(''); setRows([]); setDups([]); setSearched(false); setMode('search') }}>
          {t.dns.resetBtn}
        </Button>
      </div>
      {searched && <p className="text-xs text-muted-foreground">{total !== null ? tr(t.dns.rowsCount, { n: total.toLocaleString(loc) }) : ''}</p>}
      {searched && mode === 'dups' && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2"><CardTitle className="text-base text-foreground">{t.dns.dupTitle}</CardTitle></CardHeader>
          <CardContent>
            {dups.length === 0 ? <p className="text-sm text-muted-foreground">{t.dns.dupEmpty}</p> : (
              <div className="flex flex-wrap gap-1.5">
                {dups.slice(0, 50).map((d) => (
                  <button key={d.domain} onClick={() => { setSearch(d.domain); setMode('search'); void run(d.domain, false) }} className="rounded border border-input px-2 py-0.5 text-xs text-foreground hover:bg-muted">
                    {d.domain} <span className="text-muted-foreground">×{d.sources}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {searched && rows.length === 0 && mode === 'search' && <p className="text-sm text-muted-foreground">{t.dns.emptyRecords}</p>}
      {rows.length > 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            <div className="max-h-[32rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/95 backdrop-blur">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t.dns.colName}</th>
                    <th className="px-3 py-2 font-medium">{t.dns.colMode}</th>
                    <th className="px-3 py-2 font-medium">{t.dns.colCategory}</th>
                    <th className="px-3 py-2 font-medium text-right">{t.dns.colPriority}</th>
                    <th className="px-3 py-2 font-medium text-right" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.sourceName}:${r.domain}:${r.id}`} className="border-t border-border/60 hover:bg-muted/40">
                      <td className="px-3 py-2 text-foreground font-mono text-xs">
                        {r.domain}
                        {r.override && (
                          <Badge variant="outline" className={`ml-2 ${r.override.enabled && r.override.note === 'force' ? 'border-amber-400 text-amber-700' : 'border-red-400 text-red-700'}`}>
                            {r.override.enabled && r.override.note === 'force' ? t.dns.overrideActiveForce : t.dns.overrideActiveOff}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={r.mode === 'allow' || r.sourcePurpose === 'allow' ? 'border-emerald-400 text-emerald-700' : 'border-input text-muted-foreground'}>
                          {r.mode === 'allow' || r.sourcePurpose === 'allow' ? t.dns.modeAllow : t.dns.modeBlock}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.sourceName}</td>
                      <td className="px-3 py-2 text-muted-foreground text-right">{r.sourcePriority}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          {(!r.override || r.override.enabled) && (
                            <Button variant="ghost" size="sm" title={t.dns.overrideOff} onClick={() => void setOverride(r.domain, false, false)} className="text-red-600 hover:text-red-700">
                              <Ban className="h-4 w-4" />
                            </Button>
                          )}
                          {(!r.override || !(r.override.enabled && r.override.note === 'force')) && (
                            <Button variant="ghost" size="sm" title={t.dns.overrideForce} onClick={() => void setOverride(r.domain, true, true)} className="text-amber-600 hover:text-amber-700">
                              <ShieldBan className="h-4 w-4" />
                            </Button>
                          )}
                          {r.override && (
                            <Button variant="ghost" size="sm" title={t.dns.overrideReset} onClick={() => void resetOverride(r.domain)} className="text-muted-foreground">
                              <RefreshCw className="h-4 w-4" />
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
      )}
      {searched && <p className="text-[11px] text-muted-foreground">{t.dns.overrideNeedRebuild}</p>}
    </div>
  )
}

// ── Сборка и экспорт ─────────────────────────────────────────────────────────

function BuildSection({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, lang, loc } = useI18n()
  const [build, setBuild] = useState<DomainBuildItem | null>(null)
  const [progress, setProgress] = useState<DnsBuildProgressInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // origin берём из window в момент рендера действия (SSR-безопасно):
  // setState в эффекте запрещён линтом, поэтому адрес подставляется лениво
  useEffect(() => {
    void api.dns.lastBuild().then((r) => setBuild(r.build)).catch(() => undefined)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const startPoll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.dns.buildProgress()
        const p = r.progress
        setProgress(p)
        if (p && !p.active) {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          setBusy(false)
          const b = await api.dns.lastBuild()
          setBuild(b.build)
          onChange()
        }
      } catch { /* сеть моргнула — продолжаем опрос */ }
    }, 1500)
  }, [onChange])

  const startBuild = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.dns.build()
      if (r.ok) startPoll()
      else { setBusy(false); setMsg(r.error ?? 'error') }
    } catch (e) {
      setBusy(false)
      setMsg((e as Error).message)
    }
  }

  const saveFormat = async (v: string) => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dnsBuildFormat: v }) })
    onChange()
  }
  const saveName = async (v: string) => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dnsFileName: v }) })
  }
  const saveServeToken = async (v: string) => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dnsServeToken: v }) })
    onChange()
  }

  const settings = data?.settings ?? {}
  const active = progress?.active ?? false
  const stats = build?.stats ?? {}
  // адрес отдачи собирается из адресной строки браузера (как в карточке токенов)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-foreground">{t.dns.title} — {t.dns.subBuild}</CardTitle>
          <CardDescription className="text-muted-foreground">{t.dns.cronNote}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-foreground">{t.dns.buildFormatLabel}</Label>
              <Select value={settings.dnsBuildFormat ?? 'plain'} onValueChange={(v) => void saveFormat(v)}>
                <SelectTrigger className="bg-card border-input mt-1"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="plain">{t.dns.fmtExportPlain}</SelectItem>
                  <SelectItem value="hosts">{t.dns.fmtExportHosts}</SelectItem>
                  <SelectItem value="dnsmasq">{t.dns.fmtExportDnsmasq}</SelectItem>
                  <SelectItem value="adblock">{t.dns.fmtExportAdblock}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">{t.dns.fileNameLabel}</Label>
              <Input defaultValue={settings.dnsFileName ?? 'blocked-domains.txt'} onBlur={(e) => void saveName(e.target.value.trim())} className="bg-card border-input mt-1" />
            </div>
          </div>
          <div>
            <Label className="text-foreground">{t.dns.serveTokenLabel}</Label>
            <Input type="password" defaultValue={settings.dnsServeToken ?? ''} onBlur={(e) => void saveServeToken(e.target.value.trim())} className="bg-card border-input mt-1" />
            <p className="text-xs text-muted-foreground mt-1">{t.dns.serveTokenHint}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={startBuild} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Building2 className={`h-4 w-4 mr-1.5 ${busy ? 'animate-pulse' : ''}`} /> {busy ? t.dns.building : t.dns.buildBtn}
            </Button>
            {build && (
              <Button variant="outline" className="border-input text-foreground" onClick={() => window.open('/api/dns/export', '_blank')}>
                <Download className="h-4 w-4 mr-1.5" /> {t.dns.download}
              </Button>
            )}
            {msg && <span className="text-sm text-red-600">{msg}</span>}
          </div>
          {active && progress && (
            <div className="space-y-1">
              <Progress value={progress.percent} className="h-2" />
              <p className="text-xs text-muted-foreground">{progress.stage} · {progress.percent}%</p>
            </div>
          )}
          {progress && progress.log.length > 0 && (
            <details className="rounded-lg border border-border">
              <summary className="px-3 py-2 text-sm text-foreground cursor-pointer select-none">{t.dns.buildLog}</summary>
              <div className="max-h-56 overflow-y-auto px-3 pb-2 space-y-0.5">
                {progress.log.slice(-40).map((l, i) => (
                  <p key={i} className="text-[11px] text-muted-foreground font-mono whitespace-pre-wrap">{l.msg}</p>
                ))}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-foreground">{t.dns.lastBuildTitle}</CardTitle>
          {build && <CardDescription className="text-muted-foreground">{fmtTime(build.createdAt, lang)} · {build.source === 'cron' ? 'cron' : 'manual'}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-2">
          {!build ? (
            <p className="text-sm text-muted-foreground">{t.dns.noBuild}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-sm text-foreground">
                <Badge variant="outline" className="border-input"><Database className="h-3 w-3 mr-1" />{build.totalDomains.toLocaleString(loc)}</Badge>
                <Badge variant="outline" className="border-input">{build.fileName}</Badge>
                <Badge variant="outline" className="border-input">{fmtSize(build.sizeBytes, lang)}</Badge>
                <code className="text-[11px] text-muted-foreground self-center" title={build.sha256}>{build.sha256.slice(0, 16)}…</code>
              </div>
              {stats && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {typeof stats.duplicateByDomain === 'number' && <span>{tr(t.dns.statsDuplicates, { n: stats.duplicateByDomain.toLocaleString(loc) })}</span>}
                  {typeof stats.allowedRemoved === 'number' && <span>{tr(t.dns.statsAllowed, { n: stats.allowedRemoved.toLocaleString(loc) })}</span>}
                  {typeof stats.categoryRemoved === 'number' && <span>{tr(t.dns.statsCategories, { n: stats.categoryRemoved.toLocaleString(loc) })}</span>}
                  {typeof stats.overrideRemoved === 'number' && <span>{tr(t.dns.statsOverride, { n: stats.overrideRemoved.toLocaleString(loc) })}</span>}
                  {typeof stats.tldCount === 'number' && <span>{tr(t.dns.statsTld, { n: stats.tldCount.toLocaleString(loc) })}</span>}
                </div>
              )}
              <div className="pt-1">
                <p className="text-xs text-muted-foreground mb-1">{t.dns.serveUrlTitle}</p>
                <code className="block rounded border border-border bg-muted/60 px-2 py-1 text-xs text-foreground break-all">{origin}/api/dns/export</code>
              </div>
              <p className="text-[11px] text-muted-foreground">{t.dns.tokensHint}</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
