<p align="center">
  <img src="public/logo.svg" width="80" alt="Логотип NDR Rules Hub">
</p>

# Архитектура NDR Rules Hub

**English version → [architecture.en.md](architecture.en.md)** · README: [README.md](README.md) · [README.en.md](README.en.md)

Документ описывает устройство системы: компоненты, модель данных, конвейеры обработки
и качества правил, механику загрузки, дедупликации и экспорта, интеграцию с Clear NDR,
VPN-слой, интерфейс и локализацию.

---

## 1. Обзор и назначение

**NDR Rules Hub** — вспомогательный сервис для NDR-платформы **Clear NDR** (Stamus Networks,
Suricata-базированной). Задача: автоматизировать полный цикл работы с наборами правил
Snort/Suricata — от источников до итогового файла, готового к импорту в Clear NDR.

Ключевые проблемы, которые закрывает система:

- **разрозненные источники** — официальные наборы Talos (snort.org), ET Open, PT Attack Detection,
  Quadrant, OISF, фиды abuse.ch и десятки конвертеров списков индикаторов живут по разным URL,
  с разной авторизацией и лимитами;
- **дубликаты и конфликты SID** — главная причина отказов импорта в Clear NDR
  («conflicting sid»);
- **несовместимость Snort → Suricata** — синтаксис Snort 3 (sticky-буферы, `soid`, `file`,
  inline-модификаторы) ломает загрузку в Suricata;
- **ручной труд** — без сервиса обновление правил — это ручное скачивание, конвертация и
  проверка по расписанию.

Принцип надёжности: **невалидированный набор не может попасть в Clear NDR** — итоговый файл
прогоняется через реальный движок Suricata (`suricata -T`), и экспорт блокируется до нуля ошибок.

Доставка набора в Clear NDR тоже автоматизирована: **PULL** (Clear NDR сам забирает файл с Hub
по расписанию) или **PUSH** (Hub отправляет сам через REST API Scirius по токену). Пошаговая
инструкция с командами — [docs/clearndr-integration.md](docs/clearndr-integration.md),
архитектура интеграции — раздел 12.

## 2. Компонентная схема

```mermaid
flowchart TB
    Browser["Браузер<br/>Web UI · 9 вкладок · RU/EN"]

    subgraph DOCKER["Docker-контейнер (standalone)"]
        subgraph NEXTJS["Next.js 16 — единый сервер: UI + REST API · порт 3080 → 3000"]
            UI["Web UI<br/>app/page.tsx · components/hub"]
            API["REST API<br/>app/api — route handlers"]
            I18N["i18n<br/>lib/i18n — словари RU/EN,<br/>детект языка, переключатель в шапке"]
            subgraph ENGINE["Доменный движок — lib/engine"]
                direction LR
                FETCHER["fetcher.ts<br/>загрузка источников<br/>http · tarball · local"]
                PARSER["parser.ts<br/>разбор правил<br/>Snort 2/3 · Suricata"]
                CONVERT["convert.ts · sidmap.ts<br/>списки → правила,<br/>приватные диапазоны SID"]
                BUILDER["build.ts<br/>merge · дедуп · remap SID"]
                EXPORTER["exporter.ts<br/>файл · Clear NDR REST ·<br/>HTTP POST · каталог"]
                VPN["vpn.ts<br/>wg-quick up/down/status"]
                SERVICE["service.ts<br/>оркестрация · cron · сид"]
                SEED["seed.ts<br/>25 преднастроенных источников"]
            end
        end
        PRISMA[("Prisma ORM")]
        SYSLAYER["Системный слой<br/>wireguard-tools · iptables ·<br/>iproute2 · procps (sysctl)"]
    end

    subgraph EXT["Внешние системы"]
        SOURCES["Источники правил<br/>snort.org · ET Open ·<br/>PT Attack Detection · abuse.ch …"]
        CLEARNDR["Clear NDR<br/>NDR-платформа на Suricata"]
    end

    DB[("SQLite (WAL)<br/>data/hub.db")]
    VOLUME[("Volume ./data → /app/data<br/>БД · кэш архивов · data/exports ·<br/>sidmap.json · wg-конфиги")]

    Browser -- "HTTP :3080" --> UI
    UI -- "fetch JSON" --> API
    UI -.- I18N
    API --> SERVICE
    FETCHER -- "applyAuth + magic-байты gzip" --> SOURCES
    EXPORTER -- "итоговый .rules<br/>REST API / файл / каталог" --> CLEARNDR
    VPN --> SYSLAYER
    SERVICE --> PRISMA
    PRISMA --> DB
    DB -.- VOLUME

    classDef ui fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a
    classDef engine fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef ext fill:#fef9c3,stroke:#ca8a04,color:#713f12
    classDef store fill:#f3e8ff,stroke:#9333ea,color:#581c87
    classDef sys fill:#f1f5f9,stroke:#64748b,color:#0f172a
    class UI,API,I18N ui
    class FETCHER,PARSER,CONVERT,BUILDER,EXPORTER,VPN,SERVICE,SEED engine
    class SOURCES,CLEARNDR ext
    class DB,VOLUME,PRISMA store
    class SYSLAYER sys
```

