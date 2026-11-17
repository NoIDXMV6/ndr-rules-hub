'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Системные дашборды вкладки «Обзор»: сервер (CPU/память/аптайм), диски
// (место + пороги + автоочистка), запущенные контейнеры, скорость сетевых
// интерфейсов и WireGuard-туннеля. Данные: /api/system (опрос каждые 5 c),
// скорости считаются на клиенте дельтой между опросами.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, type SystemStats, type CleanupReport } from '@/components/hub/api'
import { useI18n } from '@/lib/i18n'
import { AlertTriangle, Cpu, Database, HardDrive, MemoryStick, RefreshCw, Server, Timer, Trash2, Wifi } from 'lucide-react'

const POLL_MS = 5000

interface Speeds {
  net: Record<string, { rx: number; tx: number }> // байт/с
  wg: Record<string, { rx: number; tx: number }>
}

function fmtSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—'
  if (bps < 1024) return `${Math.round(bps)} Б/с`
  if (bps < 1048576) return `${(bps / 1024).toFixed(1)} КБ/с`
  return `${(bps / 1048576).toFixed(1)} МБ/с`
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} ГБ`
  return `${Math.round(mb)} МБ`
}

function fmtUptime(sec: number, t: (k: keyof typeof UP_KEYS) => string): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const parts: string[] = []
  if (d) parts.push(`${d} ${t('uptimeDays')}`)
  if (h) parts.push(`${h} ${t('uptimeHours')}`)
  if (!d && m) parts.push(`${m} ${t('uptimeMin')}`)
  return parts.join(' ') || '—'
}

const UP_KEYS = {
  uptimeDays: '',
  uptimeHours: '',
  uptimeMin: '',
} as const

export function SystemPanel({ onSettings }: { onSettings: () => void }) {
  const { t, tr, lang } = useI18n()
  const [sys, setSys] = useState<SystemStats | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busyCleanup, setBusyCleanup] = useState<'preview' | 'run' | null>(null)
  const [report, setReport] = useState<CleanupReport | null>(null)
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null)
  // предыдущий опрос: для скоростей интерфейсов и туннелей
  const prevRef = useRef<{ ts: number; net: Record<string, [number, number]>; wg: Record<string, [number, number]> } | null>(null)
  const [speeds, setSpeeds] = useState<Speeds>({ net: {}, wg: {} })

  const load = useCallback(async () => {
    try {
      const s = await api.system()
      setSys(s)
      setErr(null)
      const now = Date.now()
      const netMap: Record<string, [number, number]> = {}
      for (const n of s.net) netMap[n.iface] = [n.rxBytes, n.txBytes]
      const wgMap: Record<string, [number, number]> = {}
      for (const i of s.wg.interfaces ?? []) {
        let rx = 0
        let tx = 0
        for (const p of i.peers) {
          rx += parseInt(p.transferRx ?? '0', 10) || 0
          tx += parseInt(p.transferTx ?? '0', 10) || 0
        }
        wgMap[i.name] = [rx, tx]
      }
      const prev = prevRef.current
      prevRef.current = { ts: now, net: netMap, wg: wgMap }
      if (prev && now > prev.ts) {
        const dt = (now - prev.ts) / 1000
        const calc = (cur: Record<string, [number, number]>, old: Record<string, [number, number]>) => {
          const out: Record<string, { rx: number; tx: number }> = {}
          for (const [k, [rx, tx]] of Object.entries(cur)) {
            const o = old[k]
            if (!o) continue
            out[k] = { rx: Math.max(0, (rx - o[0]) / dt), tx: Math.max(0, (tx - o[1]) / dt) }
          }
          return out
        }
        setSpeeds({ net: calc(netMap, prev.net), wg: calc(wgMap, prev.wg) })
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const cleanup = async (mode: 'preview' | 'run') => {
    setBusyCleanup(mode)
    setCleanupMsg(null)
    try {
      const r = await api.systemAction(mode === 'preview' ? { action: 'cleanup-preview' } : { action: 'cleanup-run' })
      if (r.report) {
        setReport(r.report)
        setCleanupMsg(mode === 'preview' ? t.system.cleanupPreviewDone : tr(t.system.cleanupRunDone, { mb: fmtMb(r.report.freedBytes / 1048576) }))
      } else if (r.error) setCleanupMsg(r.error)
      await load()
    } catch (e) {
      setCleanupMsg((e as Error).message)
    } finally {
      setBusyCleanup(null)
    }
  }

  if (!sys) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-8 flex items-center justify-center text-muted-foreground text-sm">
          <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> {err ?? t.system.loading}
        </CardContent>
      </Card>
    )
  }

  const cfg = sys.cleanup.settings
  const dataDisk = sys.disks.find((d) => d.isData) ?? sys.disks[0] ?? null
  const warnPct = cfg.diskWarnPct
  const critPct = cfg.diskCriticalPct
  const diskLevel = dataDisk ? (dataDisk.usedPct >= critPct ? 'crit' : dataDisk.usedPct >= warnPct ? 'warn' : 'ok') : 'ok'

  const tt = (k: keyof typeof UP_KEYS) =>
    k === 'uptimeDays' ? t.system.uptimeDays : k === 'uptimeHours' ? t.system.uptimeHours : t.system.uptimeMin

  return (
    <div className="space-y-4">
      {/* Предупреждение о месте — самое важное, наверх */}
      {diskLevel !== 'ok' && (
        <div className={`rounded-lg border p-3 text-sm flex flex-wrap items-center gap-2 ${diskLevel === 'crit' ? 'border-red-300/60 bg-red-50 text-red-700' : 'border-amber-300/60 bg-amber-50 text-amber-800'}`}>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{tr(t.system.diskWarning, { mount: dataDisk?.mount ?? '—', pct: String(dataDisk?.usedPct ?? 0), free: fmtMb(dataDisk?.freeMb ?? 0) })}</span>
          <Button size="sm" variant="outline" className={diskLevel === 'crit' ? 'border-red-300 text-red-700' : 'border-amber-300 text-amber-800'} onClick={() => void cleanup('preview')}>
            {t.system.cleanupPreview}
          </Button>
          <Button size="sm" variant="outline" className={diskLevel === 'crit' ? 'border-red-300 text-red-700' : 'border-amber-300 text-amber-800'} onClick={onSettings}>
            {t.system.cleanupSettingsLink}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Сервер: CPU / память / аптайм ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" /> {t.system.serverTitle}
            </CardTitle>
            <CardDescription>
              {tr(t.system.serverSub, { cores: String(sys.cpu.cores), up: fmtUptime(sys.uptimeSec, tt) })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Gauge
              label={<span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" /> CPU</span>}
              pct={sys.cpu.usagePct}
              sub={tr(t.system.cpuSub, { l1: sys.cpu.load1.toFixed(2), l5: sys.cpu.load5.toFixed(2), l15: sys.cpu.load15.toFixed(2) })}
              t={t}
            />
            <Gauge
              label={<span className="inline-flex items-center gap-1.5"><MemoryStick className="h-3.5 w-3.5" /> RAM</span>}
              pct={sys.mem.usedPct}
              sub={tr(t.system.memSub, { used: fmtMb(sys.mem.usedMb), total: fmtMb(sys.mem.totalMb), free: fmtMb(sys.mem.availableMb) })}
              t={t}
            />
          </CardContent>
        </Card>

        {/* ── Диски ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-primary" /> {t.system.disksTitle}
            </CardTitle>
            <CardDescription>{t.system.disksSub}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {sys.disks.length === 0 && <p className="text-sm text-muted-foreground">{t.system.noDisks}</p>}
            {sys.disks.map((d) => (
              <Gauge
                key={d.mount}
                label={
                  <span className="inline-flex items-center gap-1.5 flex-wrap">
                    <Database className="h-3.5 w-3.5 shrink-0" />
                    <code className="text-xs">{d.mount}</code>
                    {d.isData && <Badge variant="outline" className="border-primary/40 text-primary px-1 py-0 text-[10px]">{t.system.dataDisk}</Badge>}
                    <span className="text-xs text-muted-foreground">{d.type}</span>
                  </span>
                }
                pct={d.usedPct}
                sub={tr(t.system.diskSub, { used: fmtMb(d.usedMb), total: fmtMb(d.totalMb), free: fmtMb(d.freeMb) })}
                t={t}
                warnLevel={d.usedPct >= critPct ? 'crit' : d.usedPct >= warnPct ? 'warn' : 'ok'}
              />
            ))}
          </CardContent>
        </Card>

        {/* ── Туннель WireGuard ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Wifi className="h-4 w-4 text-primary" /> {t.system.tunnelTitle}
            </CardTitle>
            <CardDescription>{t.system.tunnelSub}</CardDescription>
          </CardHeader>
          <CardContent>
            {!sys.wg.available && <p className="text-sm text-muted-foreground">{t.system.tunnelUnavailable}</p>}
            {sys.wg.available && sys.wg.interfaces.length === 0 && <p className="text-sm text-muted-foreground">{t.system.tunnelNone}</p>}
            {sys.wg.interfaces.map((i) => {
              const sp = speeds.wg[i.name]
              const totalRx = i.peers.reduce((a, p) => a + (parseInt(p.transferRx ?? '0', 10) || 0), 0)
              const totalTx = i.peers.reduce((a, p) => a + (parseInt(p.transferTx ?? '0', 10) || 0), 0)
              return (
                <div key={i.name} className="mb-2 rounded-lg border border-border p-3 space-y-1.5">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    <span className="font-mono text-emerald-700">{i.name}</span>
                    <span className="text-muted-foreground">{tr(t.system.tunnelPeers, { n: i.peers.length })}</span>
                    <span className="text-muted-foreground">{tr(t.system.tunnelOnline, { n: i.peers.filter((p) => p.online).length })}</span>
                    <span className="text-muted-foreground tabular-nums">↓ {fmtSpeed(sp?.rx ?? 0)} · ↑ {fmtSpeed(sp?.tx ?? 0)}</span>
                  </div>
                  {i.peers.map((p, idx) => (
                    <div key={idx} className="text-xs text-muted-foreground border-t border-border/60 pt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span className={`inline-block h-2 w-2 rounded-full mt-1 ${p.online ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                      <span className="text-foreground">{p.endpoint ?? '—'}</span>
                      <span>{t.system.handshake}: {p.latestHandshake === 'нет' || !p.latestHandshake ? '—' : new Date(p.latestHandshake).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="tabular-nums">{tr(t.system.tunnelTraffic, { rx: fmtMb((parseInt(p.transferRx ?? '0', 10) || 0) / 1048576), tx: fmtMb((parseInt(p.transferTx ?? '0', 10) || 0) / 1048576) })}</span>
                    </div>
                  ))}
                  <div className="text-[10px] text-muted-foreground/70 tabular-nums">Σ ↓ {fmtMb(totalRx / 1048576)} · ↑ {fmtMb(totalTx / 1048576)}</div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        {/* ── Сетевые интерфейсы ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Timer className="h-4 w-4 text-primary" /> {t.system.netTitle}
            </CardTitle>
            <CardDescription>{t.system.netSub}</CardDescription>
          </CardHeader>
          <CardContent>
            {sys.net.length === 0 && <p className="text-sm text-muted-foreground">{t.system.netNone}</p>}
            <div className="space-y-1.5">
              {sys.net.map((n) => {
                const sp = speeds.net[n.iface]
                return (
                  <div key={n.iface} className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm border-b border-border/40 py-1.5 last:border-0">
                    <span className="font-mono text-foreground w-24">{n.iface}</span>
                    <span className="text-muted-foreground tabular-nums">↓ {fmtSpeed(sp?.rx ?? 0)}</span>
                    <span className="text-muted-foreground tabular-nums">↑ {fmtSpeed(sp?.tx ?? 0)}</span>
                    <span className="text-muted-foreground/70 text-xs tabular-nums ml-auto">{tr(t.system.netTotal, { rx: fmtMb(n.rxBytes / 1048576), tx: fmtMb(n.txBytes / 1048576) })}</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Контейнеры ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" /> {t.system.containersTitle}
          </CardTitle>
          <CardDescription>{t.system.containersSub}</CardDescription>
        </CardHeader>
        <CardContent>
          {!sys.containers.available && (
            <div className="text-sm text-muted-foreground space-y-1">
              <p className="text-amber-700">⚠ {sys.containers.error}</p>
              {sys.containers.hint && <p className="text-xs">{sys.containers.hint}</p>}
            </div>
          )}
          {sys.containers.available && sys.containers.list.length === 0 && <p className="text-sm text-muted-foreground">{t.system.containersNone}</p>}
          {sys.containers.available && sys.containers.list.length > 0 && (
            <div className="space-y-1">
              {sys.containers.list.map((c) => (
                <div key={c.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm border-b border-border/40 py-1.5 last:border-0">
                  <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${c.up ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  <span className="font-mono">{c.name}</span>
                  {c.isHub && <Badge variant="outline" className="border-primary/40 text-primary px-1 py-0 text-[10px]">{t.system.hubContainer}</Badge>}
                  <span className="text-xs text-muted-foreground">{c.image}</span>
                  <span className={`text-xs ml-auto ${c.up ? 'text-emerald-700' : 'text-red-600'}`}>{c.status}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Очистка диска ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-primary" /> {t.system.cleanupTitle}
          </CardTitle>
          <CardDescription>
            {cfg.autoEnabled
              ? tr(t.system.cleanupSubOn, { trigger: String(cfg.triggerPct), target: String(cfg.freeTargetPct), sched: cfg.schedule })
              : t.system.cleanupSubOff}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="border-input text-foreground" onClick={() => void cleanup('preview')} disabled={busyCleanup !== null}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${busyCleanup === 'preview' ? 'animate-spin' : ''}`} /> {t.system.cleanupPreview}
            </Button>
            <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => void cleanup('run')} disabled={busyCleanup !== null}>
              <Trash2 className={`h-3.5 w-3.5 mr-1.5 ${busyCleanup === 'run' ? 'animate-pulse' : ''}`} /> {t.system.cleanupRun}
            </Button>
            <Button size="sm" variant="outline" className="border-input text-foreground" onClick={onSettings}>
              {t.system.cleanupSettingsLink}
            </Button>
          </div>
          {cleanupMsg && <p className="text-sm text-emerald-700">{cleanupMsg}</p>}
          {report && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {tr(t.system.cleanupLastReport, {
                  mode: report.dryRun ? t.system.cleanupModeDry : t.system.cleanupModeReal,
                  mb: fmtMb(report.freedBytes / 1048576),
                  before: String(report.diskBefore?.usedPct ?? '—'),
                  after: String(report.diskAfter?.usedPct ?? '—'),
                })}
              </p>
              <ul className="space-y-1">
                {report.actions.map((a, i) => (
                  <li key={i} className="text-xs rounded border border-border p-2">
                    <span className="font-medium text-foreground">{a.cleaner}</span>
                    {a.skipped && <Badge variant="outline" className="ml-2 border-input text-muted-foreground px-1 py-0 text-[10px]">{a.skipped}</Badge>}
                    {!a.ok && <Badge variant="outline" className="ml-2 border-red-300 text-red-600 px-1 py-0 text-[10px]">error</Badge>}
                    <span className="text-muted-foreground"> — {a.detail}</span>
                    {a.items && a.items.length > 0 && (
                      <ul className="mt-1 ml-3 space-y-0.5 text-muted-foreground/80">
                        {a.items.slice(0, 8).map((it, j) => <li key={j} className="truncate">{it}</li>)}
                        {a.items.length > 8 && <li>… +{a.items.length - 8}</li>}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Полоса-индикатор с подписью; цвета по порогам */
function Gauge({
  label,
  pct,
  sub,
  t,
  warnLevel = 'ok',
}: {
  label: React.ReactNode
  pct: number
  sub: string
  t: { system: Record<string, string> }
  warnLevel?: 'ok' | 'warn' | 'crit'
}) {
  const bar = warnLevel === 'crit' ? 'bg-red-500' : warnLevel === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'
  const text = warnLevel === 'crit' ? 'text-red-600' : warnLevel === 'warn' ? 'text-amber-700' : 'text-foreground'
  const p = Math.max(0, Math.min(100, pct))
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-sm mb-1">
        <span className="text-foreground">{label}</span>
        <span className={`tabular-nums font-medium ${text}`}>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${p}%` }} />
      </div>
      <p className="text-xs text-muted-foreground mt-1">{sub}</p>
    </div>
  )
}
