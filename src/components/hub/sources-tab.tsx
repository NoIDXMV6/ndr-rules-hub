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
import { pickLocalizedNote } from '@/lib/localized-note'
import { ChevronDown, FileUp, Pencil, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react'

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

export function SourcesTab({ data, onChange, role, selfId }: { data: Dashboard | null; onChange: () => void; role?: 'admin' | 'user' | 'anon'; selfId?: string }) {
  const { t, tr, lang, loc } = useI18n()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // сортировка и фильтр статуса: по умолчанию — «порядок добавления», строка источника
  // НЕ перемещается при включении/выключении (раньше список сортировался по enabled —
  // и каждый toggle перескакивал через список)
  const [sortBy, setSortBy] = useState<'created' | 'name' | 'priority' | 'rules' | 'updated'>('created')
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled' | 'error' | 'never'>('all')
  // пользователь управляет только СВОИМИ источниками (ownerId = selfId);
  // общие (ownerId = null) — только вкл/выкл и загрузка; админ — любой
  const canManage = (s: SourceItem) => role !== 'user' || (!!s.ownerId && !!selfId && s.ownerId === selfId)

  const sources = useMemo(() => {
    // в основном списке — только активные (не в корзине)
    let list = (data?.sources.list ?? []).filter((s) => !s.deletedAt)
    // фильтр статуса
    if (statusFilter === 'enabled') list = list.filter((s) => s.enabled)
    else if (statusFilter === 'disabled') list = list.filter((s) => !s.enabled)
    else if (statusFilter === 'error') list = list.filter((s) => s.status === 'error')
    else if (statusFilter === 'never') list = list.filter((s) => s.status === 'never' || !s.lastFetchAt)
    // поиск по названию и примечаниям (на двух языках)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.notes ?? '').toLowerCase().includes(q) ||
          (s.notesEn ?? '').toLowerCase().includes(q),
      )
    }
    const sorted = [...list]
    if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, loc))
    else if (sortBy === 'priority') sorted.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, loc))
    else if (sortBy === 'rules') sorted.sort((a, b) => b.ruleCount - a.ruleCount || a.name.localeCompare(b.name, loc))
    else if (sortBy === 'updated') sorted.sort((a, b) => new Date(b.lastFetchAt ?? 0).getTime() - new Date(a.lastFetchAt ?? 0).getTime())
    else sorted.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime())
    return sorted
  }, [data, search, sortBy, statusFilter, loc])

  const trash = useMemo(() => (data?.sources.list ?? []).filter((s) => !!s.deletedAt), [data])

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
      // диф загрузки: что изменилось vs предыдущей версии источника
      const diff = r.ok && r.diff
        ? (r.diff.unchanged
            ? t.messages.fetchOneNoChanges
            : tr(t.messages.fetchOneDiff, { a: r.diff.added, c: r.diff.changed, rm: r.diff.removed }))
        : ''
      setMsg(
        r.ok
          ? tr(t.messages.fetchOneOk, { name: s.name, n: r.count.toLocaleString(loc), diff, note: r.note ? `\n⚠ ${r.note}` : '' })
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
      // вердикт по изменениям: пересборка/переимпорт правил нужна только при наличии дифа
      const diff = (r.changesTotal ?? 0) === 0
        ? t.messages.fetchAllNoChanges
        : tr(t.messages.fetchAllDiff, { a: r.diff?.added ?? 0, c: r.diff?.changed ?? 0, rm: r.diff?.removed ?? 0, u: r.unchangedSources ?? 0 })
      setMsg(tr(t.messages.fetchAllDone, { ok: r.ok, failed: r.failed, diff, first: r.errors.length ? ' — ' + r.errors[0] : '' }))
      onChange()
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (s: SourceItem) => {
    setBusyId(s.id)
    try {
      await api.deleteSource(s.id)
      setMsg(tr(t.messages.sourceTrashed, { name: s.name }))
      onChange()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const restore = async (s: SourceItem) => {
    setBusyId(s.id)
    try {
      await api.restoreSource(s.id)
      setMsg(tr(t.messages.sourceRestored, { name: s.name }))
      onChange()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const purge = async (s: SourceItem) => {
    setBusyId(s.id)
    try {
      await api.purgeSource(s.id)
      setMsg(tr(t.messages.sourcePurged, { name: s.name }))
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
      : s.category === 'zeek-intel' ? t.sources.kinds.zeekIntel
      : s.category === 'misp' ? t.sources.kinds.misp
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
            {/* фильтр статуса и сортировка: положение строк стабильно —
                toggle вкл/выкл не перемещает источник */}
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
              <SelectTrigger className="w-44 bg-card border-input" title={t.sources.filterLabel} aria-label={t.sources.filterLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="all">{t.sources.filterAll}</SelectItem>
                <SelectItem value="enabled">{t.sources.filterEnabled}</SelectItem>
                <SelectItem value="disabled">{t.sources.filterDisabled}</SelectItem>
                <SelectItem value="error">{t.sources.filterError}</SelectItem>
                <SelectItem value="never">{t.sources.filterNever}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="w-48 bg-card border-input" title={t.sources.sortLabel} aria-label={t.sources.sortLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="created">{t.sources.sortCreated}</SelectItem>
                <SelectItem value="name">{t.sources.sortName}</SelectItem>
                <SelectItem value="priority">{t.sources.sortPriority}</SelectItem>
                <SelectItem value="rules">{t.sources.sortRules}</SelectItem>
                <SelectItem value="updated">{t.sources.sortUpdated}</SelectItem>
              </SelectContent>
            </Select>
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
                {sources.length === 0 && (
                  <TableRow className="border-border/60">
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-4">{t.sources.filterEmpty}</TableCell>
                  </TableRow>
                )}
                {sources.map((s) => {
                  const badgeKey = (s.badge && s.badge in BADGE_CLASSES ? s.badge : null) as BadgeKey | null
                  const note = pickLocalizedNote(s.notes, s.notesEn, lang)
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
                        {note && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{note}</p>}
                        {s.lastError && <p className="text-xs text-red-600 mt-0.5">{t.sources.errPrefix} {s.lastError}</p>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {kindLabel(s)}
                        {s.authType !== 'none' && <div className="text-emerald-600">{s.authType}</div>}
                      </TableCell>
                      <TableCell className="tabular-nums text-foreground">
                        {s.ruleCount ? s.ruleCount.toLocaleString(loc) : '—'}
                        {s.lastFetchAt && <FetchDiffLine s={s} />}
                      </TableCell>
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
                          {canManage(s) && <EditSourceDialog source={s} onSaved={() => onChange()} />}
                          {canManage(s) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 border-red-300 text-red-600"
                              title={t.sources.trash.moveToTrash}
                              disabled={busyId === s.id}
                              onClick={() => {
                                if (window.confirm(tr(t.sources.trash.confirmMove, { name: s.name }))) void remove(s)
                              }}
                            >
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

      <TrashCard trash={trash} busyId={busyId} onRestore={restore} onPurge={purge} />

      <AnalysisCard />
    </div>
  )
}

/** Диф последней загрузки источника (строка под количеством правил):
 *  +добавлено ~изменено −удалено; ноль — «без изменений», переимпорт правил
 *  в Suricata после такого обновления не требуется. */
function FetchDiffLine({ s }: { s: SourceItem }) {
  const { t, tr, loc } = useI18n()
  const a = s.diffAdded
  const c = s.diffChanged
  const rm = s.diffRemoved
  if (a + c + rm === 0) return <p className="text-[11px] text-muted-foreground mt-0.5">{t.sources.diffNone}</p>
  return (
    <p className="text-[11px] mt-0.5" title={tr(t.sources.diffTooltip, { a, c, rm })}>
      {a > 0 && <span className="text-emerald-700">+{a.toLocaleString(loc)} </span>}
      {c > 0 && <span className="text-amber-700">~{c.toLocaleString(loc)} </span>}
      {rm > 0 && <span className="text-red-600">−{rm.toLocaleString(loc)}</span>}
    </p>
  )
}

/** Корзина источников: восстановление и полное удаление */
function TrashCard({
  trash,
  busyId,
  onRestore,
  onPurge,
}: {
  trash: SourceItem[]
  busyId: string | null
  onRestore: (s: SourceItem) => void
  onPurge: (s: SourceItem) => void
}) {
  const { t, tr, lang, loc } = useI18n()
  const [open, setOpen] = useState(false)
  const trashT = t.sources.trash
  if (trash.length === 0) return null
  return (
    <Card className="bg-card border-red-200">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full text-left">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 text-red-700">
              <Trash2 className="h-4 w-4" />
              {trashT.title}
              <Badge variant="outline" className="border-red-300 text-red-600">{trash.length}</Badge>
              <ChevronDown className={`h-4 w-4 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
            </CardTitle>
            <CardDescription>{trashT.desc}</CardDescription>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>
            <div className="rounded-lg border border-border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">{trashT.colSource}</TableHead>
                    <TableHead className="text-muted-foreground">{trashT.colRules}</TableHead>
                    <TableHead className="text-muted-foreground">{trashT.colDeleted}</TableHead>
                    <TableHead className="text-right text-muted-foreground">{trashT.colActions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trash.map((s) => (
                    <TableRow key={s.id} className="border-border/60">
                      <TableCell>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground">{s.name}</span>
                          {s.builtin && <Badge variant="outline" className="border-input text-muted-foreground">{t.sources.builtinBadge}</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums text-foreground">{s.ruleCount.toLocaleString(loc)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{fmtTime(s.deletedAt, lang)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 border-input text-foreground"
                            disabled={busyId === s.id}
                            onClick={() => onRestore(s)}
                          >
                            <Undo2 className="h-3.5 w-3.5 mr-1" /> {trashT.restore}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 border-red-300 text-red-600"
                            disabled={busyId === s.id}
                            onClick={() => {
                              if (window.confirm(tr(trashT.confirmPurge, { name: s.name, n: s.ruleCount }))) void onPurge(s)
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1" /> {trashT.purge}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
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
    priority: '100', notes: '', notesEn: '', extraJson: '',
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
        notesEn: form.notesEn || null,
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
                  <SelectItem value="zeek-intel">{d.catZeekIntel}</SelectItem>
                  <SelectItem value="misp">{d.catMisp}</SelectItem>
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
                  <SelectItem value="misp">{d.authMisp}</SelectItem>
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
            <Label className="text-foreground">{d.notesRu}</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="bg-card border-input" />
          </div>
          <div>
            <Label className="text-foreground">{d.notesEn}</Label>
            <Input value={form.notesEn} onChange={(e) => setForm({ ...form, notesEn: e.target.value })} className="bg-card border-input" />
            <p className="text-xs text-muted-foreground mt-1">{d.notesHint}</p>
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
    notesEn: source.notesEn ?? '',
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
        notesEn: form.notesEn || null,
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
                  <SelectItem value="misp">{d.authMispShort}</SelectItem>
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
            <Label className="text-foreground">{d.notesRu}</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="bg-card border-input" />
          </div>
          <div>
            <Label className="text-foreground">{d.notesEn}</Label>
            <Input value={form.notesEn} onChange={(e) => setForm({ ...form, notesEn: e.target.value })} className="bg-card border-input" />
            <p className="text-xs text-muted-foreground mt-1">{d.notesHint}</p>
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