Сервер один: Next.js обслуживает и UI, и API. «Бэкенда» отдельно не существует — если страница
открылась, API доступен. Данные переживают пересоздание контейнера за счёт volume `./data`.

## 3. Модель данных (Prisma / SQLite)

Схема — `prisma/schema.prisma`. Клиент генерируется с `binaryTargets = ["native",
"debian-openssl-3.0.x"]` (builder `oven/bun` ≠ runtime `node:22-bookworm-slim`).

| Модель | Назначение | Ключевые поля |
|---|---|---|
| `Source` | источник правил | `category` (ruleset / ip-list / domain-list / url-list), `kind` (url / tarball / local), `authType` (none / oinkcode / authkey / basic), `extraJson` (параметры конвертера и авторизации), `priority` (меньше = главнее), `status`, `badge`, `builtin` |
| `Rule` | правило конкретного источника | `sid`, `rev`, `action`, `proto`, `msg`, `raw`, `contentHash` (канонический SHA-1 без sid/rev/msg/metadata), `suricataOk`, `compatNotes`; уникальность `[sourceId, sid]` |
| `Build` | результат сборки | `statsJson` (статистика по источникам/дубликатам), `policyJson` (применённые политики), `fileName`, `sha256`, `sizeBytes`, `source` (manual / cron) |
| `Setting` | настройки (k-v) | oinkcode, стратегии дедупликации, privateSidStart, cron, параметры экспорта |
| `LogEntry` | журнал событий | `level` (ok/warn/error/success), `scope`, `message` |
| `VpnProfile` | сохранённый wg-quick конфиг | `name`, `config`, `active`, `lastStatusJson` |

Надёжность БД: режим **WAL** (против «Socket timeout» при параллельных запросах) и
авто-восстановление схемы: entrypoint сверяет штамп версии (`/app/data/.schema-version`) с
образцом из образа; при несовпадении старая база бэкапится в `data/hub.db.bak-<дата>` и
создаётся новая. Штамп считается только по моделям, поэтому правки генератора не пересоздают БД.

## 4. Конвейер обработки правил

```mermaid
flowchart LR
    subgraph SRC["Источники — 25 преднастроенных + свои"]
        direction TB
        SRC1["ruleset / tarball<br/>snort.org · ET Open ·<br/>PT AD · abuse.ch"]
        SRC2["локальные файлы<br/>и каталоги"]
        SRC3["списки индикаторов<br/>ip · domain · url"]
    end

    subgraph FETCH["Загрузка — fetcher.ts"]
        direction TB
        AUTH["applyAuth():<br/>oinkcode → reg-rules/файл/code,<br/>authkey · basic"]
        CHECK{"HTTP 200<br/>и gzip 1f 8b?"}
        CACHE[("кэш архивов<br/>data/cache<br/>cacheTtlMinutes")]
    end

    PARSE["Парсинг — parser.ts<br/>заголовок + опции, многострочные,<br/>pcre со скобками"]
    CONV["Конвертация — convert.ts · sidmap.ts<br/>IP-чанки · домены · URL,<br/>приватный диапазон SID, предохранители"]

    RULES[("Prisma · Rule — по источнику<br/>sid · rev · raw · contentHash<br/>suricataOk · compatNotes")]

    subgraph BUILD["Сборка — build.ts · service.ts"]
        direction TB
        MERGE["mergeSources(): конфликт SID →<br/>highest-rev / source-priority /<br/>renumber-private · dropIncompatible"]
        CONTENT["content-дедуп: SHA-1<br/>без sid/rev/msg/metadata/reference"]
        REMAP["remapToClearndrBlock():<br/>SID → свободный блок 1e9+,<br/>общая карта sidmap.json"]
        GATE{"гейт Clear NDR:<br/>конфликтные близнецы?"}
    end

    FINAL["renderFinalFile():<br/>clearndr-import.rules,<br/>sha256 + запись Build"]
    VALID["Валидация: статический фильтр<br/>совместимости (suricataOk);<br/>офлайн-пакет — цикл suricata -T"]
    EXPORT["Экспорт — exporter.ts<br/>файл · Clear NDR REST (Token) ·<br/>HTTP POST · каталог volume"]
    CRON["cron — node-cron<br/>обновление → сборка → экспорт"]
    LOG["LogEntry: error —<br/>сборка прервана"]

    SRC1 --> AUTH
    SRC2 --> AUTH
    SRC3 --> AUTH
    AUTH --> CHECK
    CHECK -- "да: текст правил" --> PARSE
    CHECK -- "да: список ip/domain/url" --> CONV
    CHECK -- "нет: HTML, лимит, ошибка" --> CACHE
    CACHE -- "fallback: ранее скачанный архив" --> PARSE
    PARSE --> RULES
    CONV --> RULES
    RULES --> MERGE
    MERGE --> CONTENT
    CONTENT --> REMAP
    REMAP --> GATE
    GATE -- "нет: 0 близнецов" --> FINAL
    GATE -- "да" --> LOG
    FINAL --> VALID
    VALID --> EXPORT
    CRON -.-> FETCH
    CRON -.-> BUILD
```

