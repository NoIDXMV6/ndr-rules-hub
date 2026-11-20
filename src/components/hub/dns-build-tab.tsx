'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «DNS списки → Сборка и экспорт»: сборка итогового списка
// заблокированных доменов (формат, имя файла, ключ отдачи), прогресс,
// журнал сборки и сведения о последней сборке.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, fmtSize, fmtTime, type Dashboard, type DnsBuildProgressInfo, type DomainBuildItem } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Building2, Database, Download } from 'lucide-react'

export function DnsBuildTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, lang, loc } = useI18n()
  const [build, setBuild] = useState<DomainBuildItem | null>(null)
  const [progress, setProgress] = useState<DnsBuildProgressInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    void api.dns.lastBuild().then((r) => setBuild(r.build)).catch(() => undefined)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const startPoll = () => {
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
  }

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
  // адрес отдачи собирается из адресной строки браузера (SSR-безопасно)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-foreground">{t.dns.buildCardTitle}</CardTitle>
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
