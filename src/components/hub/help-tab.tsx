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
        'собрать в одном месте проверенные источники правил — в каталоге уже 36 преднастроенных наборов, от официальных правил Talos до открытых фидов, плюс свои источники по URL/архиву/локальному файлу;',
        'загружать их по расписанию с учётом лимитов и авторизации (oinkcode, abuse.ch Auth-Key, basic), с кэшем и зеркалами на случай сбоя основного URL;',
        'устранять дубликаты и конфликты SID, из-за которых импорт в Clear NDR отказывает;',
        'конвертировать списки индикаторов (IP/домены/URL) в правила Suricata и фильтровать несовместимые с Suricata конструкции;',
        'управлять итоговым набором через категории (classtype) и отдельные правила — выключатель SID переживает обновление источников;',
        'собрать один итоговый файл и доставить его в Clear NDR — вручную, через REST API (PUSH), по pull-схеме с токенами или из локального каталога;',
        'наполнять пустые разделы OpenSearch Dashboards (Alerting, Anomaly, Security Analytics) дашбордами по данным EVE;',
        'обновлять сам Clear NDR до новой версии одним запуском — с бэкапами и автооткатом;',
        'при необходимости загружать правила через WireGuard VPN, не теряя доступ к самому сервису;',
        'следить за сервером и местом на диске: дашборды на «Обзоре» (CPU, память, диски, контейнеры, скорость интерфейсов и туннеля) и автоочистка при нехватке места — старые индексы OpenSearch, логи, кэш — с уведомлениями в Telegram (с поддержкой прокси) и Gotify;',
        'в редакции Enterprise — работать нескольким пользователям с регистрацией, верификацией и персональными токенами скачивания.',
      ],
    },
    {
      trigger: 'Принципы работы: конвейер обработки',
      steps: [
        {
          title: '1. Источники',
          text: 'Каталог источников (вкладка «Источники», 36 преднастроенных): официальные наборы snort.org (registered по oinkcode, community), ET Open, PT Open Ruleset и PT Attack Detection, Quadrant, OISF Traffic ID, фиды abuse.ch, наборы из индекса EveBox Rules (PAW Patrules, The Hunters Ledger, AntiPhishing и др.), конвертеры списков IP/доменов и локальные архивы. У каждого источника — тип авторизации (oinkcode / auth-key / basic / без авторизации), приоритет, флаг включения и свои источники пользователей (Enterprise). Удалённые источники попадают в корзину: правила сохраняются, источник можно восстановить.',
        },
        {
          title: '2. Загрузка',
          text: 'HTTP(S)-загрузка с авторизацией: для snort.org ссылки приводятся к канонической форме `/reg-rules/<файл>/<oinkcode>`, архив проверяется по magic-байтам gzip, поддерживаются кэш (`cacheTtlMinutes`), свой User-Agent и зеркала (`extra.mirrorUrls` — при сетевой ошибке или не-200 основном URL по очереди пробуются зеркала). При сбое используется ранее скачанный архив. Учитывайте лимиты snort.org: registered — не чаще раза в 15 минут.',
        },
        {
          title: '3. Парсинг и конвертация',
          text: 'Правила разбираются на атрибуты (SID, rev, msg, classtype, протокол, направление) и проверяются на совместимость с Suricata. Списки индикаторов (IP, домены, URL) конвертируются в правила Suricata с SID из приватного диапазона — с настройками sidStart, msgPrefix, perRule, maxRules.',
        },
        {
          title: '4. Дедупликация',
          text: 'Внутри источника и между источниками устраняются дубликаты: по SID (стратегии highest-rev / source-priority / renumber-private) и по содержимому правила (content hash). Отдельно гасится конфликт «conflicting SID» — причина отказов импорта в Clear NDR.',
        },
        {
          title: '5. Фильтр совместимости и сборка',
          text: 'Несовместимые с Suricata конструкции (Snort 2: preproc, react, rawbytes…; Snort 3: keystore, pkt_trace…) отсекаются на этапе сборки (dropIncompatible), опционально скрываются отключённые правила (dropDisabledMsg). Итог: файл с именем из настроек, SHA-256 и статистикой. Готовый офлайн-пакет (каталог dist/) дополнительно проходит цикл валидации реальным движком `suricata -T` до нуля ошибок.',
        },
        {
          title: '6. Экспорт',
          text: 'Четыре способа доставки в Clear NDR: 1) скачать файл и импортировать вручную (вкладка «Сборка и экспорт» → «Скачать итоговый файл»); 2) Clear NDR REST — нативная интеграция: Hub сам находит/создаёт источник и загружает файл через REST API Scirius (upload → update_push_all), нужен API-токен Clear NDR (меню пользователя → Edit Token); 3) pull — Clear NDR сам забирает файл по URL Hub (/api/export) и обновляется по встроенному расписанию (Suricata → Update → Recurrence); 4) HTTP POST на произвольный эндпоинт или копирование в каталог volume. Отдача по URL — единым файлом или tgz-архивом по источникам, с опциональным ключом и персональными токенами. Автоматизация — по расписанию (cron в «Настройках») или кнопкой «Полный цикл». Пошаговая инструкция с командами — docs/clearndr-integration.md.',
        },
      ],
      footnote: 'Все шаги видны в «Журнале»; состояния источников (ОК/ошибка/кэш) — на вкладке «Источники»; состав итогового набора — на вкладках «Категории» и «Правила».',
    },
    {
      trigger: 'Категории, правила и корзина источников',
      paragraphs: [
        'Итоговый набор управляется дважды: сначала включёнными источниками, затем фильтром категорий и правил: **итоговый сет = включённые источники ∩ включённые категории ∩ не отключённые правила**.',
      ],
      items: [
        '**Категории** — правила включённых источников группируются по `classtype`: категорию можно включить/выключить в сборке, переименовать или скрыть;',
        '**Правила** — вкладка «Правила»: поиск по SID, тексту и источнику, просмотр тела правила; выключатель отдельного SID (в карточке правила из «Категорий») сохраняется в базе и переживает перезагрузку источников и пересборку;',
        '**Корзина источников** — удаление с сохранением правил в базе, восстановление и полное удаление; имена удалённых builtin-источников не восстанавливаются «докаткой» каталога;',
        '**Докатка каталога** — при обновлении Hub новые преднастроенные источники появляются автоматически, без пересоздания БД; пользовательские настройки (вкл/выкл, приоритет, заметки) не перезаписываются.',
      ],
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
          text: 'Идемпотентный скрипт `scripts/clearndr-setup-pull.sh` (переменные `CLEAR_NDR_URL`, `CLEAR_NDR_TOKEN`, `HUB_URL=http://<hub>:3080/api/export`, `HUB_TOKEN` — ключ отдачи, если задан) создаст источник-URL, набор «NDR Rules Hub», включит категорию и применит набор — 5 шагов с проверками. Готовые URL и генерация ключа — на вкладке «Сборка» → «Отдача по URL». Те же шаги вручную: Sources → Add source (Source type: URL, Data type: «Individual Signatures file» для файла или «Signatures archive» для `?archive=1`) → Rulesets → Add ruleset → отметить категорию → Suricata → Update.',
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
        '**PULL: ключ отдачи** — задайте его на вкладке «Сборка» → «Отдача по URL» и укажите в поле authkey источника Clear NDR (scirius отправит его в заголовке Authorization) или добавьте к URL `?token=…`; скрипт-настройщик сделает это сам через `HUB_TOKEN`;',
        '**PULL: архив по источникам** — `GET /api/export?archive=1` отдаёт tgz для источника с datatype «sigs»: каждый `<источник>.rules` станет отдельной категорией (файлы в корне архива — так требует парсер tar scirius);',
        '**PULL: scirius не проверяет HTTP-статус** — при ошибке отдачи (403/404) он записывает тело ответа в файл и источник падает на разборе правил; внятный текст ошибки хаба покажет причину (неверный ключ, нет сборки, нет архива);',
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
      trigger: 'Обновление Clear NDR на новую версию',
      paragraphs: [
        'Вкладка «Обновление Clear NDR» обновляет сам Clear NDR Community (docker-стек под управлением `stamusctl`) до новой версии, не теряя ни одной настройки: источники, наборы, включённые категории, remap SID, пороги/подавления, пользователи и API-токены, конфигурация Suricata/nginx и сертификаты.',
      ],
      steps: [
        {
          title: 'Как это работает',
          text: 'Вкладка определяет установленную версию → находит последний релиз stamusctl-templates → при наличии более новой предлагает выбрать опции (сохранение данных OpenSearch/PostgreSQL, бэкапы, обновление CLI stamusctl) и запускает обновление одним кликом. Скрипт `scripts/clearndr-update.sh` выполняется на хосте (SSH или local — когда хаб в контейнере на хосте с Clear NDR), лог идёт в реальном времени, при сбое — автооткат, после — проверки: контейнеры, web UI, REST API.',
        },
        {
          title: 'Защита данных',
          text: 'Анализ совместимости данных ДО остановки стека (смена мажорной версии OpenSearch/PostgreSQL — с выбором: сохранить, показать шаги ручной конвертации или обновиться с чистыми данными); три уровня бэкапов; бэкап-гейт и защита отката; самовосстановление пропавшего `config/docker-compose.yaml`, валидация `docker compose config`, автопатч секции `networks` (гэп шаблонов 3.3.x); интеграция mikrocata2selks (MikroTik) с восстановлением `suricata.interfaces`.',
        },
        {
          title: 'Ремонт повреждённого config/',
          text: 'Отдельный скрипт `scripts/clearndr-repair-stack.sh` реконструирует compose-стек из работающих контейнеров и восстанавливает bind-файлы — когда `config/` инстанса повреждён или потерян.',
        },
      ],
      outroLink: {
        before: 'Подробная инструкция: как устроено обновление, что сохраняется, аварийные пути —',
        label: 'docs/clearndr-update.md',
        after: '',
        href: REPO + '/blob/main/docs/clearndr-update.md',
      },
    },
    {
      trigger: 'Дашборды OpenSearch',
      paragraphs: [
        'Раздел наполняет пустые «с завода» разделы OpenSearch Dashboards (OSD) — **Alerting**, **Anomaly Detection**, **Security Analytics** — данными Suricata EVE (`logstash-*`) и добавляет каталог дополнительных pack-дашбордов (HTTP, TLS, files и др.).',
      ],
      items: [
        '**Alerting** — мониторы с префиксом «NDR ·»: критические алерты Suricata, всплески severity 2, DNS-флуд, активность fileinfo, всплеск потоков; срабатывания пишутся в индекс аудита `ndr-alerts-audit` (работает без SMTP/Slack);',
        '**Anomaly Detection** — ML-детекторы аномалий объёма трафика и DNS-запросов по источникам;',
        '**Автоподбор index-pattern по данным** — паттерн выбирается/создаётся по фактическому индексу с EVE-событиями, поля синхронизируются из `_field_caps` (включая keyword-поля для агрегаций) — иначе OSD отвечает «Could not locate that index-pattern-field»;',
        '**Режимы** — импорт, проверка (--check: данные/поля/паттерны без изменений), удаление (--remove — по точным id, с бэкапами); прогоны видны во вкладке с живым логом, зависший прогон можно остановить;',
        '**Пустой OSD 3.x** — если OSD отвечает пустым экраном, скрипт починит `workspace.enabled=false` (правка bind-файла + restart).',
      ],
      outroLink: {
        before: 'Состав мониторов, детекторов и дашбордов —',
        label: 'docs/osd-analytics.md',
        after: '',
        href: REPO + '/blob/main/docs/osd-analytics.md',
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
        'зеркала (`extra.mirrorUrls`) — при сетевой ошибке или не-200 ответе основного URL по очереди пробуются зеркала; в зеркала тоже подставляется авторизация (`%%AUTHKEY%%`);',
        'свой User-Agent (`userAgent` в extra) — некоторые серверы (например, ptrules.com) блокируют не-браузерный UA;',
        'фиды abuse.ch (ThreatFox, URLhaus) требуют бесплатный Auth-Key: auth.abuse.ch → Create Key → вставить в «Настройках»; без ключа сервер отвечает HTTP 401/410;',
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
        'поднятый туннель нельзя поднять повторно — сервер отклоняет второй «up» с 409, а кнопка «Поднять» недоступна по фактическому состоянию `wg show interfaces` (раньше повторное нажатие сносило и поднимало туннель заново, подвешивая web UI); переподключение — «Опустить», затем «Поднять»;',
        'при потерянном доступе к UI: `docker compose exec rules-hub wg-quick down /app/data/wireguard/wg0.conf` или `docker compose restart rules-hub`;',
        'включается флагом «Гнать загрузки через WireGuard» в «Настройках».',
      ],
    },
    {
      trigger: 'Капча, двухфакторная аутентификация и рассылка о версиях',
      paragraphs: [
        'Вход и регистрация защищены **одноразовой SVG-капчей**: сервер рисует искажённый текст (случайные шрифты, наклоны каждого символа, волнистые линии, шум), ответ никогда не покидает сервер. Капча **сгорает после каждой попытки ввода**, живёт 2 минуты и выдаётся не чаще 30 картинок за 10 минут с одного IP — сервисы подбора не получают повторов, фарм экономически бессмыслен.',
        '**Двухфакторная аутентификация обязательна** (кроме bootstrap-администратора, который может настроить её позже). Метод выбирается при регистрации: **Telegram** — код в чат бота, или **TOTP** — код из приложения-аутентификатора (Google Authenticator/Authy/FreeOTP).',
      ],
      items: [
        '**Telegram**: при регистрации укажите username; Telegram запрещает ботам писать первыми, поэтому откройте бота по ссылке на экране и отправьте /start — поллер хаба привяжет чат и немедленно пришлёт отложенный код. Бот настраивается в «Интеграции → Уведомления и сервисы» (токен @BotFather, поддерживается прокси);',
        '**TOTP**: сервер выдаёт секрет, QR-код и ключ для ручного ввода; код проверяется с окном ±1 шаг 30 секунд. Если картинка QR потерялась — «Показать QR» возвращает QR ТЕКУЩЕГО секрета (уже отсканированный продолжает работать); «Пересоздать ключ» выпускает новый секрет — после него обязателен повторный скан;',
        '**Второй шаг входа**: после верного пароля выдаётся HMAC-билет (cookie ndrh_mfa, 5 минут); сессия создаётся только после кода. У кода 5 попыток ввода и срок 5 минут, лимит verify-эндпоинта — 10 попыток за 5 минут с IP;',
        '**Кабинет «Аккаунт»**: смена метода (требуется код НОВОГО метода — нельзя заблокировать себя ошибочной настройкой), выпустить код, тест чата, показать/пересоздать TOTP-QR, выключить 2FA (с паролем);',
        '**Администратор** может сбросить 2FA пользователю на вкладке «Пользователи» («Сброс 2FA») — если тот потерял доступ к Telegram и приложению;',
        '**Рассылка о версиях**: при обновлении хаба всем учётным записям с привязанным Telegram приходит сообщение о новой версии (одна рассылка на версию); текст «что нового» задаётся в «Интеграции → Уведомления и сервисы», есть кнопка «Разослать сейчас»;',
        '**Липкое меню**: меню-бар закреплён под шапкой при прокрутке страницы.',
      ],
    },
    {
      trigger: 'Редакции Community и Enterprise: пользователи и токены',
      paragraphs: [
        'Один и тот же Docker-образ работает в двух редакциях: **Community** (по умолчанию) — всё доступно без входа, как раньше; **Enterprise** (`NDR_EDITION=enterprise`) — многопользовательский режим с регистрацией и персональными токенами.',
      ],
      items: [
        '**Регистрация и верификация** — пользователь регистрируется на экране входа; аккаунт активирует администратор (без верификации кабинет недоступен); первый зарегистрированный становится администратором; регистрацию можно закрыть в разделе «Пользователи»;',
        '**Кабинет пользователя** — урезанный набор вкладок: Обзор, Источники, Категории, Правила, Сборка и экспорт, Обновление Clear NDR, Дашборды OpenSearch, Помощь, О системе; VPN, Настройки, Журнал и Пользователи — только у администратора; свои источники (ownerId) видны владельцу и админу;',
        '**Токены скачивания** — персональные токены `ndrt_…` для PULL-схемы: добавить к URL (`?token=…`) или в поле authkey источника Clear NDR (scirius передаст его в заголовке Authorization); в БД только SHA-256 — полный токен виден один раз; есть срок действия, отзыв и статистика скачиваний (вкладка «Сборка и экспорт» → «Токены скачивания правил»);',
        '**Защита** — rate limit по IP на всех эндпоинтах (429 + Retry-After); анти-брутфорс: вход (по IP, email и блок учётной записи) и ключи/токены отдачи (10 неудач за 5 мин → блок 15 мин); очередь тяжёлых операций (сборка/загрузка/отдача — 429 при переполнении); троттлинг канала отдачи (`downloadBandwidthKbps`); CSRF-проверки (Sec-Fetch-Site/Origin); пароли scrypt, SHA-256 токенов, security-заголовки;',
        '**Журнал событий безопасности** — раздел «Пользователи» показывает последние 100 событий: входы, блокировки, верификации.',
      ],
      outroLink: {
        before: 'Архитектура многопользовательского режима и REST-спецификация —',
        label: 'docs/developer.md · openapi.json',
        after: '',
        href: REPO + '/blob/main/docs/developer.md',
      },
    },
    {
      trigger: 'Диагностика типовых проблем',
      items: [
        '**HTTP 422** у snort.org — почти всегда «Invalid oinkcode»: проверьте код в «Настройках» (40 символов, без пробелов);',
        '**HTTP 403 / 429** — дневной/частотный лимит загрузок: подождите 15–30 минут или включите кэш;',
        '**HTTP 401/410 у abuse.ch** — нет или неверный Auth-Key: создайте ключ на auth.abuse.ch и вставьте в «Настройках»;',
        '**«not in gzip format»** — исправлено с v1.5.0: архив теперь проверяется по magic-байтам, а ссылки личного кабинета snort.org автоматически приводятся к каноническому виду;',
        '**«Ошибка связи с API»** — бэкенд недоступен: смотрите `docker logs ndr-rules-hub` и `GET /api/health`;',
        '**зависший прогон OSD/обновления** — вкладка реанимирует запуск после пересоздания контейнера (проверка pid по возрасту процесса); экстренное снятие блокировки — rc=143 («остановлен»), описано в docs/clearndr-update.md;',
        'схема БД восстанавливается автоматически: при расхождении с манифестом образа недостающие таблицы/колонки докатываются в живую базу без потери данных (бэкап перед изменениями — `data/hub.db.preheal-*`); если база нечитаема — она бэкапится в `data/hub.db.bak-*` и создаётся заново;',
        '**P2022 «column … does not exist»** — устаревшая схема БД тома: перезапустите контейнер (`docker compose restart ndr-rules-hub`) — entrypoint сам докатит схему;',
        '**«database disk image is malformed»** — файл БД повреждён (часто после аварийного выключения сервера или заполненного диска): перезапустите контейнер — `db-heal` сначала проверяет базу целиком (`PRAGMA integrity_check`), при провале восстанавливает её из последнего здорового снимка (`hub.db.preheal-*`/`hub.db.bak-*`), и только если снимков нет — бэкапит файл и создаёт базу заново (ключ abuse.ch вводится повторно).',
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
        '**dropIncompatible** — не включает в сборку конструкции, несовместимые с Suricata (replace, rawbytes и др.); несовместимое правило помечается флагом совместимости и в итоговый набор не попадает;',
        'офлайн-пакет dist/ дополнительно проходит цикл валидации движком `suricata -T` до нуля ошибок — невалидированный набор не публикуется.',
      ],
    },
    {
      trigger: 'Мониторинг сервера, автоочистка диска и уведомления',
      paragraphs: [
        '**Обзор** показывает системные дашборды (только администратору, обновление каждые 5 с): утилизация CPU и память сервера (данные /proc хоста), аптайм, тома дисков с подсветкой порогов занятости, скорость и трафик сетевых интерфейсов, пиры и скорость WireGuard-туннеля, список запущенных контейнеров (docker ps через смонтированный /var/run/docker.sock:ro). Самое важное — свободное место: том данных хаба помечен значком, при превышении порогов (85 % / 92 %) сверху появляется баннер с кнопками действий.',
      ],
      items: [
        '**Что будет удалено** — dry-run без удаления: перечень кандидатов по каждому шагу; **Очистить сейчас** — реальный прогон. Оба — на «Обзоре» и в «Настройках → Диск и автоочистка»;',
        '**Шаги очистки включаются по отдельности**: кэш хаба (data/cache и .pack-* — пересоздаются), каталоги логов (активные eve.json/fast.log/stats.log не трогаются никогда — место освобождают только ротации), индексы OpenSearch (только разрешённые префиксы logstash-/ndr-/eve-/suricata-/selks- старше N дней; системные .kibana не трогаются; лимит на число индексов за прогон, самые старые первыми), большие файлы (поиск только в явно перечисленных каталогах; по умолчанию — только отчёт);',
        '**Автоочистка** — по cron-проверке (по умолчанию ежечасно на 17-й минуте): при занятости ≥ порога запускается очистка включёнными шагами до достижения цели свободного места; уведомления о порогах — не чаще раза в 6 часов на уровень;',
        '**Telegram** — токен бота (@BotFather) + chat_id (подсказка, как узнать), прокси http(s)://user:pass@host:port или socks5://, можно свой Bot API Server; кнопка «Тест»;',
        '**Gotify** — URL + app-токен; свой сервер разворачивается кнопкой «Развернуть Gotify» (контейнер gotify/server, /health, шаблоны docker-compose/Caddy/nginx и инструкция по домену, DNS и TLS сохраняются в data/gotify/) или скриптом scripts/gotify-deploy.sh на хосте (см. docs/gotify.md);',
        '**События** включаются по отдельности: конвейер правил (итог цикла/ошибки), WireGuard (подъём/остановка/ошибки), диск (пороги и результаты очистки).',
      ],
      footnote: 'Всё, что не входит в явно разрешённые списки (префиксы индексов, каталоги логов/файлов), никогда не удаляется. Журнал прогонов — вкладка «Журнал» (scope cleanup).',
    },
  ],
  en: [
    {
      trigger: 'Purpose: goals and objectives',
      paragraphs: [
        '**NDR Rules Hub** is a companion service for the **Clear NDR** system (Stamus Networks): it automates the full cycle of working with Snort/Suricata rulesets that feed network detection.',
      ],
      items: [
        'bring proven rule sources together in one place — the catalog already ships 36 preconfigured sets, from official Talos rules to open feeds, plus your own sources by URL/archive/local file;',
        'download them on a schedule, respecting rate limits and authentication (oinkcode, abuse.ch Auth-Key, basic), with caching and mirrors as a fallback for the primary URL;',
        'eliminate duplicates and SID conflicts that make Clear NDR imports fail;',
        'convert indicator lists (IP/domains/URLs) into Suricata rules and filter Suricata-incompatible constructs;',
        'manage the final ruleset through categories (classtype) and individual rules — a per-SID toggle survives source refreshes;',
        'produce a single final file and deliver it to Clear NDR — manually, via the REST API (PUSH), a pull scheme with tokens, or from a local directory;',
        'populate the empty OpenSearch Dashboards sections (Alerting, Anomaly, Security Analytics) with EVE-data dashboards;',
        'update Clear NDR itself to a new version in one run — with backups and automatic rollback;',
        'when needed, download rules through a WireGuard VPN without losing access to the service itself;',
        'watch the server and disk space: dashboards on Overview (CPU, memory, disks, containers, interface and tunnel speed) plus automatic cleanup when space runs low — old OpenSearch indices, logs, cache — with notifications via Telegram (proxy support) and Gotify;',
        'in the Enterprise edition — work with multiple users, registration, verification and personal download tokens.',
      ],
    },
    {
      trigger: 'How it works: processing pipeline',
      steps: [
        {
          title: '1. Sources',
          text: 'Source catalog (the “Sources” tab, 36 preconfigured): official snort.org rulesets (registered via oinkcode, community), ET Open, PT Open Ruleset and PT Attack Detection, Quadrant, OISF Traffic ID, abuse.ch feeds, sets from the EveBox Rules index (PAW Patrules, The Hunters Ledger, AntiPhishing and more), IP/domain list converters and local archives. Each source has an auth type (oinkcode / auth-key / basic / none), a priority, an enable flag and per-user sources (Enterprise). Deleted sources go to the trash bin: rules are kept and the source can be restored.',
        },
        {
          title: '2. Fetching',
          text: 'Authenticated HTTP(S) download: snort.org links are normalized to the canonical `/reg-rules/<file>/<oinkcode>` form, the archive is verified by gzip magic bytes; caching (`cacheTtlMinutes`), a custom User-Agent and mirrors (`extra.mirrorUrls` — on a network error or non-200 of the primary URL the mirrors are tried one by one) are supported. On failure a previously downloaded archive is used. Mind the snort.org limits: registered — no more than once every 15 minutes.',
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
          title: '5. Compatibility filter and build',
          text: 'Constructs absent in Suricata (Snort 2: preproc, react, rawbytes…; Snort 3: keystore, pkt_trace…) are excluded at build time (dropIncompatible), disabled rules can be hidden (dropDisabledMsg). The result: a file named per settings, with SHA-256 and statistics. The ready offline package (dist/ directory) additionally passes a validation loop with the real `suricata -T` engine until zero errors.',
        },
        {
          title: '6. Export',
          text: 'Four delivery paths to Clear NDR: 1) download the file and import it manually (“Build & Export” tab → “Download final file”); 2) Clear NDR REST — native integration: the Hub itself finds/creates the source and uploads the file through the Scirius REST API (upload → update_push_all); a Clear NDR API token is required (user menu → Edit Token); 3) pull — Clear NDR fetches the file from the Hub URL (/api/export) and updates itself on a built-in schedule (Suricata → Update → Recurrence); 4) HTTP POST to any endpoint or copying to a volume directory. URL serving — a single file or a per-source tgz archive, with an optional key and personal tokens. Automation — by schedule (cron in “Settings”) or the “Full cycle” button. Step-by-step guide with commands — docs/clearndr-integration.en.md.',
        },
      ],
      footnote: 'All steps are visible in the “Logs” tab; source states (OK/error/cache) are on the “Sources” tab; the final ruleset composition — on the “Categories” and “Rules” tabs.',
    },
    {
      trigger: 'Categories, rules and the source trash bin',
      paragraphs: [
        'The final ruleset is managed twice: first by enabled sources, then by the category/rule filter: **final set = enabled sources ∩ enabled categories ∩ not disabled rules**.',
      ],
      items: [
        '**Categories** — rules of enabled sources are grouped by `classtype`: a category can be enabled/disabled in the build, renamed or hidden;',
        '**Rules** — the “Rules” tab: search by SID, text and source, rule body view; a per-SID toggle (in the rule card on the “Categories” tab) is stored in the database and survives source refreshes and rebuilds;',
        '**Source trash bin** — delete with rules kept in the database, restore and permanent deletion; names of deleted builtin sources are not re-created by the catalog backfill;',
        '**Catalog backfill** — when the Hub is updated, new preconfigured sources appear automatically, without recreating the DB; user settings (enabled/disabled, priority, notes) are not overwritten.',
      ],
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
      trigger: 'Updating Clear NDR to a new version',
      paragraphs: [
        'The “Clear NDR Update” tab upgrades Clear NDR Community itself (the docker stack managed by `stamusctl`) to a new version without losing a single setting: sources, rulesets, enabled categories, SID remap, thresholds/suppressions, users and API tokens, Suricata/nginx configuration and certificates.',
      ],
      steps: [
        {
          title: 'How it works',
          text: 'The tab detects the installed version → finds the latest stamusctl-templates release → if a newer one exists, offers options (keeping OpenSearch/PostgreSQL data, backups, updating the stamusctl CLI) and starts the update in one click. The `scripts/clearndr-update.sh` script runs on the host (SSH or local — when the Hub runs in a container on the host with Clear NDR), the log streams in real time, failures trigger an automatic rollback, followed by checks: containers, web UI, REST API.',
        },
        {
          title: 'Data protection',
          text: 'Data compatibility analysis BEFORE stopping the stack (a major version change of OpenSearch/PostgreSQL offers: keep the data, show manual conversion steps, or update with clean data); three backup levels; a backup gate and rollback protection; self-restoration of a missing `config/docker-compose.yaml`, `docker compose config` validation, automatic patching of the `networks` section (a 3.3.x template gap); mikrocata2selks (MikroTik) integration with `suricata.interfaces` restoration.',
        },
        {
          title: 'Repairing a damaged config/',
          text: 'A separate `scripts/clearndr-repair-stack.sh` script reconstructs the compose stack from running containers and restores bind files — when the instance’s `config/` is damaged or lost.',
        },
      ],
      outroLink: {
        before: 'Detailed guide: how the update works, what is preserved, emergency paths —',
        label: 'docs/clearndr-update.en.md',
        after: '',
        href: REPO + '/blob/main/docs/clearndr-update.en.md',
      },
    },
    {
      trigger: 'OpenSearch Dashboards',
      paragraphs: [
        'The section populates the factory-empty OpenSearch Dashboards (OSD) sections — **Alerting**, **Anomaly Detection**, **Security Analytics** — with Suricata EVE data (`logstash-*`) and adds a catalog of extra pack dashboards (HTTP, TLS, files and more).',
      ],
      items: [
        '**Alerting** — monitors prefixed “NDR ·”: critical Suricata alerts, severity 2 spikes, DNS floods, fileinfo activity, flow bursts; findings are written to the `ndr-alerts-audit` audit index (works without SMTP/Slack);',
        '**Anomaly Detection** — ML detectors for traffic volume and DNS query anomalies per source;',
        '**Data-driven index-pattern selection** — the pattern is picked/created from the index that actually holds EVE events, fields are synced from `_field_caps` (including keyword sub-fields for aggregations) — otherwise OSD answers “Could not locate that index-pattern-field”;',
        '**Modes** — import, check (--check: data/fields/patterns without changes), removal (--remove — by exact ids, with backups); runs are visible in the tab with a live log, a stuck run can be stopped;',
        '**Empty OSD 3.x** — if OSD shows a blank screen, the script fixes `workspace.enabled=false` (bind-file edit + restart).',
      ],
      outroLink: {
        before: 'The full set of monitors, detectors and dashboards —',
        label: 'docs/osd-analytics.md',
        after: '',
        href: REPO + '/blob/main/docs/osd-analytics.md',
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
        'mirrors (`extra.mirrorUrls`) — on a network error or non-200 response of the primary URL the mirrors are tried one by one; authorization (`%%AUTHKEY%%`) is substituted in mirrors as well;',
        'a custom User-Agent (`userAgent` in extra) — some servers (e.g. ptrules.com) block non-browser user agents;',
        'abuse.ch feeds (ThreatFox, URLhaus) require a free Auth-Key: auth.abuse.ch → Create Key → paste it in “Settings”; without the key the server answers HTTP 401/410;',
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
        'a raised tunnel cannot be raised again — the server rejects a second “up” with 409 and the “Up” button is disabled based on the actual `wg show interfaces` state (previously a second click tore the tunnel down and up again, hanging the web UI); to reconnect — stop, then up;',
        'if access to the UI is lost: `docker compose exec rules-hub wg-quick down /app/data/wireguard/wg0.conf` or `docker compose restart rules-hub`;',
        'enabled by the “Route downloads through WireGuard” flag in “Settings”.',
      ],
    },
    {
      trigger: 'Server monitoring, disk auto-cleanup and notifications',
      paragraphs: [
        '**Overview** shows system dashboards (administrator only, refreshed every 5 s): server CPU usage and memory (host /proc data), uptime, disk volumes with usage-threshold highlighting, network interface speed and traffic, WireGuard tunnel peers and speed, the list of running containers (docker ps via the mounted /var/run/docker.sock:ro). The most important metric — free disk space: the hub data volume is marked with an icon, and when thresholds are crossed (85 % / 92 %) an action banner appears at the top.',
      ],
      items: [
        '**What will be deleted** — a dry-run without deleting anything: the list of candidates per step; **Clean up now** — a real run. Both are on “Overview” and in “Settings → Disk & auto-cleanup”;',
        '**Cleanup steps are enabled separately**: hub cache (data/cache and .pack-* — safely recreated), log directories (active eve.json/fast.log/stats.log are never touched — only rotations free space), OpenSearch indices (allowed prefixes logstash-/ndr-/eve-/suricata-/selks- older than N days only; system indices like .kibana are untouched; per-run index limit, oldest first), large files (searched only in explicitly listed directories; report-only by default);',
        '**Auto-cleanup** — by a cron check (hourly at minute 17 by default): when usage ≥ the trigger threshold, cleanup runs through the enabled steps until the free-space target is reached; threshold notifications are throttled to once per 6 hours per level;',
        '**Telegram** — bot token (@BotFather) + chat_id (a hint explains how to find it), http(s)://user:pass@host:port or socks5:// proxy support, optional custom Bot API Server; a “Test” button;',
        '**Gotify** — server URL + app token; your own server is deployed with the “Deploy Gotify” button (gotify/server container, /health wait, docker-compose/Caddy/nginx templates plus a domain/DNS/TLS guide saved to data/gotify/) or by scripts/gotify-deploy.sh on the host (see docs/gotify.md);',
        '**Events** are enabled individually: rule pipeline (cycle result/errors), WireGuard (up/down/errors), disk (thresholds and cleanup results).',
      ],
      footnote: 'Anything outside the explicitly allowed lists (index prefixes, log/file directories) is never deleted. Run history is in the “Logs” tab (scope cleanup).',
    },
    {
      trigger: 'Captcha, two-factor authentication and release broadcasts',
      paragraphs: [
        'Sign-in and registration are protected by a **single-use SVG captcha**: the server renders distorted text (random fonts, per-character rotation, wavy lines, noise) and the answer never leaves the server. The captcha **burns after every attempt**, lives for 2 minutes and is issued at most 30 images per 10 minutes per IP — solving services get no retries, and farming is economically pointless.',
        '**Two-factor authentication is mandatory** (except the bootstrap administrator, who may set it up later). The method is chosen at registration: **Telegram** — a code in the bot chat, or **TOTP** — a code from an authenticator app (Google Authenticator/Authy/FreeOTP).',
      ],
      items: [
        '**Telegram**: enter your username at registration; Telegram forbids bots to message first, so open the bot via the on-screen link and send /start — the hub poller binds the chat and immediately delivers the pending code. The bot is configured in “Settings → Notifications” (@BotFather token, proxy supported);',
        '**TOTP**: the server issues a secret, a QR code and a manual key; codes are verified with a ±1 step (30 s) window. If the QR picture is lost — “Show QR” returns the QR of the CURRENT secret (the already-scanned one keeps working); “Recreate key” issues a new secret — a new scan is mandatory afterwards;',
        '**Second sign-in step**: after a correct password an HMAC ticket is issued (ndrh_mfa cookie, 5 minutes); the session is created only after the code. The code has 5 attempts and a 5-minute TTL; the verify endpoint is limited to 10 attempts per 5 minutes per IP;',
        '**“Account” cabinet**: change the method (requires a code of the NEW method — you cannot lock yourself out), issue a code, test the chat, show/recreate the TOTP QR, disable 2FA (with the password);',
        '**Administrators** can reset a user’s 2FA on the “Users” tab (“Reset 2FA”) — for those who lost access to both Telegram and the app;',
        '**Release broadcasts**: when the hub is updated, every account with a bound Telegram gets a message about the new version (one broadcast per version); the “what’s new” text is configured in “Settings → Notifications”, with a “Broadcast now” button;',
        '**Sticky menu**: the menu bar stays pinned under the header while scrolling.',
      ],
    },
    {
      trigger: 'Community and Enterprise editions: users and tokens',
      paragraphs: [
        'The same Docker image ships in two editions: **Community** (default) — everything is available without signing in, as before; **Enterprise** (`NDR_EDITION=enterprise`) — multi-user mode with registration and personal tokens.',
      ],
      items: [
        '**Registration and verification** — a user registers on the sign-in screen; an administrator activates the account (without verification the cabinet is unavailable); the first registered account becomes the administrator; registration can be closed in the “Users” section;',
        '**User cabinet** — a reduced set of tabs: Overview, Sources, Categories, Rules, Build & Export, Clear NDR Update, OpenSearch Dashboards, Help, About; VPN, Settings, Logs and Users are administrator-only; own sources (ownerId) are visible to the owner and admins;',
        '**Download tokens** — personal `ndrt_…` tokens for the PULL scheme: append to the URL (`?token=…`) or put into the authkey field of a Clear NDR source (scirius sends it as the Authorization header); only the SHA-256 is stored — the full token is shown once; expiry, revocation and download statistics are available (“Build & Export” tab → “Rule download tokens”);',
        '**Protection** — per-IP rate limit on every endpoint (429 + Retry-After); brute-force protection: sign-in (by IP, email and account lock) and serving keys/tokens (10 failures per 5 min → 15 min block); a queue for heavy operations (build/fetch/serving — 429 when saturated); serving bandwidth throttling (`downloadBandwidthKbps`); CSRF checks (Sec-Fetch-Site/Origin); scrypt passwords, SHA-256 token hashing, security headers;',
        '**Security event log** — the “Users” section shows the last 100 events: sign-ins, lockouts, verifications.',
      ],
      outroLink: {
        before: 'Multi-user architecture and the REST specification —',
        label: 'docs/developer.md · openapi.json',
        after: '',
        href: REPO + '/blob/main/docs/developer.md',
      },
    },
    {
      trigger: 'Troubleshooting common problems',
      items: [
        '**HTTP 422** from snort.org — almost always “Invalid oinkcode”: check the code in “Settings” (40 characters, no spaces);',
        '**HTTP 403 / 429** — daily/rate limit on downloads: wait 15–30 minutes or enable caching;',
        '**HTTP 401/410 from abuse.ch** — a missing or wrong Auth-Key: create a key at auth.abuse.ch and paste it in “Settings”;',
        '**“not in gzip format”** — fixed since v1.5.0: the archive is now verified by magic bytes, and snort.org personal-cabinet links are automatically normalized to the canonical form;',
        '**“API communication error”** — the backend is unreachable: check `docker logs ndr-rules-hub` and `GET /api/health`;',
        '**stuck OSD/update run** — the tab revives a run after the container was recreated (pid checked against process age); emergency lock removal — rc=143 (“stopped”), described in docs/clearndr-update.md;',
        'the DB schema heals itself: on a mismatch with the image manifest the missing tables/columns are added to the live database without data loss (a backup is taken first — `data/hub.db.preheal-*`); if the database is unreadable it is backed up to `data/hub.db.bak-*` and recreated;',
        '**P2022 “column … does not exist”** — an outdated volume DB schema: restart the container (`docker compose restart ndr-rules-hub`) — the entrypoint heals the schema;',
        '**“database disk image is malformed”** — the DB file is corrupted (usually after a power loss or a full disk): restart the container — `db-heal` first runs a full `PRAGMA integrity_check`; on failure it restores the database from the latest healthy snapshot (`hub.db.preheal-*`/`hub.db.bak-*`), and only if no snapshots exist it backs up the file and creates a fresh database (the abuse.ch key must be entered again).',
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
        '**dropIncompatible** — excludes Suricata-incompatible constructs from the build (replace, rawbytes, etc.); a rule with an incompatible construct is flagged and does not reach the final set;',
        'the offline dist/ package additionally passes a validation loop with the `suricata -T` engine until zero errors — an unvalidated set is never published.',
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
