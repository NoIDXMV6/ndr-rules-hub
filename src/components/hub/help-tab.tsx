'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { useI18n, type Lang } from '@/lib/i18n'
import { Rich } from './rich'

const REPO = 'https://github.com/NoIDXMV6/ndr-rules-hub'

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80">
      {children}
    </a>
  )
}

function Li({ children }: { children: React.ReactNode }) {
  return <li className="ml-4 list-disc marker:text-muted-foreground/60">{children}</li>
}

interface HelpSection {
  trigger: string
  paragraphs?: string[]
  items?: string[]
  steps?: { title: string; text: string }[]
  footnote?: string
  /** абзац после списка с внешней ссылкой (ссылка одинакова для обоих языков) */
  outroLink?: { before: string; label: string; after: string; href: string }
}

const HELP_SECTIONS: Record<Lang, HelpSection[]> = {
  ru: [
    {
      trigger: 'Назначение: цели и задачи',
      paragraphs: [
        '**NDR Rules Hub** — вспомогательный сервис для системы **Clear NDR** (Stamus Networks): он автоматизирует полный цикл работы с наборами правил Snort/Suricata, которые питают сетевое обнаружение.',
      ],
      items: [
        'собрать в одном месте проверенные источники правил — от официальных наборов Talos до открытых фидов;',
        'загружать их по расписанию с учётом лимитов и авторизации (oinkcode, auth-key);',
        'устранять дубликаты и конфликты SID, из-за которых импорт в Clear NDR отказывает;',
        'конвертировать списки индикаторов (IP/домены/URL) в правила Suricata;',
        'собрать один итоговый файл и доставить его в Clear NDR — вручную, через REST API, по pull-схеме или из локального каталога;',
        'при необходимости загружать правила через WireGuard VPN, не теряя доступ к самому сервису.',
      ],
    },
    {
      trigger: 'Принципы работы: конвейер обработки',
      steps: [
        {
          title: '1. Источники',
          text: 'Каталог источников (вкладка «Источники»): официальные наборы snort.org (registered по oinkcode, community), ET Open, PT Attack Detection, Quadrant, OISF Traffic ID, фиды abuse.ch, конвертеры списков IP/доменов и локальные архивы. У каждого источника — тип авторизации (oinkcode / auth-key / basic / без авторизации), приоритет и флаг включения.',
        },
        {
          title: '2. Загрузка',
          text: 'HTTP(S)-загрузка с авторизацией: для snort.org ссылки приводятся к канонической форме `/reg-rules/<файл>/<oinkcode>`, архив проверяется по magic-байтам gzip, поддерживается кэш (`cacheTtlMinutes`) и работа от ранее скачанного архива при сбоях. Учитывайте лимиты snort.org: registered — не чаще раза в 15 минут.',
        },
        {
          title: '3. Парсинг и конвертация',
          text: 'Правила разбираются на атрибуты (SID, rev, msg, classtype, протокол, направление), проверяется совместимость с Suricata. Списки индикаторов (IP, домены, URL) конвертируются в правила Suricata с SID из приватного диапазона — с настройками sidStart, msgPrefix, perRule, maxRules.',
        },
        {
          title: '4. Дедупликация',
          text: 'Внутри источника и между источниками устраняются дубликаты: по SID (стратегии highest-rev / source-priority / renumber-private) и по содержимому правила (content hash). Отдельно гасится конфликт «conflicting SID» — причина отказов импорта в Clear NDR.',
        },
        {
          title: '5. Сборка',
          text: 'Итоговый файл собирается из всех правил с фильтром совместимости (dropIncompatible — отбросить несовместимые с Suricata конструкции), опционально скрываются отключённые правила (dropDisabledMsg). Результат: файл с именем из настроек, SHA-256 и статистикой.',
        },
        {
          title: '6. Экспорт',
          text: 'Четыре способа доставки в Clear NDR: 1) скачать файл и импортировать вручную (вкладка «Сборка и экспорт» → «Скачать итоговый файл»); 2) Clear NDR REST — нативная интеграция: Hub сам находит/создаёт источник и загружает файл через REST API Scirius (upload → update_push_all), нужен API-токен Clear NDR (меню пользователя → Edit Token); 3) pull — Clear NDR сам забирает файл по URL Hub (/api/export) и обновляется по встроенному расписанию (Suricata → Update → Recurrence); 4) HTTP POST на произвольный эндпоинт или копирование в каталог volume. Автоматизация — по расписанию (cron в «Настройках») или кнопкой «Полный цикл». Пошаговая инструкция с командами — docs/clearndr-integration.md.',
        },
      ],
      footnote: 'Все шаги видны в «Журнале»; состояния источников (ОК/ошибка/кэш) — на вкладке «Источники».',
    },
    {
      trigger: 'Источники правил и лимиты snort.org',
      paragraphs: [
        'Рекомендуемый базовый набор — **Snort Registered Ruleset** (обновляется Talos ежедневно) плюс **ET Open**. Community-наборы snort.org — подмножества registered, включайте их только без oinkcode.',
      ],
      items: [
        'registered-архивы загружаются по oinkcode из «Настроек» (snort.org → Preferences → Oinkcode, 40 hex-символов);',
        'лимит snort.org: registered — не чаще **1 загрузки в 15 минут**; community — ограничение по IP;',
        'задайте `cacheTtlMinutes` в extra источника, чтобы не перекачивать архив чаще лимита;',
        'локальные архивы (data/archives) — запасной путь при недоступности snort.org.',
      ],
    },
    {
      trigger: 'WireGuard VPN для загрузок',
      paragraphs: [
        'Вкладка «WireGuard VPN» поднимает туннель внутри контейнера: загрузки правил идут через него (например, из закрытой сети или с «чистого» IP), а web-интерфейс остаётся доступным — трафик самого сервиса исключается из full-tunnel правилом `ip rule … lookup main`.',
      ],
      items: [
        'требования: `/dev/net/tun`, `NET_ADMIN`, `net.ipv4.conf.all.src_valid_mark=1` (см. README);',
        'при потерянном доступе к UI: `docker compose exec rules-hub wg-quick down /app/data/wireguard/wg0.conf` или `docker compose restart rules-hub`;',
        'включается флагом «Гнать загрузки через WireGuard» в «Настройках».',
      ],
    },
    {
      trigger: 'Диагностика типовых проблем',
      items: [
        '**HTTP 422** у snort.org — почти всегда «Invalid oinkcode»: проверьте код в «Настройках» (40 символов, без пробелов);',
        '**HTTP 403 / 429** — дневной/частотный лимит загрузок: подождите 15–30 минут или включите кэш;',
        '**«not in gzip format»** — исправлено с v1.5.0: архив теперь проверяется по magic-байтам, а ссылки личного кабинета snort.org автоматически приводятся к каноническому виду;',
        '**«Ошибка связи с API»** — бэкенд недоступен: смотрите `docker logs ndr-rules-hub` и `GET /api/health`;',
        'схема БД восстанавливается автоматически: при несовпадении версии старая база бэкапится в `data/hub.db.bak-*`.',
      ],
      outroLink: {
        before: 'Подробные инструкции — в README репозитория:',
        label: 'github.com/NoIDXMV6/ndr-rules-hub',
        after: '',
        href: REPO,
      },
    },
    {
      trigger: 'Политики дедупликации и совместимость',
      items: [
        '**highest-rev** — при конфликте SID остаётся правило с максимальным rev (по умолчанию);',
        '**source-priority** — выигрывает источник с меньшим числом приоритета;',
        '**renumber-private** — конфликтующие SID переводятся в приватный диапазон (privateSidStart);',
        '**dedupContent** — удаляет правила с одинаковым содержимым, но разными SID;',
        '**dropIncompatible** — не включает в сборку конструкции, несовместимые с Suricata (replace, rawbytes и др.).',
      ],
    },
  ],
  en: [
    {
      trigger: 'Purpose: goals and objectives',
      paragraphs: [
        '**NDR Rules Hub** is a companion service for the **Clear NDR** system (Stamus Networks): it automates the full cycle of working with Snort/Suricata rulesets that feed network detection.',
      ],
      items: [
        'bring proven rule sources together in one place — from official Talos rulesets to open feeds;',
        'download them on a schedule, respecting rate limits and authentication (oinkcode, auth-key);',
        'eliminate duplicates and SID conflicts that make Clear NDR imports fail;',
        'convert indicator lists (IP/domains/URLs) into Suricata rules;',
        'produce a single final file and deliver it to Clear NDR — manually, via the REST API, a pull scheme, or from a local directory;',
        'when needed, download rules through a WireGuard VPN without losing access to the service itself.',
      ],
    },
    {
      trigger: 'How it works: processing pipeline',
      steps: [
        {
          title: '1. Sources',
          text: 'Source catalog (the “Sources” tab): official snort.org rulesets (registered via oinkcode, community), ET Open, PT Attack Detection, Quadrant, OISF Traffic ID, abuse.ch feeds, IP/domain list converters and local archives. Each source has an auth type (oinkcode / auth-key / basic / none), a priority and an enable flag.',
        },
        {
          title: '2. Fetching',
          text: 'Authenticated HTTP(S) download: snort.org links are normalized to the canonical `/reg-rules/<file>/<oinkcode>` form, the archive is verified by gzip magic bytes, caching (`cacheTtlMinutes`) and falling back to a previously downloaded archive are supported. Mind the snort.org limits: registered — no more than once every 15 minutes.',
        },
        {
          title: '3. Parsing and conversion',
          text: 'Rules are parsed into attributes (SID, rev, msg, classtype, protocol, direction) and checked for Suricata compatibility. Indicator lists (IPs, domains, URLs) are converted into Suricata rules with SIDs from the private range — configured via sidStart, msgPrefix, perRule, maxRules.',
        },
        {
          title: '4. Deduplication',
          text: 'Duplicates are removed within and across sources: by SID (highest-rev / source-priority / renumber-private strategies) and by rule content (content hash). The “conflicting SID” problem — a common cause of failed Clear NDR imports — is handled separately.',
        },
        {
          title: '5. Build',
          text: 'The final file is assembled from all rules with the compatibility filter (dropIncompatible — drop Suricata-incompatible constructs) and, optionally, disabled rules hidden (dropDisabledMsg). The result: a file named per settings, with SHA-256 and statistics.',
        },
        {
          title: '6. Export',
          text: 'Four delivery paths to Clear NDR: 1) download the file and import it manually (“Build & Export” tab → “Download final file”); 2) Clear NDR REST — native integration: the Hub itself finds/creates the source and uploads the file through the Scirius REST API (upload → update_push_all); a Clear NDR API token is required (user menu → Edit Token); 3) pull — Clear NDR fetches the file from the Hub URL (/api/export) and updates itself on a built-in schedule (Suricata → Update → Recurrence); 4) HTTP POST to any endpoint or copying to a volume directory. Automation — by schedule (cron in “Settings”) or the “Full cycle” button. Step-by-step guide with commands — docs/clearndr-integration.en.md.',
        },
      ],
      footnote: 'All steps are visible in the “Logs” tab; source states (OK/error/cache) are on the “Sources” tab.',
    },
    {
      trigger: 'Rule sources and snort.org limits',
      paragraphs: [
        'The recommended base set is the **Snort Registered Ruleset** (updated daily by Talos) plus **ET Open**. snort.org community sets are subsets of registered — enable them only if you have no oinkcode.',
      ],
      items: [
        'registered archives are downloaded with the oinkcode from “Settings” (snort.org → Preferences → Oinkcode, 40 hex characters);',
        'snort.org limit: registered — no more than **1 download per 15 minutes**; community — IP-based limit;',
        'set `cacheTtlMinutes` in the source extra so the archive is not re-downloaded more often than the limit;',
        'local archives (data/archives) are the fallback path when snort.org is unreachable.',
      ],
    },
    {
      trigger: 'WireGuard VPN for downloads',
      paragraphs: [
        'The “WireGuard VPN” tab brings a tunnel up inside the container: rule downloads go through it (for example, from a closed network or a “clean” IP), while the web UI stays reachable — the service’s own traffic is excluded from the full tunnel by an `ip rule … lookup main` rule.',
      ],
      items: [
        'requirements: `/dev/net/tun`, `NET_ADMIN`, `net.ipv4.conf.all.src_valid_mark=1` (see the README);',
        'if access to the UI is lost: `docker compose exec rules-hub wg-quick down /app/data/wireguard/wg0.conf` or `docker compose restart rules-hub`;',
        'enabled by the “Route downloads through WireGuard” flag in “Settings”.',
      ],
    },
    {
      trigger: 'Troubleshooting common problems',
      items: [
        '**HTTP 422** from snort.org — almost always “Invalid oinkcode”: check the code in “Settings” (40 characters, no spaces);',
        '**HTTP 403 / 429** — daily/rate limit on downloads: wait 15–30 minutes or enable caching;',
        '**“not in gzip format”** — fixed since v1.5.0: the archive is now verified by magic bytes, and snort.org personal-cabinet links are automatically normalized to the canonical form;',
        '**“API communication error”** — the backend is unreachable: check `docker logs ndr-rules-hub` and `GET /api/health`;',
        'the DB schema is restored automatically: on a version mismatch the old database is backed up to `data/hub.db.bak-*`.',
      ],
      outroLink: {
        before: 'Detailed instructions are in the repository README:',
        label: 'github.com/NoIDXMV6/ndr-rules-hub',
        after: '',
        href: REPO,
      },
    },
    {
      trigger: 'Deduplication policies and compatibility',
      items: [
        '**highest-rev** — on an SID conflict the rule with the highest rev is kept (default);',
        '**source-priority** — the source with the lower priority number wins;',
        '**renumber-private** — conflicting SIDs are moved into the private range (privateSidStart);',
        '**dedupContent** — removes rules with identical content but different SIDs;',
        '**dropIncompatible** — excludes Suricata-incompatible constructs from the build (replace, rawbytes, etc.).',
      ],
    },
  ],
}

