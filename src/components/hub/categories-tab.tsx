'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { api, CategoriesState, CategoryItem, CategoryRuleRow, Dashboard } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { FolderTree, Layers3, Pencil, RefreshCw, Search, Table2 } from 'lucide-react'

/**
 * Раздел «Категории»: правила включённых источников группируются по classtype,
 * пользователь управляет категориями (включение/выключение в сборке,
 * переименование, скрытие) и отдельными правилами внутри категорий.
 */
export function CategoriesTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, loc } = useI18n()
  const c = t.categories
  const [state, setState] = useState<CategoriesState | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [rulesFor, setRulesFor] = useState<CategoryItem | null>(null)
  const [renameFor, setRenameFor] = useState<CategoryItem | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await api.categories())
    } catch (e) {
      setMsg((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const scan = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.categoriesScan()
      setMsg(tr(c.scanDone, { cats: r.categories, added: r.added, n: r.totalRules.toLocaleString(loc) }))
      await load()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const bulk = async (enabled: boolean) => {
    setBusy(true)
    try {
      await api.categoriesBulk(enabled)
      await load()
      onChange()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggleCat = async (cat: CategoryItem) => {
    if (!cat.id) return
    setBusy(true)
    try {
      await api.patchCategory(cat.id, { enabled: !cat.enabled })
      await load()
      onChange()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const hideCat = async (cat: CategoryItem) => {
    if (!cat.id) return
    setBusy(true)
    try {
      await api.patchCategory(cat.id, { hidden: true })
      await load()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const categories = (state?.categories ?? []).filter((cat) => {
    if (cat.hidden) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return cat.name.toLowerCase().includes(q) || (cat.label ?? '').toLowerCase().includes(q)
  })
  const disabledCats = (state?.categories ?? []).filter((x) => !x.enabled && !x.hidden).length

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto">
              <CardTitle className="text-base">{c.title}</CardTitle>
              <CardDescription>{c.desc}</CardDescription>
            </div>
            <Input
              placeholder={c.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 bg-card border-input"
            />
            <Button onClick={scan} disabled={busy} variant="outline" className="border-input text-foreground">
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busy ? 'animate-spin' : ''}`} /> {c.scan}
            </Button>
            <Button onClick={() => bulk(true)} disabled={busy || disabledCats === 0} variant="outline" className="border-input text-foreground">
              {c.enableAll}
            </Button>
            <Button onClick={() => bulk(false)} disabled={busy} variant="outline" className="border-input text-foreground">
              {c.disableAll}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {msg && <p className="text-sm mb-3 text-emerald-700 whitespace-pre-wrap">{msg}</p>}
          {state && (
            <div className="flex flex-wrap gap-2 mb-3">
              <Badge variant="outline" className="border-input text-foreground"><FolderTree className="h-3 w-3 mr-1" />{tr(c.badgeCats, { n: state.categories.filter((x) => !x.hidden).length })}</Badge>
              <Badge variant="outline" className="border-input text-foreground"><Layers3 className="h-3 w-3 mr-1" />{tr(c.badgeRules, { n: state.totalRules.toLocaleString(loc) })}</Badge>
              <Badge variant="outline" className="border-input text-foreground">{tr(c.badgeSources, { n: state.activeSources })}</Badge>
              {state.overridesOff > 0 && (
                <Badge variant="outline" className="border-amber-400 text-amber-700">{tr(c.badgeExcluded, { n: state.overridesOff.toLocaleString(loc) })}</Badge>
              )}
              {disabledCats > 0 && (
                <Badge variant="outline" className="border-red-300 text-red-600">{tr(c.badgeDisabled, { n: disabledCats })}</Badge>
              )}
            </div>
          )}
          <div className="rounded-lg border border-border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-12 text-muted-foreground">{c.colEnabled}</TableHead>
                  <TableHead className="text-muted-foreground">{c.colCategory}</TableHead>
                  <TableHead className="text-muted-foreground">{c.colRules}</TableHead>
                  <TableHead className="text-muted-foreground">{c.colSources}</TableHead>
                  <TableHead className="text-muted-foreground">{c.colDescription}</TableHead>
                  <TableHead className="text-right text-muted-foreground">{c.colActions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.length === 0 && (
                  <TableRow className="border-border/60">
                    <TableCell colSpan={6} className="text-muted-foreground py-6 text-center">
                      {c.noCategories}
                    </TableCell>
                  </TableRow>
                )}
                {categories.map((cat) => {
                  const displayName = cat.label || (cat.name === 'none' ? c.uncategorizedLabel : cat.name)
                  const desc = cat.name === 'none' ? c.uncategorizedDesc : (CLASSTYPE_HINTS[cat.name] ?? null)
                  return (
                    <TableRow key={cat.name} className="border-border/60">
                      <TableCell>
                        <Switch
                          checked={cat.enabled}
                          disabled={busy || !cat.id}
                          onCheckedChange={() => void toggleCat(cat)}
                        />
                      </TableCell>
                      <TableCell className="max-w-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground">{displayName}</span>
                          {cat.label && <code className="text-xs text-muted-foreground">{cat.name}</code>}
                          {!cat.id && <Badge variant="outline" className="border-amber-400 text-amber-700">{c.needsScan}</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums text-foreground">{cat.rules.toLocaleString(loc)}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{cat.sources}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{desc ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 border-input text-foreground"
                            disabled={!cat.id}
                            title={c.openRules}
                            onClick={() => setRulesFor(cat)}
                          >
                            <Table2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 border-input text-foreground"
                            disabled={!cat.id}
                            title={c.rename}
                            onClick={() => setRenameFor(cat)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 border-input text-muted-foreground"
                            disabled={!cat.id}
                            title={c.hide}
                            onClick={() => void hideCat(cat)}
                          >
                            ✕
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          {state && <p className="text-xs text-muted-foreground mt-3">{c.footnote}</p>}
        </CardContent>
      </Card>

      {rulesFor && (
        <CategoryRulesDialog
          cat={rulesFor}
          onClose={() => setRulesFor(null)}
          onToggled={() => { void load(); onChange() }}
        />
      )}
      {renameFor && (
        <RenameCategoryDialog
          cat={renameFor}
          onClose={() => setRenameFor(null)}
          onSaved={() => { setRenameFor(null); void load() }}
        />
      )}
    </div>
  )
}

/** Диалог «правила категории»: страница + поиск + выключатели правил */
function CategoryRulesDialog({ cat, onClose, onToggled }: { cat: CategoryItem; onClose: () => void; onToggled: () => void }) {
  const { t, tr, loc } = useI18n()
  const c = t.categories
  const [rows, setRows] = useState<CategoryRuleRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [busySid, setBusySid] = useState<number | null>(null)
  const perPage = 50

  const displayName = cat.label || (cat.name === 'none' ? c.uncategorizedLabel : cat.name)

  const loadPage = useCallback(async (p: number, query: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), perPage: String(perPage) })
      if (query.trim()) params.set('q', query.trim())
      const r = await api.categoryRules(cat.id!, params.toString())
      setRows(r.rules)
      setTotal(r.total)
    } catch {
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [cat.id])

  useEffect(() => {
    if (cat.id) void loadPage(page, q)
  }, [cat.id, page, q, loadPage])

  const setOverride = async (row: CategoryRuleRow, enabled: boolean) => {
    setBusySid(row.sid)
    try {
      await api.setRuleOverride(cat.id!, row.sid, enabled)
      setRows((prev) => prev.map((r) => (r.sid === row.sid ? { ...r, overrideEnabled: enabled } : r)))
      onToggled()
    } finally {
      setBusySid(null)
    }
  }

  const pages = Math.max(1, Math.ceil(total / perPage))
  // правило считаем выключенным, если override выключает ИЛИ категория выключена
  const ruleEffective = (row: CategoryRuleRow) => (row.overrideEnabled ?? true) && cat.enabled

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="bg-card border-border text-foreground max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            {tr(c.rulesTitle, { name: displayName })}
            {!cat.enabled && <Badge variant="outline" className="border-red-300 text-red-600">{c.catDisabledBadge}</Badge>}
          </DialogTitle>
          <DialogDescription>{c.rulesDesc}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1) }}
              placeholder={c.rulesSearch}
              className="w-64 pl-8 bg-card border-input"
            />
          </div>
          <span className="text-sm text-muted-foreground">{tr(c.rulesFound, { n: total.toLocaleString(loc) })}</span>
        </div>
        <div className="rounded-lg border border-border overflow-x-auto max-h-96 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="w-12 text-muted-foreground">{c.colEnabled}</TableHead>
                <TableHead className="text-muted-foreground">SID</TableHead>
                <TableHead className="text-muted-foreground">{c.colMsg}</TableHead>
                <TableHead className="text-muted-foreground">{c.colSourceShort}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow className="border-border/60"><TableCell colSpan={4} className="text-muted-foreground py-4 text-center">{c.loading}</TableCell></TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow className="border-border/60"><TableCell colSpan={4} className="text-muted-foreground py-4 text-center">{c.noRules}</TableCell></TableRow>
              )}
              {!loading && rows.map((row) => (
                <TableRow key={row.id} className="border-border/60">
                  <TableCell>
                    <Switch
                      checked={ruleEffective(row)}
                      disabled={busySid === row.sid}
                      onCheckedChange={(v) => void setOverride(row, v)}
                    />
                  </TableCell>
                  <TableCell className="tabular-nums text-foreground">{row.sid}</TableCell>
                  <TableCell className="max-w-md">
                    <span className="text-foreground line-clamp-1">{row.msg ?? '—'}</span>
                    {row.overrideEnabled === false && <Badge variant="outline" className="border-amber-400 text-amber-700 mt-0.5">{c.ruleOffBadge}</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{row.sourceName}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter className="items-center gap-3 sm:justify-between">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="border-input" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>←</Button>
            <span className="text-sm text-muted-foreground">{page} / {pages}</span>
            <Button size="sm" variant="outline" className="border-input" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>→</Button>
          </div>
          <Button variant="outline" className="border-input" onClick={onClose}>{c.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Диалог переименования категории (label) */
function RenameCategoryDialog({ cat, onClose, onSaved }: { cat: CategoryItem; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  const c = t.categories
  const [label, setLabel] = useState(cat.label ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    if (!cat.id) return
    setBusy(true)
    setErr(null)
    try {
      await api.patchCategory(cat.id, { label: label.trim() || null })
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="bg-card border-border text-foreground max-w-md">
        <DialogHeader>
          <DialogTitle>{c.renameTitle}</DialogTitle>
          <DialogDescription className="break-all">{cat.name}</DialogDescription>
        </DialogHeader>
        <div>
          <Label className="text-foreground">{c.renameLabel}</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="bg-card border-input" placeholder={cat.name === 'none' ? c.uncategorizedLabel : cat.name} />
          <p className="text-xs text-muted-foreground mt-1">{c.renameHint}</p>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <DialogFooter>
          <Button variant="outline" className="border-input" onClick={onClose}>{c.close}</Button>
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={save} disabled={busy}>{c.saveRename}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// локальная копия подсказок (клиентский компонент не тянет серверный categories.ts)
const CLASSTYPE_HINTS: Record<string, string> = {
  'attempted-admin': 'попытка компрометации с правами администратора',
  'attempted-user': 'попытка компрометации пользовательских прав',
  'attempted-recon': 'разведка (recon)',
  'successful-admin': 'успешная компрометация с правами администратора',
  'successful-user': 'успешная компрометация пользовательских прав',
  'web-application-attack': 'атака на веб-приложение',
  'web-application-activity': 'активность на веб-приложение',
  'trojan-activity': 'активность троянского ПО / C&C',
  'shellcode-detect': 'обнаружение шеллкода',
  'policy-violation': 'нарушение политики',
  'bad-unknown': 'подозрительная/неизвестная активность',
  'default-login-attempt': 'попытка входа с учётными данными по умолчанию',
  'denial-of-service': 'отказ в обслуживании (DoS)',
  'misc-attack': 'прочая атака',
  'misc-activity': 'прочая активность',
  'malware-c2': 'командный сервер (C&C) вредоносного ПО',
  'coin-mining': 'майнинг криптовалюты',
  'domain-c2': 'C&C-домен',
  'indicator-compromise': 'признак компрометации',
  'indicator-scan': 'сканирование',
  'network-scan': 'сканирование сети',
  'protocol-command-decode': 'разбор команды протокола',
  'non-standard-protocol': 'нестандартный протокол',
  'suspicious-filename-detect': 'подозрительное имя файла',
  'suspicious-login': 'подозрительный вход',
  'unusual-client-port-usage': 'необычный клиентский порт',
  'file-format': 'известный формат файла',
  'unknown': 'неизвестная активность',
  'potentially-bad-traffic': 'потенциально вредоносный трафик',
  'known-issue': 'известная проблема',
  'exploit': 'эксплойт',
}