Шаги:

1. **Загрузка (`fetcher.ts`)** — по `kind`: HTTP(S)-URL, tar.gz-архив (скачивание → проверка
   magic-байтов → `tar -xzf` → сбор всех `.rules`), локальный путь/каталог.
2. **Парсинг (`parser.ts`)** — разбор заголовка и опций правила в структуру (SID, rev, msg,
   classtype, proto, направление), поддержка многострочных правил и pcre со скобками.
3. **Конвертация списков (`convert.ts`, `sidmap.ts`)** — IP/CIDR чанками по N адресов на SID,
   домены → DNS-правила, URL → HTTP-правила; SID из приватного диапазона (`privateSidStart`,
   стандарт 1 000 000–1 999 999); предохранители `perRule`/`maxRules`.
4. **Дедупликация и сборка (`build.ts`)** — устранение дубликатов по SID и по содержимому,
   разрешение конфликтов SID, опциональная перенумерация; фильтр совместимости.
5. **Валидация** — конвертер `scripts/s2x_convert.py` + цикл `suricata -T` (для офлайн-пакета
   `dist/`; онлайн-сборка применяет статический фильтр совместимости).
6. **Экспорт (`exporter.ts`)** — пять режимов: файл для ручного импорта; **Clear NDR REST** —
   нативная интеграция (найти/создать источник → multipart-upload → `update_push_all`,
   авторизация `Authorization: Token`); HTTP POST на произвольный эндпоинт (Token/Bearer);
   копирование в каталог (общий volume); отключено. Детали — раздел 12.

## 5. Конвейер качества правил

Принцип системы: **невалидированный набор не может попасть в Clear NDR**. Качество
обеспечивается пятью гейтами — каждый блокирует дефектный материал на своём этапе.

```mermaid
flowchart TD
    subgraph G1["Гейт 1 — Загрузка · fetcher.ts"]
        direction TB
        A1{"HTTP 200?"}
        A2{"тело = gzip 1f 8b?"}
        A3[("кэш архива<br/>+ cacheNote в журнал")]
        A1 -- "нет" --> A3
        A2 -- "нет: HTML-страница лимита<br/>или личного кабинета" --> A3
        A1 -- "да" --> A2
    end

    subgraph G2["Гейт 2 — Парсинг и совместимость · parser.ts"]
        direction TB
        B1{"строка = правило<br/>(заголовок + опции)?"}
        B2{"checkSuricataCompat():<br/>preproc · react · resp · rawbytes ·<br/>asn1 · dce_* · activate/dynamic ·<br/>sticky-буферы Snort 3?"}
        BN["suricataOk = false<br/>compatNotes"]
        B1 -- "да" --> B2
        B2 -- "несовместимо" --> BN
    end

    subgraph G3["Гейт 3 — Хранение · service.ts"]
        direction TB
        C1["дедуп по SID внутри источника —<br/>остаётся максимальный rev"]
        C2["contentHash: канонический SHA-1<br/>без sid/rev/msg/metadata/reference"]
        C1 --> C2
    end

    subgraph G4["Гейт 4 — Сборка · build.ts"]
        direction TB
        D1["политики: dropDisabledMsg ·<br/>dropIncompatible · content-дедуп"]
        D2["конфликт SID → стратегия:<br/>highest-rev / source-priority /<br/>renumber-private"]
        D3["remap в свободный clearndr-блок<br/>1 000 000 000+ — карта sidmap.json,<br/>формула md5 общая с python-конвейером"]
        D4{"конфликтные близнецы —<br/>совпадают после снятия<br/>sid и reference:*?"}
        D1 --> D2
        D2 --> D3
        D3 --> D4
    end

    G5{"Гейт 5 — Валидация движком<br/>suricata -T · офлайн-пакет dist/<br/>цикл: разбор лога →<br/>исключение/исправление → повтор"}
    FAIL["СБОРКА ПРЕРВАНА — файл не пишется,<br/>LogEntry: error"]
    OK["итоговый файл: 0 дубликатов,<br/>0 конфликтов SID, 0 ошибок Suricata<br/>+ sha256 и статистика в Build"]
    EXPORT["экспорт в Clear NDR разрешён"]

    G1 --> G2
    G2 --> G3
    G3 --> G4
    D4 -- "да" --> FAIL
    D4 -- "нет" --> G5
    G5 -- "0 ошибок" --> OK
    OK --> EXPORT
```