export function HelpTab() {
  const { t, lang } = useI18n()
  const sections = HELP_SECTIONS[lang]
  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">{t.help.title}</CardTitle>
          <CardDescription>{t.help.intro}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {t.help.repoLabel} <A href={REPO}>github.com/NoIDXMV6/ndr-rules-hub</A> · {t.help.authorSiteLabel}{' '}
          <A href="https://kozhevatov.ru">kozhevatov.ru</A>
        </CardContent>
      </Card>

      <Accordion type="multiple" defaultValue={['help-purpose']} className="bg-card border border-border rounded-lg px-4">
        {sections.map((s, idx) => (
          <AccordionItem key={s.trigger} value={`help-${idx}`}>
            <AccordionTrigger>{s.trigger}</AccordionTrigger>
            <AccordionContent className="space-y-2 text-sm leading-relaxed">
              {s.paragraphs?.map((p, i) => <p key={i}><Rich text={p} /></p>)}
              {s.items && (
                <ul className="space-y-1">
                  {s.items.map((li, i) => <Li key={i}><Rich text={li} /></Li>)}
                </ul>
              )}
              {s.steps?.map((st) => (
                <div key={st.title}>
                  <div className="font-medium text-foreground">{st.title}</div>
                  <p className="text-muted-foreground"><Rich text={st.text} /></p>
                </div>
              ))}
              {s.footnote && <p className="text-xs text-muted-foreground pt-1">{s.footnote}</p>}
              {s.outroLink && (
                <p className="text-xs text-muted-foreground">
                  {s.outroLink.before}{' '}
                  <A href={s.outroLink.href}>{s.outroLink.label}</A>
                  {s.outroLink.after ? ` ${s.outroLink.after}` : ''}
                </p>
              )}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  )
}
