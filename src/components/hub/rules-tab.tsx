'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { api, Dashboard, RuleRow } from '@/components/hub/api'
import { ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react'

export function RulesTab({ data }: { data: Dashboard | null }) {
  const [rules, setRules] = useState<RuleRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [sid, setSid] = useState('')
  const [q, setQ] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const perPage = 50

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const sp = new URLSearchParams({ page: String(page), perPage: String(perPage) })
      if (sid) sp.set('sid', sid)
      if (q) sp.set('q', q)
      if (sourceId) sp.set('sourceId', sourceId)
      const r = await api.rules(sp.toString())
      setRules(r.rules)
      setTotal(r.total)
    } finally {
      setLoading(false)
    }
  }, [page, sid, q, sourceId])

  useEffect(() => {
    void load()
  }, [load])

  const pages = Math.max(1, Math.ceil(total / perPage))

  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          База правил
          <Badge variant="outline" className="border-zinc-700 text-zinc-400">{total.toLocaleString('ru-RU')} записей</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            <Input
              placeholder="SID…"
              value={sid}
              onChange={(e) => { setSid(e.target.value.replace(/\D/g, '')); setPage(1) }}
              className="w-32 bg-zinc-950 border-zinc-800"
            />
            <Input
              placeholder="Поиск в msg…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1) }}
              className="w-52 bg-zinc-950 border-zinc-800"
            />
            <select
              value={sourceId}
              onChange={(e) => { setSourceId(e.target.value); setPage(1) }}
              className="h-9 rounded-md bg-zinc-950 border border-zinc-800 px-2 text-sm text-zinc-200"
            >
              <option value="">все источники</option>
              {(data?.sources.list ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-zinc-800 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="w-20 text-zinc-400">SID</TableHead>
                <TableHead className="w-14 text-zinc-400">Rev</TableHead>
                <TableHead className="w-16 text-zinc-400">Действие</TableHead>
                <TableHead className="text-zinc-400">Сообщение</TableHead>
                <TableHead className="text-zinc-400">Источник</TableHead>
                <TableHead className="w-24 text-zinc-400">Suricata</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <Fragment key={r.id}>
                  <TableRow className="border-zinc-800/70">
                    <TableCell className="font-mono text-emerald-400 tabular-nums">{r.sid}</TableCell>
                    <TableCell className="tabular-nums text-zinc-400">{r.rev}</TableCell>
                    <TableCell><Badge variant="outline" className="border-zinc-700 text-zinc-300">{r.action}</Badge></TableCell>
                    <TableCell className="text-zinc-200 max-w-md truncate">{r.msg ?? '—'}</TableCell>
                    <TableCell className="text-xs text-zinc-400 max-w-52 truncate">{r.sourceName}</TableCell>
                    <TableCell>
                      {r.suricataOk ? (
                        <Badge className="bg-emerald-950 text-emerald-400 border border-emerald-800">совместимо</Badge>
                      ) : (
                        <Badge className="bg-amber-950 text-amber-400 border border-amber-800" title={r.compatNotes ?? ''}>внимание</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" className="h-7 text-zinc-400" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                        {expanded === r.id ? <ChevronDown className="h-4 w-4 rotate-180" /> : <Search className="h-3.5 w-3.5" />}
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expanded === r.id && (
                    <TableRow className="border-zinc-800/70">
                      <TableCell colSpan={7}>
                        <pre className="text-xs text-zinc-300 bg-zinc-950 rounded p-3 overflow-x-auto whitespace-pre-wrap">{r.raw}</pre>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
              {rules.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-zinc-500 py-10">
                    Правил не найдено. Обновите источники на вкладке «Источники».
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center gap-2 justify-end pt-3">
          <span className="text-xs text-zinc-500 mr-auto">
            стр. {page} из {pages}
          </span>
          <Button size="sm" variant="outline" className="border-zinc-700" disabled={page <= 1} onClick={() => setPage(1)}>««</Button>
          <Button size="sm" variant="outline" className="border-zinc-700" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="border-zinc-700" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="border-zinc-700" disabled={page >= pages} onClick={() => setPage(pages)}>»»</Button>
        </div>
      </CardContent>
    </Card>
  )
}