Что делает каждый гейт:

1. **Загрузка** — плохой ответ не сохраняется как архив: magic-байты gzip проверяются до записи
   на диск (HTML-страница лимита больше не ломает tar «not in gzip format»); при неудаче работа
   продолжается от ранее скачанного кэша с явной пометкой в журнале.
2. **Парсинг и совместимость** — правило разбирается только если строка совпала с шаблоном
   заголовка; несовместимые с Suricata конструкции помечаются `suricataOk = false` с перечнем
   причин в `compatNotes` (не молча отбрасываются).
3. **Хранение** — внутри источника остаётся только максимальный `rev` каждого SID; содержимое
   канонизируется (SHA-1 без sid/rev/msg/metadata/reference) для последующего content-дедупа.
4. **Сборка** — политики из настроек, разрешение конфликтов SID по стратегии, перенос SID в
   свободный clearndr-блок; **гейт конфликтных близнецов**: пары, совпадающие после снятия
   `sid` и `reference:*`, роняют импорт Clear NDR («conflicting SID in same source»), поэтому
   при их обнаружении сборка падает целиком — плохой файл не записывается.
5. **Валидация движком** — офлайн-пакет `dist/` проходит цикл `suricata -T` → разбор лога →
   исключение/исправление битых правил → повтор **до нуля ошибок**; онлайн-сборка применяет
   статический фильтр совместимости. Экспорт возможен только из набора, прошедшего гейты.

## 6. Загрузка: авторизация и лимиты snort.org

`fetcher.ts` поддерживает `authType`: `none`, `oinkcode`, `authkey` (query-параметр), `basic`
(логин/пароль в `extraJson`).

Проверено на практике поведение snort.org:

- каноническая форма авторизации — путь, а не query:
  `https://www.snort.org/reg-rules/<файл>.tar.gz/<oinkcode>` → редирект на реальный файл;
- ссылки личного кабинета `snort.org/downloads/registered/<файл>.tar.gz?oinkcode=…`
  **игнорируют query** и возвращают HTTP 200 + HTML-страницу;
- `applyAuth()` автоматически приводит любые известные формы к канонической
  (`downloads/registered|subscribed/…` → `reg-rules/<файл>/<oinkcode>`);
- **magic-байты gzip** (`1f 8b`) проверяются до записи на диск: HTML больше не сохраняется как
  архив и не ломает tar («not in gzip format»); при плохом ответе используется ранее скачанный
  архив (кэш) с пометкой `cacheNote`;
- лимиты: registered — не чаще раза в 15 минут; `cacheTtlMinutes` в `extraJson` исключает
  перекачивание; `422` = Invalid oinkcode, `403`/`429` = лимит; oinkcode в сообщениях об ошибках
  фигурирует только в виде отпечатка (`abcd…ef01`), полный код не логируется.

## 7. Дедупликация и стратегии SID

| Политика | Что делает |
|---|---|
| `dedupSidStrategy = highest-rev` | при конфликте SID остаётся правило с максимальным `rev` (по умолчанию) |
| `dedupSidStrategy = source-priority` | выигрывает источник с меньшим числом `priority` |
| `dedupSidStrategy = renumber-private` | конфликтующие SID переводятся в приватный диапазон |
| `dedupContent = true` | удаляет правила с одинаковым `contentHash` (канонический SHA-1 без sid/rev/msg/metadata), но разными SID |
| `dropIncompatible = true` | не включает в сборку конструкции, несовместимые с Suricata (preproc, keystore, replace, rawbytes…) |
| `dropDisabledMsg = true` | удаляет заглушки DELETED/DISABLED |

