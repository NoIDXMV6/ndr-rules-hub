'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, fmtTime } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { RefreshCw } from 'lucide-react'

export function LogsTab() {
  const { t, lang } = useI18n()
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
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          {t.logs.title}
          <Button size="sm" variant="outline" className="ml-auto border-input text-foreground" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> {t.logs.refresh}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-border divide-y divide-border max-h-[65vh] overflow-y-auto">
          {logs.length === 0 && <p className="text-sm text-muted-foreground p-4">{t.logs.empty}</p>}
          {logs.map((l) => (
            <div key={l.id} className="flex items-start gap-2.5 px-3 py-2 text-sm">
              <span className="text-muted-foreground tabular-nums text-xs mt-0.5 shrink-0 w-28">{new Date(l.ts).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US')}</span>
              <Badge
                variant="outline"
                className={
                  l.level === 'success' ? 'border-emerald-300 text-emerald-700 shrink-0' :
                  l.level === 'error' ? 'border-red-300 text-red-600 shrink-0' :
                  l.level === 'warn' ? 'border-amber-300 text-amber-700 shrink-0' :
                  'border-input text-muted-foreground shrink-0'
                }
              >
                {l.scope}
              </Badge>
              <span className="text-foreground break-all">{l.message}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
