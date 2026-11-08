'use client'

import React from 'react'
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

type SectionBlock = 'paragraphs' | 'items' | 'steps' | 'diagrams'
const DEFAULT_ORDER: SectionBlock[] = ['paragraphs', 'items', 'steps', 'diagrams']

interface HelpSection {
  trigger: string
  paragraphs?: string[]
  items?: string[]
  steps?: { title: string; text: string }[]
  /** диаграммы-иллюстрации (PNG @2x из public/diagrams, рендерятся из mermaid-исходников architecture.md §12) */
  diagrams?: { src: string; alt: string; caption?: string; minW?: number; maxW?: number }[]
  /** порядок отрисовки блоков внутри секции (по умолчанию paragraphs → items → steps → diagrams) */
  order?: SectionBlock[]
  footnote?: string
  /** абзац после списка с внешней ссылкой (ссылка одинакова для обоих языков) */
  outroLink?: { before: string; label: string; after: string; href: string }
}

type DiagramSpec = NonNullable<HelpSection['diagrams']>[number]

function Diagram({ d }: { d: DiagramSpec }) {
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-white">
      <div className="overflow-x-auto p-2">
        <img src={d.src} alt={d.alt} loading="lazy" className="mx-auto h-auto w-full max-w-none" style={{ minWidth: d.minW ?? 640, maxWidth: d.maxW }} />
      </div>
      {d.caption && (
        <figcaption className="border-t border-border/60 px-3 py-1.5 text-center text-xs text-muted-foreground">{d.caption}</figcaption>
      )}
    </figure>
  )
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
      trigger: 'Интеграция с Clear NDR: токен и схемы доставки',
      paragraphs: [
        'Итоговый файл `clearndr-import.rules` попадает в Clear NDR по одной из двух автоматических схем. **PULL** — Clear NDR сам забирает файл с Hub: `GET http://<hub>:3080/api/export`, источник-URL + встроенное расписание. **PUSH** — Hub сам отправляет файл через REST API Scirius: найти/создать источник → загрузить файл → применить набор к Suricata.',
        'Выбор простой: Clear NDR видит Hub по сети — берите **PULL** (настраивается один раз в Clear NDR); Clear NDR не может дотянуться до Hub (DMZ, NAT) — берите **PUSH** (настраивается один раз в Hub, со стороны Clear NDR не нужно ничего).',
      ],
      items: [
        '**API-токен** — единственное, что нужно добыть заранее. В веб-интерфейсе Clear NDR: меню пользователя → **User Settings → Edit Token → Regenerate** — 40 hex-символов; в некоторых сборках есть отдельная страница **Accounts → Token list**;',
        'зачем нужен: токен подписывает каждый запрос к REST API заголовком **`Authorization: Token <токен>`** и действует от имени вашей учётной записи — нужны права на управление правилами (`rules.source_edit`, `rules.ruleset_update_push`), обычно это администратор;',
        'важно: формат **`Bearer` Clear NDR не принимает** (HTTP 401) — в настройках экспорта Hub выбирайте тип авторизации «Token» (по умолчанию);',
        'проверка за 30 секунд: `curl -sk "https://clearndr.local/rest/rules/source/?name=__probe__" -H "Authorization: Token <токен>"` → HTTP 200; либо готовый скрипт `scripts/clearndr-check.sh` — он же покажет имеющиеся источники и наборы;',
        'безопасность: передавайте токен через переменные окружения, не пишите в скрипты в git; **Regenerate** мгновенно отзывает старый токен.',
      ],
      diagrams: [
        {
          src: '/diagrams/clearndr-schemes.png',
          alt: 'Две схемы доставки правил в Clear NDR',
          caption: 'Обе схемы доставляют один и тот же файл — итоговый набор после дедупликации и remap SID (блок 1e9+). Сплошные стрелки — доставка файла, пунктир — запуск по расписанию.',
          minW: 620,
          maxW: 700,
        },
      ],
    },
    {
      trigger: 'Интеграция с Clear NDR: настройка и автообновление',
      order: ['steps', 'diagrams', 'items'],
      steps: [
        {
          title: '1. PUSH — настройка в Hub (5 полей)',
          text: 'Вкладка «Настройки» → «Экспорт в Clear NDR»: режим **Clear NDR REST**, базовый URL (только корень вида `https://clearndr.local`, без `/rest` — допишется сам), тип авторизации **Token**, API-токен, имя источника («NDR Rules Hub»), флаг **«Применять набор после загрузки»**. Нажмите «Экспортировать в Clear NDR». Со стороны Clear NDR не нужно ничего — источник создаётся автоматически при первой отправке.',
        },
        {
          title: '2. PUSH — автообновление',
          text: 'Включите в «Настройках» Hub расписание (cron, например `0 4 * * *`) и флаг «Экспортировать после сборки» — по cron Hub сам: загрузит источники → пересоберёт файл → отправит в Clear NDR → применит набор (update_push_all, перезапуск Suricata). Альтернатива для своего графика — `scripts/clearndr-push.sh` в cron на любом сервере.',
        },
        {
          title: '3. PULL — настройка в Clear NDR (скрипт)',
          text: 'Идемпотентный скрипт `scripts/clearndr-setup-pull.sh` (переменные `CLEAR_NDR_URL`, `CLEAR_NDR_TOKEN`, `HUB_URL=http://<hub>:3080/api/export`) создаст источник-URL, набор «NDR Rules Hub», включит категорию и применит набор — 5 шагов с проверками. Те же шаги вручную: Sources → Add source (Source type: URL, Data type: «Individual Signatures file») → Rulesets → Add ruleset → отметить категорию → Suricata → Update.',
        },
        {
          title: '4. PULL — автообновление',
          text: 'В интерфейсе Clear NDR: **Suricata → Update** → включите Reload и Push, задайте **Recurrence** (например, Daily) — штатный планировщик celery сам заберёт свежий файл с Hub, импортирует правила и перезапустит Suricata. Либо системный cron на любом сервере: раз в сутки `POST /rest/suricata/update_push_all/` — «всё в одном»: update → generate → push.',
        },
      ],
      diagrams: [
        {
          src: '/diagrams/clearndr-push.png',
          alt: 'PUSH: цепочка вызовов REST API Scirius',
          caption: 'PUSH: что делает Hub при экспорте — все ветки (источник есть/нет, конфликт SID, флаг применения). Каждый шаг виден в «Журнале» (scope export).',
          minW: 760,
        },
        {
          src: '/diagrams/clearndr-pull.png',
          alt: 'PULL: плановое обновление по расписанию Clear NDR',
          caption: 'PULL: плановое обновление — celery Clear NDR забирает файл с Hub, пересобирает набор и перезапускает Suricata.',
          minW: 760,
        },
      ],
      items: [
        '**HTTP 401 «Invalid token»** — токен неверен/перегенерирован: сгенерируйте заново (Edit Token → Regenerate); заголовок — именно `Token`, не `Bearer`;',
        '**HTTP 404 на /rest/…** — в базовый URL попал лишний путь: в настройках Hub только корень, `/rest` дописывается автоматически;',
        '**HTTP 400 «conflicting SID»** — в файле близнецы: включите дедупликацию в настройках сборки (dedupContent, dropIncompatible) и пересоберите;',
        '**файл загружен, но правил в наборе нет** — категория источника не включена в ruleset (шаг 3 сценария PULL);',
        '**тест без боевого сервера** — mock Clear NDR: `python3 scripts/clearndr-mock-server.py`, затем режим «Clear NDR REST» с URL `http://127.0.0.1:8080` и токеном `mock-clearndr-token`.',
      ],
      footnote: 'Контроль: журнал Hub (scope `export`) — шаги отправки; Clear NDR → History — записи update_source / update_push_all; Suricata — rules_count в Rulesets.',
      outroLink: {
        before: 'Полная инструкция: команды curl для обеих схем, справочник эндпоинтов, диагностика и чек-лист внедрения —',
        label: 'docs/clearndr-integration.md',
        after: '',
        href: REPO + '/blob/main/docs/clearndr-integration.md',
      },
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
      trigger: 'Clear NDR integration: token and delivery schemes',
      paragraphs: [
        'The final `clearndr-import.rules` file reaches Clear NDR through one of two automated schemes. **PULL** — Clear NDR fetches the file from the Hub itself: `GET http://<hub>:3080/api/export`, a URL source + the built-in scheduler. **PUSH** — the Hub pushes the file through the Scirius REST API: find/create source → upload file → apply ruleset to Suricata.',
        'Choosing is simple: if Clear NDR can reach the Hub over the network — use **PULL** (configured once, in Clear NDR); if Clear NDR cannot reach the Hub (DMZ, NAT) — use **PUSH** (configured once, in the Hub; nothing is needed on the Clear NDR side).',
      ],
      items: [
        'the **API token** is the only thing to obtain in advance. In the Clear NDR web UI: user menu → **User Settings → Edit Token → Regenerate** — 40 hex characters; some builds have a dedicated **Accounts → Token list** page;',
        'what it is for: the token signs every REST API request with the **`Authorization: Token <token>`** header and acts as your account — the account needs rule-management rights (`rules.source_edit`, `rules.ruleset_update_push`), normally an administrator;',
        'important: Clear NDR rejects the **`Bearer`** format (HTTP 401) — pick the “Token” auth type in the Hub export settings (the default);',
        '30-second check: `curl -sk "https://clearndr.local/rest/rules/source/?name=__probe__" -H "Authorization: Token <token>"` → HTTP 200; or the ready-made `scripts/clearndr-check.sh` — it also lists existing sources and rulesets;',
        'security: pass the token via environment variables, never commit it to git; **Regenerate** revokes the old token instantly.',
      ],
      diagrams: [
        {
          src: '/diagrams/clearndr-schemes-en.png',
          alt: 'Two delivery schemes to Clear NDR',
          caption: 'Both schemes deliver the same file — the final set after deduplication and SID remap (1e9+ block). Solid arrows — file delivery, dashed — scheduled runs.',
          minW: 620,
          maxW: 700,
        },
      ],
    },
    {
      trigger: 'Clear NDR integration: setup and auto-update',
      order: ['steps', 'diagrams', 'items'],
      steps: [
        {
          title: '1. PUSH — configure the Hub (5 fields)',
          text: 'The “Settings” tab → “Export to Clear NDR”: mode **Clear NDR REST**, base URL (the root only, e.g. `https://clearndr.local`, without `/rest` — it is appended automatically), auth type **Token**, the API token, the source name (“NDR Rules Hub”), and the **“Apply ruleset after upload”** flag. Click “Export to Clear NDR”. Nothing is needed on the Clear NDR side — the source is created automatically on the first push.',
        },
        {
          title: '2. PUSH — auto-update',
          text: 'Enable the schedule (cron, e.g. `0 4 * * *`) and the “Export after build” flag in the Hub “Settings” — on schedule the Hub itself: fetches sources → rebuilds the file → pushes it to Clear NDR → applies the ruleset (update_push_all, Suricata restart). An alternative for a custom schedule is `scripts/clearndr-push.sh` in cron on any server.',
        },
        {
          title: '3. PULL — configure Clear NDR (script)',
          text: 'The idempotent `scripts/clearndr-setup-pull.sh` (variables `CLEAR_NDR_URL`, `CLEAR_NDR_TOKEN`, `HUB_URL=http://<hub>:3080/api/export`) creates the URL source, the “NDR Rules Hub” ruleset, enables the category and applies the ruleset — 5 checked steps. The same manually: Sources → Add source (Source type: URL, Data type: “Individual Signatures file”) → Rulesets → Add ruleset → tick the category → Suricata → Update.',
        },
        {
          title: '4. PULL — auto-update',
          text: 'In the Clear NDR UI: **Suricata → Update** → enable Reload and Push, set the **Recurrence** (e.g. Daily) — the built-in celery scheduler fetches the fresh file from the Hub, imports the rules and restarts Suricata. Or a system cron on any server: once a day `POST /rest/suricata/update_push_all/` — “all in one”: update → generate → push.',
        },
      ],
      diagrams: [
        {
          src: '/diagrams/clearndr-push-en.png',
          alt: 'PUSH: the Scirius REST API call chain',
          caption: 'PUSH: what the Hub does on export — all branches (source found/not found, SID conflict, apply flag). Every step is visible in the “Logs” tab (export scope).',
          minW: 760,
        },
        {
          src: '/diagrams/clearndr-pull-en.png',
          alt: 'PULL: scheduled update by the Clear NDR scheduler',
          caption: 'PULL: scheduled update — the Clear NDR celery worker fetches the file from the Hub, rebuilds the ruleset and restarts Suricata.',
          minW: 760,
        },
      ],
      items: [
        '**HTTP 401 “Invalid token”** — the token is wrong/was regenerated: create a new one (Edit Token → Regenerate); the header must be `Token`, not `Bearer`;',
        '**HTTP 404 on /rest/…** — the base URL contains an extra path: set the root only in the Hub settings, `/rest` is appended automatically;',
        '**HTTP 400 “conflicting SID”** — the file contains duplicates: enable deduplication in the build settings (dedupContent, dropIncompatible) and rebuild;',
        '**file uploaded but no rules in the ruleset** — the source category is not enabled in the ruleset (step 3 of the PULL scenario);',
        '**test without a production server** — the Clear NDR mock: `python3 scripts/clearndr-mock-server.py`, then the “Clear NDR REST” mode with URL `http://127.0.0.1:8080` and token `mock-clearndr-token`.',
      ],
      footnote: 'Control points: the Hub “Logs” tab (export scope) — push steps; Clear NDR → History — update_source / update_push_all records; Suricata — rules_count in Rulesets.',
      outroLink: {
        before: 'Full guide: curl commands for both schemes, endpoint reference, troubleshooting and the adoption checklist —',
        label: 'docs/clearndr-integration.en.md',
        after: '',
        href: REPO + '/blob/main/docs/clearndr-integration.en.md',
      },
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
              {(s.order ?? DEFAULT_ORDER).map((kind) => {
                if (kind === 'paragraphs') {
                  return <React.Fragment key={kind}>{s.paragraphs?.map((p, i) => <p key={i}><Rich text={p} /></p>)}</React.Fragment>
                }
                if (kind === 'items') {
                  return s.items && (
                    <ul key={kind} className="space-y-1">
                      {s.items.map((li, i) => <Li key={i}><Rich text={li} /></Li>)}
                    </ul>
                  )
                }
                if (kind === 'steps') {
                  return (
                    <React.Fragment key={kind}>
                      {s.steps?.map((st) => (
                        <div key={st.title}>
                          <div className="font-medium text-foreground">{st.title}</div>
                          <p className="text-muted-foreground"><Rich text={st.text} /></p>
                        </div>
                      ))}
                    </React.Fragment>
                  )
                }
                return <React.Fragment key={kind}>{s.diagrams?.map((d) => <Diagram key={d.src} d={d} />)}</React.Fragment>
              })}
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