Статистика каждого шага (по источникам: загружено/в сборке/сброшено по SID/по содержимому/
несовместимых) пишется в `Build.statsJson` и отображается во вкладке «Сборка и экспорт».

## 8. WireGuard VPN слой

`vpn.ts` управляет туннелем внутри контейнера:

- редактирование и хранение wg-quick профилей (БД + `WG_CONFIG_DIR`);
- проверка синтаксиса (`wg-quick strip`), up/down, статус через `wg show` (пары, handshake,
  трафик);
- проверка окружения: `wg`, `wg-quick`, `/dev/net/tun`, `NET_ADMIN`, `sysctl`, запись
  `src_valid_mark` — карточки с тремя состояниями («доступно / недоступно / нет данных»);
- **full-tunnel не роняет web UI**: при подъёме конфига с `AllowedIPs = 0.0.0.0/0` добавляется
  policy-правило `ip rule add from <IP-контейнера> lookup main priority 100` (ответы web-сервера
  идут через eth0, остальной трафик — через туннель); при опускании правило снимается;
- `wg-quick` в образе пропатчен как в upstream (`ac74ed6`): запись `src_valid_mark` только если
  значение ещё не 1 (read-only `/proc/sys`).

### Последовательности up и down

Подъём туннеля — `POST /api/vpn {"action": "up", "id" | "config"}`:

```mermaid
sequenceDiagram
    autonumber
    participant U as Web UI — вкладка VPN
    participant R as Route — POST /api/vpn
    participant V as vpn.ts
    participant X as Контейнер — wg-quick, ip
    participant D as Prisma — VpnProfile

    U->>R: action up — id профиля или config
    R->>D: findUnique id — 404, если профиля нет
    R->>R: parseWgConfig — секции [Interface] и [Peer], PrivateKey
    R->>V: wgUp iface, config
    opt full-tunnel — AllowedIPs содержит 0.0.0.0/0
        V->>X: ip route/addr show — адреса контейнера до подъёма туннеля
    end
    V->>X: запись /etc/wireguard/iface.conf — chmod 0600
    V->>X: wg-quick down iface — зачистка полуподнятого интерфейса
    V->>X: wg-quick up iface.conf
    alt resolvconf недоступен, а в конфиге есть DNS=
        V->>V: stripDnsLines — убрать строки DNS
        V->>X: wg-quick up iface.conf — повтор
    end
    opt интерфейс поднялся и это full-tunnel
        V->>X: ip rule del + add — from адрес контейнера lookup main prio 100
        Note over U,X: ответы web UI идут через eth0 — интерфейс не умирает при full-tunnel
    end
    V->>X: wg show interfaces — iface в списке?
    V-->>R: ok, notes, output
    R->>D: persistProfileStatus — active, lastStatusJson
    R-->>U: 200 — ok true, detail, notes
```

Опускание туннеля — `POST /api/vpn {"action": "down"}`:

```mermaid
sequenceDiagram
    autonumber
    participant U as Web UI — вкладка VPN
    participant R as Route — POST /api/vpn
    participant V as vpn.ts
    participant X as Контейнер — wg-quick, ip
    participant D as Prisma — VpnProfile

    U->>R: action down — name или id
    R->>V: wgDown name
    V->>X: wg-quick down iface.conf
    V->>X: ip -4 и -6 rule show
    V->>X: ip rule del — from адрес lookup main prio 100 — наши исключения
    alt wg-quick упал, а интерфейса уже нет
        V-->>R: ok true — «интерфейс уже был опущен»
    else wg-quick упал, но интерфейс жив
        V->>X: ip link del iface
        V-->>R: ok true с пометкой в notes
    end
    R->>D: persistProfileStatus — active false, lastStatusJson
    R-->>U: 200 — ok true, notes
```

## 9. Web UI

Single-page приложение (Next.js App Router, клиентские компоненты) с 9 вкладками:

| Вкладка | Содержимое |
|---|---|
| Обзор | карточки статистики (источники, правила, последняя сборка, VPN), последние события |
| Источники | каталог 25 источников + свои, включение, загрузка по одному/всем, диалоги добавления/редактирования, разбор архивов snort.org |
| Правила | база правил с поиском по SID/msg/источнику и пагинацией |
| Сборка и экспорт | сборка, статистика по источникам, файлы в каталоге экспорта |
| WireGuard VPN | проверка окружения, редактор конфига, профили, активные интерфейсы |
| Настройки | oinkcode, политики дедупликации, экспорт (режим, URL, токен, источник), cron |
| Журнал | все события движка |
| Помощь | цели/задачи, конвейер, лимиты, диагностика — аккордеоны |
| О системе | разработчик, проект, благодарности, технологии с логотипами, логотип — аккордеоны |

