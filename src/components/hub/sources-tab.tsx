'use client'

import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { api, Dashboard, fmtTime, SourceItem } from '@/components/hub/api'
import { useI18n, type Dictionary } from '@/lib/i18n'
import { ChevronDown, FileUp, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'

type BadgeKey = keyof Dictionary['sources']['badges']

const BADGE_CLASSES: Record<BadgeKey, string> = {
  recommended: 'border-emerald-500 text-emerald-700',
  duplicate: 'border-amber-500 text-amber-700',
  legacy: 'border-zinc-300 text-muted-foreground',
  paid: 'border-violet-400 text-violet-700',
  converter: 'border-sky-400 text-sky-700',
  new: 'border-lime-400 text-lime-700',
  unavailable: 'border-red-300 text-red-600',
}

export function SourcesTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, lang, loc } = useI18n()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const sources = useMemo(() => {
    const list = data?.sources.list ?? []
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter((s) => s.name.toLowerCase().includes(q) || (s.notes ?? '').toLowerCase().includes(q))
  }, [data, search])

  const toggle = async (s: SourceItem) => {
    setBusyId(s.id)
    try {
      await api.patchSource(s.id, { enabled: !s.enabled })
      onChange()
    } finally {
      setBusyId(null)
    }
  }

  const fetchOne = async (s: SourceItem) => {
    setBusyId(s.id)
    setMsg(tr(t.messages.fetchOneLoading, { name: s.name }))
    try {
      const r = await api.fetchSource(s.id)
      setMsg(
        r.ok
          ? tr(t.messages.fetchOneOk, { name: s.name, n: r.count.toLocaleString(loc), note: r.note ? `\n⚠ ${r.note}` : '' })
          : tr(t.messages.fetchErr, { err: r.error ?? '—' }),
      )
      onChange()
    } catch (e) {
      setMsg(tr(t.messages.fetchErr, { err: (e as Error).message }))
    } finally {
      setBusyId(null)
    }
  }

  const fetchAll = async () => {
    setBusyId('all')
    setMsg(t.messages.fetchAllLoading)
    try {
      const r = await api.fetchAll()
      setMsg(tr(t.messages.fetchAllDone, { ok: r.ok, failed: r.failed, first: r.errors.length ? ' — ' + r.errors[0] : '' }))
      onChange()
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (s: SourceItem) => {
    setBusyId(s.id)
    try {
      await api.deleteSource(s.id)
      setMsg(tr(t.messages.sourceDeleted, { name: s.name }))
      onChange()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const kindLabel = (s: SourceItem): string =>
    s.kind === 'local' ? t.sources.kinds.local
      : s.category === 'ip-list' ? t.sources.kinds.ipList
      : s.category === 'domain-list' ? t.sources.kinds.domainList
      : s.kind === 'tarball' ? t.sources.kinds.tarball
      : t.sources.kinds.ruleset

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto">
              <CardTitle className="text-base">{t.sources.catalog}</CardTitle>
              <CardDescription>{t.sources.catalogDesc}</CardDescription>
            </div>
            <Input
              placeholder={t.sources.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 bg-card border-input"
            />
            <Button onClick={fetchAll} disabled={busyId !== null} variant="outline" className="border-input text-foreground">
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busyId === 'all' ? 'animate-spin' : ''}`} /> {t.sources.refreshAll}
            </Button>
            <AddSourceDialog onCreated={() => { setMsg(t.messages.sourceAdded); onChange() }} />
          </div>
        </CardHeader>
        <CardContent>
          {msg && <p className="text-sm mb-3 text-emerald-700 whitespace-pre-wrap">{msg}</p>}
          <div className="rounded-lg border border-border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-12 text-muted-foreground">{t.sources.colEnabled}</TableHead>
                  <TableHead className="text-muted-foreground">{t.sources.colSource}</TableHead>
                  <TableHead className="text-muted-foreground">{t.sources.colType}</TableHead>
                  <TableHead className="text-muted-foreground">{t.sources.colRules}</TableHead>
                  <TableHead className="text-muted-foreground">{t.sources.colPriority}</TableHead>
                  <TableHead className="text-muted-foreground">{t.sources.colStatus}</TableHead>
                  <TableHead className="text-muted-foreground">{t.sources.colUpdated}</TableHead>
                  <TableHead className="text-right text-muted-foreground">{t.sources.colActions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((s) => {
                  const badgeKey = (s.badge && s.badge in BADGE_CLASSES ? s.badge : null) as BadgeKey | null
                  return (
                    <TableRow key={s.id} className="border-border/60">
                      <TableCell>
                        <Switch checked={s.enabled} onCheckedChange={() => toggle(s)} disabled={busyId === s.id} />
                      </TableCell>
                      <TableCell className="max-w-md">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground">{s.name}</span>
                          {badgeKey && <Badge variant="outline" className={BADGE_CLASSES[badgeKey]}>{t.sources.badges[badgeKey]}</Badge>}
                        </div>
                        {s.notes && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.notes}</p>}
                        {s.lastError && <p className="text-xs text-red-600 mt-0.5">{t.sources.errPrefix} {s.lastError}</p>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {kindLabel(s)}
                        {s.authType !== 'none' && <div className="text-emerald-600">{s.authType}</div>}
                      </TableCell>
                      <TableCell className="tabular-nums text-foreground">{s.ruleCount ? s.ruleCount.toLocaleString(loc) : '—'}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{s.priority}</TableCell>
                      <TableCell>
                        {s.status === 'ok' && <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-300">{t.sources.statusOk}</Badge>}
                        {s.status === 'error' && <Badge className="bg-red-50 text-red-600 border border-red-300">{t.sources.statusError}</Badge>}
                        {s.status === 'never' && <Badge variant="outline" className="border-input text-muted-foreground">{t.sources.statusNever}</Badge>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{fmtTime(s.lastFetchAt, lang)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" className="h-8 border-input text-foreground" disabled={busyId === s.id} onClick={() => fetchOne(s)}>
                            <RefreshCw className={`h-3.5 w-3.5 ${busyId === s.id ? 'animate-spin' : ''}`} />
                          </Button>
                          <EditSourceDialog source={s} onSaved={() => onChange()} />
                          {!s.builtin && (
                            <Button size="sm" variant="outline" className="h-8 border-red-300 text-red-600" onClick={() => remove(s)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <AnalysisCard />
    </div>
  )
}

function AnalysisCard() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const a = t.sources.analysis
  return (
    <Card className="bg-card border-border">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full text-left">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FileUp className="h-4 w-4 text-primary" />
              {a.title}
              <ChevronDown className={`h-4 w-4 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
            </CardTitle>
            <CardDescription>{a.desc}</CardDescription>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
                <p className="font-semibold text-emerald-800">{a.card1Title}</p>
                <p className="text-muted-foreground mt-1">{a.card1Text}</p>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="font-semibold text-amber-800">{a.card2Title}</p>
                <p className="text-muted-foreground mt-1">{a.card2Text}</p>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="font-semibold text-amber-800">{a.card3Title}</p>
                <p className="text-muted-foreground mt-1">{a.card3Text}</p>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="font-semibold text-amber-800">{a.card4Title}</p>
                <p className="text-muted-foreground mt-1">{a.card4Text}</p>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">{a.footnote}</p>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

function AddSourceDialog({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n()
  const d = t.sources.addDialog
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    name: '', category: 'ruleset', kind: 'url', url: '', authType: 'none',
    priority: '100', notes: '', extraJson: '',
  })
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    try {
      await api.createSource({
        name: form.name,
        category: form.category,
        kind: form.kind,
        url: form.url || null,
        authType: form.authType,
        priority: Number(form.priority) || 100,
        notes: form.notes || null,
        extraJson: form.extraJson || null,
        enabled: false,
      })
      setOpen(false)
      onCreated()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
          <Plus className="h-4 w-4 mr-1.5" /> {d.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border text-foreground max-w-lg">
        <DialogHeader>
          <DialogTitle>{d.title}</DialogTitle>
          <DialogDescription>{d.desc}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-foreground">{d.name}</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bg-card border-input" placeholder={d.namePlaceholder} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-foreground">{d.contentType}</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="ruleset">{d.catRuleset}</SelectItem>
                  <SelectItem value="tarball">{d.catTarball}</SelectItem>
                  <SelectItem value="ip-list">{d.catIpList}</SelectItem>
                  <SelectItem value="domain-list">{d.catDomainList}</SelectItem>
                  <SelectItem value="url-list">{d.catUrlList}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">{d.howToFetch}</Label>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="url">{d.kindUrl}</SelectItem>
                  <SelectItem value="tarball">{d.kindTarball}</SelectItem>
                  <SelectItem value="local">{d.kindLocal}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.kind !== 'local' && (
            <div>
              <Label className="text-foreground">{d.url}</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="bg-card border-input" placeholder="https://…" />
            </div>
          )}
          {form.kind === 'local' && (
            <div>
              <Label className="text-foreground">{d.localPath}</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="bg-card border-input" placeholder="/data/archives/my.rules" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-foreground">{d.auth}</Label>
              <Select value={form.authType} onValueChange={(v) => setForm({ ...form, authType: v })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="none">{d.authNone}</SelectItem>
                  <SelectItem value="oinkcode">{d.authOinkcode}</SelectItem>
                  <SelectItem value="authkey">{d.authAuthkey}</SelectItem>
                  <SelectItem value="basic">{d.authBasic}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">{d.priority}</Label>
              <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="bg-card border-input" />
            </div>
          </div>
          <div>
            <Label className="text-foreground">{d.extraJson}</Label>
            <Textarea
              value={form.extraJson}
              onChange={(e) => setForm({ ...form, extraJson: e.target.value })}
              className="bg-card border-input font-mono text-xs"
              rows={3}
              placeholder='{"sidStart":1101000,"msgPrefix":"MY-FEED","perRule":500,"oinkcode":"…"}'
            />
          </div>
          <div>
            <Label className="text-foreground">{d.notes}</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="bg-card border-input" />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" className="border-input" onClick={() => setOpen(false)}>{d.cancel}</Button>
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={submit} disabled={!form.name}>{d.create}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditSourceDialog({ source, onSaved }: { source: SourceItem; onSaved: () => void }) {
  const { t } = useI18n()
  const d = t.sources.addDialog
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    name: source.name,
    url: source.url ?? '',
    authType: source.authType,
    priority: String(source.priority),
    notes: source.notes ?? '',
    extraJson: source.extraJson ?? '',
  })
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    try {
      await api.patchSource(source.id, {
        name: form.name,
        url: form.url || null,
        authType: form.authType,
        priority: Number(form.priority) || 100,
        notes: form.notes || null,
        extraJson: form.extraJson || null,
      })
      setOpen(false)
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 border-input text-foreground">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border text-foreground max-w-lg">
        <DialogHeader>
          <DialogTitle>{d.editTitle}</DialogTitle>
          <DialogDescription className="break-all">{source.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-foreground">{d.name}</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bg-card border-input" />
          </div>
          <div>
            <Label className="text-foreground">{d.urlPath}</Label>
            <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="bg-card border-input font-mono text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-foreground">{d.auth}</Label>
              <Select value={form.authType} onValueChange={(v) => setForm({ ...form, authType: v })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="none">{d.authNone}</SelectItem>
                  <SelectItem value="oinkcode">{d.authOinkcode}</SelectItem>
                  <SelectItem value="authkey">{d.authAuthkeyShort}</SelectItem>
                  <SelectItem value="basic">{d.authBasicShort}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">{d.priorityShort}</Label>
              <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="bg-card border-input" />
            </div>
          </div>
          <div>
            <Label className="text-foreground">extraJson</Label>
            <Textarea value={form.extraJson} onChange={(e) => setForm({ ...form, extraJson: e.target.value })} className="bg-card border-input font-mono text-xs" rows={3} />
            <p className="text-xs text-muted-foreground mt-1">{d.extraHelp}</p>
          </div>
          <div>
            <Label className="text-foreground">{d.notes}</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="bg-card border-input" />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" className="border-input" onClick={() => setOpen(false)}>{d.cancel}</Button>
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={submit}>{d.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
