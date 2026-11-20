'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «DNS списки → Сборка и экспорт» — зеркально «Сборке итогового набора»
// (build-tab.tsx): кнопка сборки в шапке, настройки файла списка, прогресс с
// фазой и терминальным журналом, бейджи последней сборки, сетка показателей,
// таблица по источникам, адрес отдачи и карточка файлов каталога экспорта.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, Dashboard, DnsBuildProgressInfo, DomainBuildItem, DnsExportFile, fmtSize, fmtTime } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { Building2, Database, Download, FileArchive } from 'lucide-react'

export function DnsBuildTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const { t, tr, lang, loc } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [build, setBuild] = useState<DomainBuildItem | null>(null)
  const [files, setFiles] = useState<DnsExportFile[]>([])
  // прогресс DNS-сборки: POST /api/dns/build запускает сборку фоном и сразу
  // возвращается, статус опрашивается из GET /api/dns/build/progress
  const [prog, setProg] = useState<DnsBuildProgressInfo | null>(null)
  const logRef = useRef<HTMLPreElement>(null)

  const loadAll = useCallback(async () => {
    try {
      const r = await api.dns.lastBuild()
      setBuild(r.build)
      setFiles(r.files ?? [])
    } catch {
      setBuild(null)
      setFiles([])
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // если DNS-сборка уже идёт (запущена другим окном или по cron) — сразу показываем прогресс
  useEffect(() => {
    api.dns.buildProgress().then((r) => {
      if (r.progress?.active) setProg(r.progress)
    }).catch(() => undefined)
  }, [])

  // автопрокрутка журнала сборки
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [prog?.log.length])

  const startBuild = async () => {
    setBusy(true)
    setMsg(null)
    try {
      // запуск фоном + опрос прогресса (фаза/процент/журнал) до завершения сборки
      const res = await api.dns.buildWait((p) => setProg(p))
      if (res?.ok) {
        setMsg({ text: tr(t.dns.buildDone, { n: res.total?.toLocaleString(loc) ?? '—', file: res.fileName ?? '—' }), ok: true })
      } else {
        setMsg({ text: tr(t.dns.buildErr, { err: res?.error ?? '—' }), ok: false })
      }
      onChange()
      await loadAll()
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false })
    } finally {
      setBusy(false)
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
  // прогресс: сборка, запущенная из этого окна, или фоновая (cron/другое окно)
  const showProg = !!prog && (busy || prog.active)
  // адрес отдачи собирается из адресной строки браузера (SSR-безопасно)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const stats = build?.stats ?? {}

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <CardTitle className="text-base">{t.dns.buildCardTitle}</CardTitle>
              <CardDescription>{t.dns.cronNote}</CardDescription>
            </div>
            <Button onClick={startBuild} disabled={busy} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Building2 className={`h-4 w-4 mr-1.5 ${busy ? 'animate-pulse' : ''}`} /> {busy ? t.dns.building : t.dns.buildBtn}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* итоговый файл: формат / имя / ключ отдачи */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
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
            <div>
              <Label className="text-foreground">{t.dns.serveTokenLabel}</Label>
              <Input type="password" defaultValue={settings.dnsServeToken ?? ''} onBlur={(e) => void saveServeToken(e.target.value.trim())} className="bg-card border-input mt-1" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-2 mb-4">{t.dns.serveTokenHint}</p>
          {showProg && prog && (
            <div className="mb-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium text-foreground">
                  {tr(t.dns.progTitle, { stage: stageLabel(t, prog.stage) })}
                </span>
                <span className="text-muted-foreground tabular-nums">{prog.percent}%</span>
              </div>
              <Progress value={prog.percent} />
              <pre
                ref={logRef}
                className="rounded-lg border border-border bg-zinc-950 text-zinc-100 p-3 text-xs font-mono max-h-48 overflow-auto whitespace-pre-wrap"
              >
                {(prog.log.map((l) => l.msg).join('\n')) || '…'}
              </pre>
            </div>
          )}
          {msg && <p className={`text-sm mb-3 ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
          {build ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline" className="border-input text-foreground">{fmtTime(build.createdAt, lang)}</Badge>
                <Badge variant="outline" className="border-input text-foreground"><Database className="h-3 w-3 mr-1 inline" />{tr(t.dns.badgeBuildDomains, { n: build.totalDomains.toLocaleString(loc) })}</Badge>
                <Badge variant="outline" className="border-input text-foreground">{fmtSize(build.sizeBytes, lang)}</Badge>
                <Badge variant="outline" className="border-input text-foreground">{build.fileName}</Badge>
                <Badge variant="outline" className="border-input text-muted-foreground font-mono" title={build.sha256}>{build.sha256.slice(0, 12)}…</Badge>
                <Badge variant="outline" className={build.source === 'cron' ? 'border-sky-700 text-sky-700' : 'border-input text-muted-foreground'}>{build.source === 'cron' ? t.build.bySchedule : t.build.manual}</Badge>
                <a href="/api/dns/export" download className="ml-auto">
                  <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground">
                    <Download className="h-4 w-4 mr-1.5" /> {t.dns.download}
                  </Button>
                </a>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
                <MiniStat label={t.dns.statInput} value={stats.totalInput?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.dns.statDup} value={stats.duplicateByDomain?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.dns.statAllow} value={stats.allowedRemoved?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.dns.statCat} value={stats.categoryRemoved?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.dns.statOverride} value={stats.overrideRemoved?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.dns.statTld} value={stats.tldCount?.toLocaleString(loc) ?? '—'} />
                <MiniStat label={t.dns.statFinal} value={build.totalDomains.toLocaleString(loc)} />
              </div>
              <div className="rounded-lg border border-border overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0">
                    <tr className="text-muted-foreground text-left">
                      <th className="px-3 py-2 font-medium">{t.dns.thSource}</th>
                      <th className="px-3 py-2 font-medium">{t.dns.thTotal}</th>
                      <th className="px-3 py-2 font-medium">{t.dns.thKept}</th>
                      <th className="px-3 py-2 font-medium">{t.dns.thDup}</th>
                      <th className="px-3 py-2 font-medium">{t.dns.thAllowed}</th>
                      <th className="px-3 py-2 font-medium">{t.dns.thCat}</th>
                      <th className="px-3 py-2 font-medium">{t.dns.thOverride}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stats.perSource ?? {}).map(([name, st]) => (
                      <tr key={name} className="border-t border-border/60 text-foreground">
                        <td className="px-3 py-1.5 max-w-72 truncate">{name}</td>
                        <td className="px-3 py-1.5 tabular-nums">{st.total.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-emerald-700">{st.kept.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-amber-700">{st.droppedDuplicate.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-amber-700">{st.droppedAllowed.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-amber-700">{st.droppedCategory.toLocaleString(loc)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-red-600">{st.droppedOverride.toLocaleString(loc)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pt-3 border-t border-border/60">
                <p className="text-xs text-muted-foreground mb-1">{t.dns.serveUrlTitle}</p>
                <code className="block rounded border border-border bg-muted/60 px-2 py-1 text-xs text-foreground break-all">{origin}/api/dns/export</code>
                <p className="text-[11px] text-muted-foreground mt-1">{t.dns.tokensHint}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t.dns.noBuildFull}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileArchive className="h-4 w-4 text-primary" /> {t.dns.filesTitle}
          </CardTitle>
          <CardDescription>{t.dns.filesDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.dns.noFiles}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {files.map((f) => (
                <li key={f.name} className="flex flex-wrap gap-x-4 text-foreground border-b border-border/60 py-1">
                  <code className="text-emerald-700">{f.name}</code>
                  <span className="text-muted-foreground">{fmtSize(f.size, lang)}</span>
                  <span className="text-muted-foreground">{fmtTime(f.mtime, lang)}</span>
                  <a href="/api/dns/export" download className="ml-auto text-emerald-700 hover:underline text-xs">{t.dns.latestFile}</a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Локализованное название фазы DNS-сборки (коды фаз — из dns-progress.ts) */
function stageLabel(t: ReturnType<typeof useI18n>['t'], stage: string): string {
  const map = t.dns.progStage as Record<string, string | undefined>
  return map[stage] ?? stage
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}