Компоненты — shadcn/ui (Radix-примитивы) + Tailwind CSS; иконки — Lucide; логотипы технологий —
inline-SVG из simple-icons (`tech-logos.tsx`, CC0).

## 10. Локализация (RU/EN)

Слой — `src/lib/i18n/`:

```
detect.ts    Lang ('ru'|'en'), detectLang(browserStrings, stored), tr(), localeOf()
ru.ts        канонический словарь (≈180 строковых значений), export type Dictionary = typeof ru
en.ts        английский словарь, типизирован Dictionary → tsc не даёт ключам разъехаться
index.tsx    I18nProvider (useSyncExternalStore поверх localStorage) + useI18n()
```

Механика:

1. **SSR и гидрация** всегда рендерят русский (`<html lang="ru">`).
2. После монтирования `useSyncExternalStore` читает snapshot: сохранённый выбор
   (`localStorage['ndrh.lang']`) приоритетнее строк браузера `navigator.languages`
   (первый поддержанный язык: `ru*` → ru, `en*` → en; иначе `ru`).
3. **Переключатель RU/EN** в шапке вызывает `setLang()` → обновление snapshot, listeners,
   `localStorage`, `<html lang>` и `document.title`.
4. Шаблоны с переменными — плейсхолдеры `{n}` + `tr()`; богатый текст (аккордеоны «Помощь» и
   «О системе») — per-lang контент с лёгкой разметкой `**bold**`/`` `code` `` (компонент `Rich`).
5. Локализуются также единицы измерения (`fmtSize`: Б/КБ/МБ ↔ B/KB/MB) и формат дат
   (`localeOf`: `ru-RU` / `en-US`). Сообщения движка в журнале остаются русскими — это
   операционные данные.
6. Паритет языков контролируется тестами: равенство наборов ключей, пустых значений нет,
   плейсхолдеры совпадают, в EN нет кириллицы.

## 11. REST API

| Метод/путь | Назначение |
|---|---|
| `GET /api/health` | самодиагностика (БД, схема, файлы), всегда 200 |
| `GET /api/dashboard` | сводка для UI |
| `GET/POST /api/sources`, `PATCH/DELETE /api/sources/:id` | управление источниками |
| `POST /api/sources/:id/fetch`, `POST /api/fetch-all` | загрузка правил |
| `POST /api/build` | сборка (`{"export": true}` — с экспортом) |
| `GET/POST/PUT /api/export` | скачать / выгрузить / список файлов |
| `GET /api/rules` | база правил (sid, q, sourceId, page) |
| `GET/PUT /api/settings` | настройки |
| `GET/POST/PUT/DELETE /api/vpn` | WireGuard: статус, действия, профили |
| `GET /api/logs` | журнал |

Ошибки API возвращаются как `{"error": "…"}` с реальной причиной (не безликий HTTP 500) и
дублируются в контейнерные логи.

### Жизненный цикл запроса

```mermaid
sequenceDiagram
    autonumber
    participant B as Браузер — hub/api.ts
    participant H as Route handler — app/api
    participant E as Движок — lib/engine
    participant D as Prisma ORM
    participant S as SQLite WAL

    B->>H: fetch — метод и JSON-тело
    H->>H: разбор тела и параметров — route handler, без middleware
    alt невалидный запрос — нет id, config или action
        H-->>B: 400 — JSON с причиной
    else корректный запрос
        H->>E: доменная операция — fetchSourceById, buildFinal, wgUp, setSetting
        E->>D: чтение и запись моделей
        D->>S: SQL — режим WAL против Socket timeout
        S-->>D: строки
        D-->>E: типизированные записи
        E->>D: LogEntry — log level, scope, message
        E-->>H: результат или доменная ошибка
    end
    alt успех
        H-->>B: 200 — NextResponse.json
    else необработанное исключение
        H->>H: apiError — причина одной строкой
        H-->>B: 500 — {"error": реальная причина} + строка в docker logs
    end
    B->>B: обновление карточек или баннер с ошибкой
```

## 12. Интеграция с Clear NDR: доставка правил

