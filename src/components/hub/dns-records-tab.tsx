'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «DNS списки → Записи»: поиск домена по всем источникам сразу,
// дубликаты (домен в нескольких списках) и ручные решения по конкретному
// домену — по аналогии с поиском правил.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, type DomainRecordRow } from '@/components/hub/api'
import { RstCheckDialog } from '@/components/hub/rst-check-dialog'
import { useI18n } from '@/lib/i18n'
import { Ban, Database, RefreshCw, Search, ShieldBan, ShieldCheck } from 'lucide-react'

export function DnsRecordsTab() {
  const { t, tr, loc } = useI18n()
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<DomainRecordRow[]>([])
  const [dups, setDups] = useState<Array<{ domain: string; sources: number }>>([])
  const [total, setTotal] = useState<number | null>(null)
  const [totalCapped, setTotalCapped] = useState(false)
  const [mode, setMode] = useState<'search' | 'dups'>('search')
  const [busy, setBusy] = useState(false)
  const [searched, setSearched] = useState(false)
  // проверка домена через RST Cloud (IoC Lookup / Noise Control / Whois)
  const [rstDomain, setRstDomain] = useState<string | null>(null)

  const run = useCallback(async (q: string, dup: boolean) => {
    setBusy(true)
    try {
      const r = await api.dns.records({ search: q || undefined, duplicates: dup })
      setRows(r.rows ?? [])
      setDups(r.duplicates ?? [])
      setTotal(r.total ?? null)
      setTotalCapped(r.totalCapped ?? false)
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
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">{t.dns.recordsCardTitle}</CardTitle>
          <CardDescription>{t.dns.recordsCardDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
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
          {searched && <p className="text-xs text-muted-foreground">{total !== null ? tr(t.dns.rowsCount, { n: `${total.toLocaleString(loc)}${totalCapped ? '+' : ''}` }) : ''}</p>}
          {searched && mode === 'dups' && (
            <div className="rounded-lg border border-border p-3">
              <p className="text-sm text-foreground mb-2">{t.dns.dupTitle}</p>
              {dups.length === 0 ? <p className="text-sm text-muted-foreground">{t.dns.dupEmpty}</p> : (
                <div className="flex flex-wrap gap-1.5">
                  {dups.slice(0, 50).map((d) => (
                    <button key={d.domain} onClick={() => { setSearch(d.domain); setMode('search'); void run(d.domain, false) }} className="rounded border border-input px-2 py-0.5 text-xs text-foreground hover:bg-muted">
                      {d.domain} <span className="text-muted-foreground">×{d.sources}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {searched && rows.length === 0 && mode === 'search' && <p className="text-sm text-muted-foreground">{t.dns.emptyRecords}</p>}
          {rows.length > 0 && (
            <div className="rounded-lg border border-border">
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
                            <Button variant="ghost" size="sm" title={t.dns.rstCheckBtn} onClick={() => setRstDomain(r.domain)} className="text-sky-600 hover:text-sky-700">
                              <ShieldCheck className="h-4 w-4" />
                            </Button>
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
            </div>
          )}
          {searched && <p className="text-[11px] text-muted-foreground">{t.dns.overrideNeedRebuild}</p>}
        </CardContent>
      </Card>
      {rstDomain && <RstCheckDialog domain={rstDomain} onClose={() => setRstDomain(null)} />}
    </div>
  )
}
