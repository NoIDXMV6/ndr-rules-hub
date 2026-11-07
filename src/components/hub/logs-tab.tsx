'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, fmtTime } from '@/components/hub/api'
import { RefreshCw } from 'lucide-react'

export function LogsTab() {
  const [logs, setLogs] = useState<Array<{ id: number; ts: string; level: string; scope: string; message: string }>>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.logs(300)
      setLogs(r.logs)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          Журнал событий
          <Button size="sm" variant="outline" className="ml-auto border-zinc-700 text-zinc-300" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Обновить
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/70 max-h-[65vh] overflow-y-auto">
          {logs.length === 0 && <p className="text-sm text-zinc-500 p-4">Событий пока нет.</p>}
          {logs.map((l) => (
            <div key={l.id} className="flex items-start gap-2.5 px-3 py-2 text-sm">
              <span className="text-zinc-500 tabular-nums text-xs mt-0.5 shrink-0 w-28">{new Date(l.ts).toLocaleString('ru-RU')}</span>
              <Badge
                variant="outline"
                className={
                  l.level === 'success' ? 'border-emerald-700 text-emerald-400 shrink-0' :
                  l.level === 'error' ? 'border-red-700 text-red-400 shrink-0' :
                  l.level === 'warn' ? 'border-amber-700 text-amber-400 shrink-0' :
                  'border-zinc-700 text-zinc-400 shrink-0'
                }
              >
                {l.scope}
              </Badge>
              <span className="text-zinc-300 break-all">{l.message}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