Итоговый набор попадает в Clear NDR одним из четырёх способов: скачать файл и импортировать
вручную; **PULL** — Clear NDR сам забирает файл с Hub; **PUSH** — Hub сам отправляет его через
REST API Scirius; HTTP POST на произвольный эндпоинт или копирование в общий каталог. Пошаговая
инструкция с командами, токеном и чек-листом внедрения —
[docs/clearndr-integration.md](docs/clearndr-integration.md) (EN:
[docs/clearndr-integration.en.md](docs/clearndr-integration.en.md)).

### 12.1 Две схемы доставки

```mermaid
flowchart TB
    subgraph HUB["NDR Rules Hub — Next.js :3080"]
        direction TB
        BLD["Сборка<br/>clearndr-import.rules + sha256"]
        CRON["cron Hub — Настройки → Расписание<br/>обновление → сборка → экспорт"]
        REST["exporter.ts — режим «Clear NDR REST»<br/>кнопка «Экспортировать в Clear NDR»<br/>или шаг cron (cronExport)"]
        PULLAPI["GET /api/export<br/>последняя сборка по HTTP"]
        BLD --> REST
        BLD --> PULLAPI
        CRON -.-> BLD
    end

    subgraph CNDR["Clear NDR (Scirius)"]
        direction TB
        SRC["Source «NDR Rules Hub»<br/>PUSH: method local · PULL: method http"]
        RS["Ruleset + включённая категория"]
        UPALL["update_push_all<br/>update → generate → push"]
        SUR["Suricata 7 — набор в работе"]
        SRC --> RS
        RS --> UPALL
        UPALL --> SUR
    end

    REST -- "Схема B: PUSH — Hub отправляет сам<br/>find-or-create → upload → update_push_all<br/>Authorization: Token" --> SRC
    PULLAPI -- "Схема A: PULL — Clear NDR забирает файл<br/>источник-URL + Recurrence / cron" --> SRC

    classDef engine fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef ext fill:#fef9c3,stroke:#ca8a04,color:#713f12
    class BLD,CRON,REST,PULLAPI engine
    class SRC,RS,UPALL,SUR ext
```

| | Схема A: PULL | Схема B: PUSH |
|---|---|---|
| Кто инициирует | Clear NDR забирает файл с Hub | Hub отправляет файл в Clear NDR |
| Доступ по сети | Clear NDR → Hub (:3080, `GET /api/export`) | Hub → Clear NDR (443, `/rest/…`) |
| Настройка в Clear NDR | источник-URL + ruleset + расписание | ничего — источник создаётся автоматически |
| Настройка в Hub | ничего | режим «Clear NDR REST», URL, токен |
| Автообновление | Recurrence Clear NDR / cron `update_push_all` | cron Hub (`cronExport`) / cron `update_push_all` |

### 12.2 PUSH: цепочка вызовов REST API Scirius

Режим «Clear NDR REST» (`exporter.ts → pushToClearndrRest`) выполняет три шага: найти или
создать локальный источник, загрузить файл (multipart; импорт правил происходит сразу),
применить набор. Авторизация — `Authorization: Token <токен>`: токен получается в веб-интерфейсе
Clear NDR (меню пользователя → **Edit Token → Regenerate**), это 40 hex-символов, связанных с
учётной записью и её правами (`rules.source_edit`, `rules.ruleset_update_push`). Формат `Bearer`
Clear NDR отклоняет (HTTP 401) — тип авторизации выбирается в настройках экспорта Hub.

```mermaid
sequenceDiagram
    autonumber
    participant H as Hub — exporter.ts<br/>режим «Clear NDR REST»
    participant A as Clear NDR — REST API Scirius<br/>/rest/… · Authorization: Token
    participant X as Suricata

    H->>A: GET /rest/rules/source/?name=NDR Rules Hub
    alt источник найден
        A-->>H: results → pk источника
    else источника нет
        H->>A: POST /rest/rules/source/ — method local, datatype sig
        A-->>H: 201 → pk нового источника
    end
    H->>A: POST /rest/rules/source/{pk}/upload/ — multipart clearndr-import.rules
    A->>A: импорт правил в базу источников
    alt конфликт SID в файле
        A-->>H: 400 conflicting SID — Hub: «включите дедупликацию в настройках сборки»
    end
    A-->>H: {"upload":"ok"}
    opt флаг «Применять набор» включён (по умолчанию)
        H->>A: POST /rest/suricata/update_push_all/
        A->>X: update источников → generate набора → push → перезапуск
        A-->>H: {"update_push_all":"ok"}
    end
    H-->>H: журнал (scope export) — шаги цепочки
```

