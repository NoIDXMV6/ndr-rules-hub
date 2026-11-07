'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, Dashboard } from '@/components/hub/api'
import { Eye, EyeOff, Save } from 'lucide-react'

export function SettingsTab({ data, onChange }: { data: Dashboard | null; onChange: () => void }) {
  const [s, setS] = useState<Record<string, string>>({})
  const [showOink, setShowOink] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (data?.settings) setS(data.settings)
  }, [data?.settings])

  const set = (k: string, v: string) => setS((prev) => ({ ...prev, [k]: v }))

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.saveSettings(s)
      setMsg('Настройки сохранены. Планировщик перезапущен.')
      onChange()
    } catch (e) {
      setMsg(`Ошибка: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">snort.org — доступ к зарегистрированным правилам</CardTitle>
          <CardDescription>
            Достаточно Oinkcode — это официальный способ автоматизации. Вводить логин/пароль не требуется.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="max-w-xl">
            <Label className="text-zinc-300">Oinkcode</Label>
            <div className="flex gap-2">
              <Input
                type={showOink ? 'text' : 'password'}
                value={s.oinkcode ?? ''}
                onChange={(e) => set('oinkcode', e.target.value.trim())}
                className="bg-zinc-950 border-zinc-800 font-mono"
                placeholder="32-символьный код из профиля snort.org"
              />
              <Button variant="outline" className="border-zinc-700 text-zinc-300 shrink-0" onClick={() => setShowOink(!showOink)}>
                {showOink ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              Берётся в профиле snort.org → Oinkcode. Используется автоматически всеми источниками с типом «oinkcode».
              Учитывайте лимит: snort.org ограничивает число загрузок в сутки — для частых обновлений держите
              включённым один зарегистрированный набор.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Политики дедупликации и сборки</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-zinc-300">Стратегия разрешения конфликтов SID</Label>
              <Select value={s.dedupSidStrategy ?? 'highest-rev'} onValueChange={(v) => set('dedupSidStrategy', v)}>
                <SelectTrigger className="bg-zinc-950 border-zinc-800"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-800">
                  <SelectItem value="highest-rev">оставлять правило с максимальным rev</SelectItem>
                  <SelectItem value="source-priority">приоритет источника (ниже число = главнее)</SelectItem>
                  <SelectItem value="renumber-private">перенумеровывать в приватный диапазон</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-zinc-500 mt-1">
                Конфликты SID между источниками решаются выбранной стратегией; при равенстве rev побеждает более приоритетный источник.
              </p>
            </div>
            <div>
              <Label className="text-zinc-300">Начало приватного диапазона SID</Label>
              <Input
                type="number"
                value={s.privateSidStart ?? '1000000'}
                onChange={(e) => set('privateSidStart', e.target.value)}
                className="bg-zinc-950 border-zinc-800"
              />
              <p className="text-xs text-zinc-500 mt-1">Для правил конвертеров и перенумерации (стандарт: 1 000 000–1 999 999).</p>
            </div>
          </div>
          <div className="space-y-3">
            <SwitchRow label="Удалять дубликаты по содержимому (одинаковые правила с разными SID)" checked={(s.dedupContent ?? 'true') === 'true'} onChange={(v) => set('dedupContent', String(v))} />
            <SwitchRow label="Убирать правила, несовместимые с Suricata (preproc, keystore и др.)" checked={(s.dropIncompatible ?? 'true') === 'true'} onChange={(v) => set('dropIncompatible', String(v))} />
            <SwitchRow label="Удалять заглушки DELETED/DISABLED" checked={(s.dropDisabledMsg ?? 'true') === 'true'} onChange={(v) => set('dropDisabledMsg', String(v))} />
          </div>
          <div className="max-w-sm">
            <Label className="text-zinc-300">Имя итогового файла</Label>
            <Input value={s.buildFileName ?? ''} onChange={(e) => set('buildFileName', e.target.value)} className="bg-zinc-950 border-zinc-800" />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Экспорт в Clear NDR</CardTitle>
          <CardDescription>Как передавать итоговый файл: вручную из файла, HTTP-загрузкой или копированием в каталог</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-zinc-300">Режим</Label>
            <Select value={s.clearndrExportMode ?? 'file'} onValueChange={(v) => set('clearndrExportMode', v)}>
              <SelectTrigger className="bg-zinc-950 border-zinc-800"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-zinc-900 border-zinc-800">
                <SelectItem value="file">файл (скачать и импортировать вручную)</SelectItem>
                <SelectItem value="http">HTTP POST в Clear NDR</SelectItem>
                <SelectItem value="local-path">копировать в каталог (общий volume)</SelectItem>
                <SelectItem value="disabled">отключить автоэкспорт</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-zinc-300">URL эндпоинта Clear NDR (для HTTP)</Label>
            <Input value={s.clearndrExportUrl ?? ''} onChange={(e) => set('clearndrExportUrl', e.target.value)} className="bg-zinc-950 border-zinc-800" placeholder="http://clearndr:8080/api/rules/import" />
          </div>
          <div>
            <Label className="text-zinc-300">Токен (Bearer), если требуется</Label>
            <Input type="password" value={s.clearndrExportToken ?? ''} onChange={(e) => set('clearndrExportToken', e.target.value)} className="bg-zinc-950 border-zinc-800" />
          </div>
          <div>
            <Label className="text-zinc-300">Каталог на стороне Clear NDR (для volume)</Label>
            <Input value={s.clearndrExportLocalPath ?? ''} onChange={(e) => set('clearndrExportLocalPath', e.target.value)} className="bg-zinc-950 border-zinc-800" placeholder="/srv/clearndr/import" />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Расписание (cron)</CardTitle>
          <CardDescription>Автоматический цикл: обновление источников → сборка → экспорт</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <SwitchRow label="Планировщик включён" checked={(s.cronEnabled ?? 'false') === 'true'} onChange={(v) => set('cronEnabled', String(v))} />
            <SwitchRow label="Экспортировать после сборки" checked={(s.cronExport ?? 'true') === 'true'} onChange={(v) => set('cronExport', String(v))} />
          </div>
          <div className="max-w-sm">
            <Label className="text-zinc-300">Cron-выражение</Label>
            <Input value={s.cronSchedule ?? ''} onChange={(e) => set('cronSchedule', e.target.value)} className="bg-zinc-950 border-zinc-800 font-mono" placeholder="0 4 * * *" />
            <p className="text-xs text-zinc-500 mt-1">Пример: 0 4 * * * — ежедневно в 04:00. */30 * * * * — каждые 30 минут.</p>
          </div>
          <div className="max-w-sm">
            <Label className="text-zinc-300">HOME_NET (для справки/правил конвертеров)</Label>
            <Input value={s.homeNet ?? ''} onChange={(e) => set('homeNet', e.target.value)} className="bg-zinc-950 border-zinc-800" />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 text-white">
          <Save className="h-4 w-4 mr-1.5" /> Сохранить настройки
        </Button>
        {msg && <span className="text-sm text-emerald-400">{msg}</span>}
      </div>
    </div>
  )
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm text-zinc-300">{label}</span>
    </div>
  )
}
