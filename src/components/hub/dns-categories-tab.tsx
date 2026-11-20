'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Вкладка «DNS списки → Категории»: управление составом сборки по аналогии
// с категориями правил. Категории источников — одна на источник (ads/malware/…),
// категории импортированной SQL-базы (ifaro:…) — у домена их может быть
// несколько: домен остаётся в сборке, пока включена хотя бы одна.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { api, type DomainCategoryItem } from '@/components/hub/api'
import { DNS_CATEGORY_KEYS } from '@/components/hub/dns-sources-tab'
import { useI18n } from '@/lib/i18n'

export function DnsCategoriesTab() {
  const { t, tr, loc } = useI18n()
  const [cats, setCats] = useState<DomainCategoryItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [showImported, setShowImported] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const r = await api.dns.categories()
      // каталог (ключи) сверху, категории импорта — по убыванию счётчика
      const catalog = r.categories.filter((c) => DNS_CATEGORY_KEYS.includes(c.name))
      const imported = r.categories.filter((c) => !DNS_CATEGORY_KEYS.includes(c.name)).sort((a, b) => b.domains - a.domains)
      setCats([...catalog, ...imported])
    } catch {
      setCats([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (c: DomainCategoryItem) => {
    setBusy(c.id)
    try {
      await api.dns.patchCategory(c.id, { enabled: !c.enabled })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">{t.dns.categoriesCardTitle}</CardTitle>
          <CardDescription>{t.dns.categoriesCardDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t.dns.catIfaroNote}</p>
          {cats.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.dns.emptyCategories}</p>
          ) : (
            <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
              {cats.filter((c) => DNS_CATEGORY_KEYS.includes(c.name) || showImported).map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                  <Switch checked={c.enabled} onCheckedChange={() => void toggle(c)} disabled={busy === c.id} aria-label={c.name} />
                  <div className="min-w-0 flex-1">
                    <span className={`text-sm ${c.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {c.name.startsWith('ifaro:') ? (c.label ?? c.name) : c.name}
                    </span>
                    {c.name.startsWith('ifaro:') && <span className="text-[11px] text-muted-foreground ml-2">{c.name}</span>}
                  </div>
                  <Badge variant="outline" className="border-input text-muted-foreground shrink-0">{tr(t.dns.catDomains, { n: c.domains.toLocaleString(loc) })}</Badge>
                </div>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={showImported} onChange={(e) => setShowImported(e.target.checked)} className="accent-primary" />
            ifaro ({cats.filter((c) => c.name.startsWith('ifaro:')).length})
          </label>
        </CardContent>
      </Card>
    </div>
  )
}