Настройки — вкладка «Настройки → Экспорт в Clear NDR»: базовый URL (только корень, без `/rest` —
он дописывается автоматически), тип авторизации, токен (поле password), имя источника
(по умолчанию «NDR Rules Hub»), флаг «Применять набор после загрузки». Ошибки приходят с
подсказками: 401/403 — «токен отклонён… Edit Token → Regenerate»; «conflicting SID» —
«включите дедупликацию в настройках сборки». Все шаги цепочки видны в Журнале (scope `export`).

### 12.3 PULL: Clear NDR забирает файл сам

В Clear NDR создаётся источник типа «HTTP URL» на `GET http://<hub>:3080/api/export` (последняя
сборка всегда доступна по этому адресу), привязывается к набору, включается категория; обновление
выполняет штатный планировщик (Suricata → Update → Recurrence) или cron с `update_push_all`.
Автонастройка — идемпотентный скрипт `scripts/clearndr-setup-pull.sh`: создать источник →
ruleset → включить категорию → `update_push_all`.

```mermaid
sequenceDiagram
    autonumber
    participant C as Clear NDR — планировщик celery<br/>Suricata → Update → Recurrence
    participant S as Source «NDR Rules Hub»<br/>method http · uri /api/export
    participant H as Hub — GET /api/export
    participant X as Suricata

    C->>S: триггер по расписанию (например, Daily)
    S->>H: GET http://hub-host:3080/api/export
    H-->>S: 200 — clearndr-import.rules
    S->>S: импорт правил в базу источников
    C->>C: generate ruleset — включённая категория
    C->>X: push файла → перезапуск движка
    Note over C,X: кнопка Suricata → Update делает то же немедленно, а cron с update_push_all — то же без UI
```

### 12.4 Автообновление — три независимых варианта

| Вариант | Где настраивается | Что происходит по расписанию |
|---|---|---|
| a) Recurrence Clear NDR | UI Clear NDR → Suricata → Update → Recurrence (задача celery) | Clear NDR сам скачивает свежий файл с Hub, импортирует, пересобирает набор, перезапускает Suricata |
| b) cron `update_push_all` | cron на любом сервере с доступом к Clear NDR | `POST /rest/suricata/update_push_all/` — update → generate → push |
| c) cron Hub | Настройки → Расписание (`cronEnabled` + `cronExport = true`) | Hub: обновление источников → сборка → push в Clear NDR (режим `clearndr`) |

Вариант (c) работает и при PULL-схеме: после cron-сборки свежий файл уже лежит на `/api/export`,
откуда его забирает (a) или (b).

### 12.5 Проверка без боевого сервера

`scripts/clearndr-mock-server.py` воспроизводит REST API Scirius (Token-авторизация,
DRF-пагинация, multipart-upload, гейт «conflicting SID»). Сквозной тест: запустить mock, в
настройках Hub указать `http://127.0.0.1:8080` и токен `mock-clearndr-token`, нажать
«Экспортировать в Clear NDR», сверить `/_stats` — sha256 файла обязан совпасть байт в байт.
Вспомогательные скрипты: `clearndr-check.sh` (проверка токена, источников, наборов),
`clearndr-push.sh` (push готового файла из cron), `clearndr-setup-pull.sh` (PULL-настройка).
Команды — раздел 5 инструкции.

## 13. Поставка и эксплуатация

- **Dockerfile** — многоэтапная сборка: builder (`oven/bun`) → standalone runtime
  (`node:22-bookworm-slim`) + `wireguard-tools`, `iptables`, `iproute2`, `openresolv`, `procps`.
  `outputFileTracingIncludes` гарантирует попадание Prisma-движков в standalone.
- **docker-compose.yml** — `cap_add: NET_ADMIN`, устройство `/dev/net/tun`, sysctls
  (`ip_forward`, `src_valid_mark`), volume `./data:/app/data`, порт 3080→3000.
- **Оркестрация** — `service.ts`: cron (node-cron, `TZ`) выполняет «обновление источников →
  сборка → экспорт»; тот же цикл доступен кнопкой «Полный цикл».
- **Скрипты интеграции с Clear NDR** — `scripts/clearndr-check.sh` (проверка токена, источников
  и наборов), `clearndr-setup-pull.sh` (идемпотентная настройка PULL-схемы), `clearndr-push.sh`
  (push готового файла, cron-совместим), `clearndr-mock-server.py` (mock REST API Scirius).
- **Тесты** — vitest, 84 теста: парсер, конвертеры, дедупликация, загрузчик (включая
  magic-байты и кэш), wg-quick, i18n.
