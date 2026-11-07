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
import { api, Dashboard, fmtSize, fmtTime, SourceItem } from '@/components/hub/api'
import { ChevronDown, Download, FileUp, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'

const BADGE_STYLES: Record<string, { label: string; cls: string }> = {
  recommended: { label: 'рекомендуется', cls: 'border-emerald-500 text-emerald-700' },
  duplicate: { label: 'дубликат', cls: 'border-amber-500 text-amber-700' },
  legacy: { label: 'устарел', cls: 'border-zinc-300 text-muted-foreground' },
  paid: { label: 'платный', cls: 'border-violet-400 text-violet-700' },
  converter: { label: 'конвертер', cls: 'border-sky-400 text-sky-700' },
  new: { label: 'новый', cls: 'border-lime-400 text-lime-700' },
  unavailable: { label: 'недоступен', cls: 'border-red-300 text-red-600' },
}

export function SourcesTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
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
    setMsg(`Загрузка «${s.name}»…`)
    try {
      const r = await api.fetchSource(s.id)
      setMsg(r.ok ? `«${s.name}»: загружено ${r.count.toLocaleString('ru-RU')} правил` : `Ошибка: ${r.error}`)
      onChange()
    } catch (e) {
      setMsg(`Ошибка: ${(e as Error).message}`)
    } finally {
      setBusyId(null)
    }
  }

  const fetchAll = async () => {
    setBusyId('all')
    setMsg('Обновление всех включённых источников…')
    try {
      const r = await api.fetchAll()
      setMsg(`Обновлено успешно: ${r.ok}, с ошибками: ${r.failed}${r.errors.length ? ' — ' + r.errors[0] : ''}`)
      onChange()
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (s: SourceItem) => {
    setBusyId(s.id)
    try {
      await api.deleteSource(s.id)
      setMsg(`Источник «${s.name}» удалён`)
      onChange()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto">
              <CardTitle className="text-base">Каталог источников правил</CardTitle>
              <CardDescription>
                Официальные и общественные наборы + конвертеры списков индикаторов. Включайте нужные и обновляйте.
              </CardDescription>
            </div>
            <Input
              placeholder="Поиск по названию…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 bg-card border-input"
            />
            <Button onClick={fetchAll} disabled={busyId !== null} variant="outline" className="border-input text-foreground">
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busyId === 'all' ? 'animate-spin' : ''}`} /> Обновить все
            </Button>
            <AddSourceDialog onCreated={() => { setMsg('Источник добавлен'); onChange() }} />
          </div>
        </CardHeader>
        <CardContent>
          {msg && <p className="text-sm mb-3 text-emerald-700">{msg}</p>}
          <div className="rounded-lg border border-border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-12 text-muted-foreground">Вкл</TableHead>
                  <TableHead className="text-muted-foreground">Источник</TableHead>
                  <TableHead className="text-muted-foreground">Тип</TableHead>
                  <TableHead className="text-muted-foreground">Правил</TableHead>
                  <TableHead className="text-muted-foreground">Приоритет</TableHead>
                  <TableHead className="text-muted-foreground">Статус</TableHead>
                  <TableHead className="text-muted-foreground">Обновлён</TableHead>
                  <TableHead className="text-right text-muted-foreground">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((s) => {
                  const badge = s.badge ? BADGE_STYLES[s.badge] : null
                  return (
                    <TableRow key={s.id} className="border-border/60">
                      <TableCell>
                        <Switch checked={s.enabled} onCheckedChange={() => toggle(s)} disabled={busyId === s.id} />
                      </TableCell>
                      <TableCell className="max-w-md">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground">{s.name}</span>
                          {badge && <Badge variant="outline" className={badge.cls}>{badge.label}</Badge>}
                        </div>
                        {s.notes && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.notes}</p>}
                        {s.lastError && <p className="text-xs text-red-600 mt-0.5">Ошибка: {s.lastError}</p>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {s.kind === 'local' ? 'локальный' : s.category === 'ip-list' ? 'IP-список → правила' : s.category === 'domain-list' ? 'домены → правила' : s.kind === 'tarball' ? 'архив' : 'ruleset'}
                        {s.authType !== 'none' && <div className="text-emerald-600">{s.authType === 'oinkcode' ? 'oinkcode' : s.authType}</div>}
                      </TableCell>
                      <TableCell className="tabular-nums text-foreground">{s.ruleCount ? s.ruleCount.toLocaleString('ru-RU') : '—'}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{s.priority}</TableCell>
                      <TableCell>
                        {s.status === 'ok' && <Badge className="bg-emerald-50 text-emerald-700 border border-emerald-300">ОК</Badge>}
                        {s.status === 'error' && <Badge className="bg-red-50 text-red-600 border border-red-300">ошибка</Badge>}
                        {s.status === 'never' && <Badge variant="outline" className="border-input text-muted-foreground">не загружался</Badge>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{fmtTime(s.lastFetchAt)}</TableCell>
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
  const [open, setOpen] = useState(false)
  return (
    <Card className="bg-card border-border">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full text-left">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FileUp className="h-4 w-4 text-primary" />
              Анализ архивов snort.org (данные реального разбора 5 архивов, ~322 МБ)
              <ChevronDown className={`h-4 w-4 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
            </CardTitle>
            <CardDescription>Какие архивы нужны, какие дубликаты, что совместимо с Suricata</CardDescription>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
                <p className="font-semibold text-emerald-800">✅ snortrules-snapshot-3200.tar.gz — основной источник</p>
                <p className="text-muted-foreground mt-1">53 237 правил / 52 680 уникальных SID. Зарегистрированный набор Snort 3 (Talos). Скачивается по oinkcode. Классический синтаксис, совместим с Suricata (исключить keystore и пр. — делается фильтром совместимости).</p>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="font-semibold text-amber-800">♻️ Talos_LightSPD.tar.gz — дубликат № 1</p>
                <p className="text-muted-foreground mt-1">53 270 правил. Пересечение со snapshot-3200: 52 680 из 52 680 SID (100%). Тот же набор в другом развёртывании. Держать не нужно — включите один из двух.</p>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="font-semibold text-amber-800">♻️ snortrules-snapshot-29200.tar.gz — устаревший Snort 2</p>
                <p className="text-muted-foreground mt-1">16 035 правил. 15 216 SID уже есть в Snort3-наборе. so_rules (бинарники) и preproc-правила не работают в Suricata. Оставьте только если нет доступа к Snort 3.</p>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="font-semibold text-amber-800">♻️ snort3-community-rules.tar.gz и community-rules.tar.gz — дубликаты</p>
                <p className="text-muted-foreground mt-1">4 026 и 568 правил — бесплатные подмножества зарегистрированных наборов (4 017 и 560 SID совпадают). Нужны только без oinkcode/подписки.</p>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Пересечения вычислены фактически: парсинг SID каждого архива (см. журнал и вкладку «Сборка»). Дедупликация в сборщике устраняет любые оставшиеся пересечения автоматически.
            </p>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

function AddSourceDialog({ onCreated }: { onCreated: () => void }) {
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
          <Plus className="h-4 w-4 mr-1.5" /> Добавить источник
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border text-foreground max-w-lg">
        <DialogHeader>
          <DialogTitle>Новый источник</DialogTitle>
          <DialogDescription>URL ruleset/архива или список индикаторов (конвертер)</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-foreground">Название</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bg-card border-input" placeholder="Например: My custom feed" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-foreground">Тип содержимого</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="ruleset">ruleset (.rules)</SelectItem>
                  <SelectItem value="tarball">архив tar.gz с .rules</SelectItem>
                  <SelectItem value="ip-list">IP-список → конвертер</SelectItem>
                  <SelectItem value="domain-list">список доменов → конвертер</SelectItem>
                  <SelectItem value="url-list">список URL → конвертер</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">Как получать</Label>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="url">по URL</SelectItem>
                  <SelectItem value="tarball">архив по URL</SelectItem>
                  <SelectItem value="local">локальный путь/файл</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.kind !== 'local' && (
            <div>
              <Label className="text-foreground">URL</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="bg-card border-input" placeholder="https://…" />
            </div>
          )}
          {form.kind === 'local' && (
            <div>
              <Label className="text-foreground">Локальный путь (файл .rules / .tar.gz / каталог)</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="bg-card border-input" placeholder="/data/archives/my.rules" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-foreground">Авторизация</Label>
              <Select value={form.authType} onValueChange={(v) => setForm({ ...form, authType: v })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="none">без авторизации</SelectItem>
                  <SelectItem value="oinkcode">oinkcode (snort.org)</SelectItem>
                  <SelectItem value="authkey">auth-key (query-параметр)</SelectItem>
                  <SelectItem value="basic">Basic (в extraJson)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">Приоритет (меньше = главнее)</Label>
              <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="bg-card border-input" />
            </div>
          </div>
          <div>
            <Label className="text-foreground">extraJson — параметры конвертера/авторизации (необязательно)</Label>
            <Textarea
              value={form.extraJson}
              onChange={(e) => setForm({ ...form, extraJson: e.target.value })}
              className="bg-card border-input font-mono text-xs"
              rows={3}
              placeholder='{"sidStart":1101000,"msgPrefix":"MY-FEED","perRule":500,"oinkcode":"…"}'
            />
          </div>
          <div>
            <Label className="text-foreground">Примечание</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="bg-card border-input" />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" className="border-input" onClick={() => setOpen(false)}>Отмена</Button>
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={submit} disabled={!form.name}>Создать</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditSourceDialog({ source, onSaved }: { source: SourceItem; onSaved: () => void }) {
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
          <DialogTitle>Редактирование источника</DialogTitle>
          <DialogDescription className="break-all">{source.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-foreground">Название</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="bg-card border-input" />
          </div>
          <div>
            <Label className="text-foreground">URL / путь</Label>
            <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="bg-card border-input font-mono text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-foreground">Авторизация</Label>
              <Select value={form.authType} onValueChange={(v) => setForm({ ...form, authType: v })}>
                <SelectTrigger className="bg-card border-input"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="none">без авторизации</SelectItem>
                  <SelectItem value="oinkcode">oinkcode (snort.org)</SelectItem>
                  <SelectItem value="authkey">auth-key</SelectItem>
                  <SelectItem value="basic">Basic</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-foreground">Приоритет</Label>
              <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="bg-card border-input" />
            </div>
          </div>
          <div>
            <Label className="text-foreground">extraJson</Label>
            <Textarea value={form.extraJson} onChange={(e) => setForm({ ...form, extraJson: e.target.value })} className="bg-card border-input font-mono text-xs" rows={3} />
            <p className="text-xs text-muted-foreground mt-1">
              Возможности: oinkcode, authKey, basicUser/basicPassword, sidStart, action (alert/drop), msgPrefix, perRule, maxRules, subPath (папка внутри архива)
            </p>
          </div>
          <div>
            <Label className="text-foreground">Примечание</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="bg-card border-input" />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" className="border-input" onClick={() => setOpen(false)}>Отмена</Button>
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={submit}>Сохранить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
