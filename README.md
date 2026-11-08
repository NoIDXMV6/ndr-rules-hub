# NDR Rules Hub

Сервис управления источниками правил **Snort / Suricata** с полнофункциональным Web UI, автоматической
загрузкой по расписанию, конвертацией Snort 2/3 → Suricata, дедупликацией, устранением конфликтов SID,
**валидацией итогового набора реальным движком Suricata** и экспортом в **Clear NDR** (https://docs.clearndr.io).
Поставляется как **Docker-контейнер**.

![stack](https://img.shields.io/badge/Next.js%2016-TypeScript-blue) ![db](https://img.shields.io/badge/SQLite-Prisma-orange) ![validate](https://img.shields.io/badge/Suricata%207.0.10-validated-brightgreen) ![vpn](https://img.shields.io/badge/WireGuard-integrated-green)

## Возможности

| Блок | Что умеет |
|---|---|
| **Источники** | Каталог из 25 преднастроенных источников (13 исходных из Clear NDR + 12 новых). Добавление своих по URL/архиву/локальному файлу. Типы: ruleset, tar.gz-архив, IP/домен/URL-списки (конвертеры) |
| **Загрузка** | HTTP(S) с поддержкой **oinkcode** (snort.org, без логина/пароля), auth-key, Basic. Обработка лимитов snort.org (403 → понятное сообщение). Локальные архивы и каталоги |
| **Конвертеры** | Списки IP/CIDR → правила (чанки по N адресов на SID), домены → DNS-правила, URL → HTTP-правила. SID из приватного диапазона 1 000 000+ |
| **Конвертер Snort→Suricata** | `scripts/s2x_convert.py`: sticky-буферы Snort 3 (http_uri…) → dot-формы (http.uri…), inline-модификаторы content → отдельные ключевые слова, bufferlen → bsize, вырезание soid/service, маппинг переменных, file→tcp, ssl→tls. Калиброван эмпирически на Suricata 7.0.10 |
| **Валидатор** | Каждый итоговый набор прогоняется через **реальный Suricata** (`suricata -T`); цикл «валидация → разбор лога → исправление/исключение → повтор» до 0 ошибок. **Невалидированный набор не может попасть в Clear NDR** — экспорт блокируется |
| **Дедупликация** | По SID (стратегии: максимальный rev / приоритет источника / перенумерация в приватный диапазон) и по содержимому (канонический SHA-1 без sid/rev/msg/metadata) |
| **Совместимость** | Автообнаружение ключевых слов Snort 2 (preproc, react, rawbytes…) и Snort 3 (keystore, pkt_trace…), отсутствующих в Suricata, с фильтрацией на этапе сборки |
| **Сборка** | Итоговый `suricata.rules`-файл с заголовком, статистикой по каждому источнику и SHA-256 |
| **Экспорт в Clear NDR** | 1) файл для ручного импорта; 2) HTTP POST в эндпоинт Clear NDR; 3) копирование в общий каталог (volume) |
| **WireGuard VPN** | Полноценная настройка: редактор wg-quick конфига, проверка синтаксиса, up/down, статус (`wg show`), проверка окружения (wg, wg-quick, /dev/net/tun, NET_ADMIN). Загрузка правил через туннель |
| **Расписание** | cron (node-cron): обновление источников → сборка → экспорт. Управление из UI |
| **Журнал** | Все события загрузок/сборок/экспорта/VPN с уровнями и фильтрами |

## Валидированный пакет правил для Clear NDR

Готовый пакет — в каталоге [`dist/`](dist/) и во вложениях релиза:

- **113 843 правил** из 13 источников (ET Open, Talos Snort 2.9 + Snort 3, Abuse.ch SSLBL,
  Phishing Army, PT Attack Detection, Quadrant, OISF Traffic-ID, Blocklist.de, CINS Army,
  Spamhaus DROP, Feodo Tracker);
- каждый файл проверен `suricata -T` на Suricata 7.0.10 — **0 ошибок загрузки**;
- варианты: `full` (весь набор), `starter` (53 674 правила, высокий сигнал), `smoke` (123),
  разбивка по категориям (`by-category/`) и по источникам (`by-source/`);
- контроль целостности: `sha256sum -c SHA256SUMS.txt`.

Порядок тестирования и импорта — в [`dist/README-IMPORT.md`](dist/README-IMPORT.md).

### Результаты совместимости (Suricata 7.0.10, корпус 120 тыс. правил)

| Набор | Загружается как есть | После конвертера s2x |
|---|---|---|
| ET Open (suricata-7.0) | **100%** | — |
| Talos Snort 2.9 (snapshot-29200) | 99.93% | **100%** (минус 0.2% исключений валидатором) |
| Talos Snort 3 (snapshot-3200) | **1.5%** | **99.7%** |

Типовые несовместимости Snort 3 → Suricata 7: sticky-буферы до content (9829 правил), `soid`
(4584), протокол `file` (1387), `service` (782), inline-модификаторы content (~30 тыс. опций),
`bufferlen` (1061), `byte_math`, SIP-буферы, лимит длины правила 8192 байта.

## Быстрый старт (Docker)

```bash
git clone <repo> ndr-rules-hub && cd ndr-rules-hub
cp .env.example .env
# впишите свой Oinkcode (профиль snort.org → Oinkcode) — можно и позже через UI
echo 'OINKCODE=ваш_код' >> .env

docker compose up -d --build
# UI: http://localhost:3080
```

Первый запуск: вкладка **«Источники»** → включите нужные источники → «Обновить все» →
вкладка **«Сборка и экспорт»** → «Собрать» → «Скачать итоговый файл» (импорт в Clear NDR
средствами самого Clear NDR) либо настройте автоматический экспорт в **«Настройках»**.

> **Oinkcode достаточен**: официальный способ автоматизации загрузки registered-правил snort.org —
> `/reg-rules/<файл>/<oinkcode>` (редирект на `/rules/<файл>?oinkcode=…`). Вводить логин/пароль не требуется.
> Ссылки из личного кабинета (`https://snort.org/downloads/registered/<файл>.tar.gz`) oinkcode в
> query-параметре **не принимают** — Hub автоматически приводит их к канонической reg-rules-форме.
> Учитывайте лимит загрузок snort.org — не включайте одновременно несколько зеркал одного набора.

## Диагностика (если UI показывает ошибку API)

UI и API обслуживаются одним Next.js-сервером: если страница открылась, бэкенд доступен —
отдельного «бэка» прокидывать не нужно. Ошибка `HTTP 500` означает, что запрос дошёл до API
и роут упал; реальная причина теперь возвращается в ответе и видна в красной строке UI,
а также дублируется в логи контейнера.

```bash
docker logs ndr-rules-hub --tail 100        # [entrypoint] …, [api] 500: <причина>
curl -s http://localhost:3080/api/health    # самодиагностика: БД, схема, файлы
```

`/api/health` отвечает 200 даже при нерабочей БД и показывает точную ошибку (например,
`PrismaClientKnownRequestError P2022` при устаревшей схеме). Схема БД чинится автоматически:
entrypoint сверяет штамп версии (`/app/data/.schema-version`) с образцом из образа и при
несовпадении бэкапит старую БД в `./data/hub.db.bak-<дата>` и создаёт новую.

Ошибка `Prisma Client could not locate the Query Engine for runtime …` — несовпадение
платформы Prisma между этапами сборки (builder ≠ runtime). В репо это уже учтено:
`binaryTargets = ["native", "debian-openssl-3.0.x"]` в `prisma/schema.prisma` покрывает
runtime-образ `node:22-bookworm-slim`. Штамп версии схемы считается только по моделям,
поэтому правки генератора БД не пересоздают.

## Запуск без Docker

```bash
bun install
cp .env.example .env   # DATABASE_URL=file:./db/hub.db
bun run db:push
bun run dev            # http://localhost:3000
bunx vitest run        # тесты движка
```

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `OINKCODE` | oinkcode для snort.org (можно задать в UI) | — |
| `DATABASE_URL` | SQLite БД | `file:/app/data/hub.db` |
| `RULES_DATA_DIR` | каталог данных (кэш, экспорт, архивы) | `/app/data` |
| `WG_CONFIG_DIR` | где хранить WireGuard-конфиги | `/app/data/wireguard` |
| `TZ` | часовой пояс cron | `Europe/Moscow` |

## WireGuard в контейнере

`docker-compose.yml` уже содержит `cap_add: NET_ADMIN`, устройство `/dev/net/tun` и `ip_forward`.
В образе установлены `wireguard-tools` (wg + wg-quick), `iptables`, `iproute2`, `openresolv`
(строки «DNS =» в конфиге) и `procps`/`sysctl` (нужен для `AllowedIPs = 0.0.0.0/0`).
В UI (вкладка **WireGuard VPN**):

1. вставьте конфиг `.conf` (формат wg-quick), при необходимости задайте имя интерфейса
   комментарием `# InterfaceName: wg-office`;
2. «Проверить синтаксис конфига» → «Сохранить» → «Поднять туннель»;
3. статус handshake/трафика виден в блоке «Активные интерфейсы».

Если туннель должен обслуживать только загрузки с snort.org — ограничьте `AllowedIPs`
подсетями snort.org вместо `0.0.0.0/0`.

### Если UI показывает «Нет /dev/net/tun»

Это предупреждение не мешает загрузке правил и сборке — только туннелированию. Если VPN
не нужен, его можно игнорировать. Если нужен:

1. **Проверьте хост** (машину, где стоит Docker):
   ```bash
   ls -l /dev/net/tun                     # должен существовать (character device 10,200)
   sudo modprobe tun                      # если нет — загрузить модуль
   sudo modprobe wireguard                # модуль ядра для самих туннелей
   echo tun | sudo tee /etc/modules-load.d/tun.conf   # и грузить при старте
   echo wireguard | sudo tee /etc/modules-load.d/wireguard.conf
   ```
   Если после `modprobe tun` файла всё равно нет: `sudo mkdir -p /dev/net && sudo mknod /dev/net/tun c 10 200 && sudo chmod 666 /dev/net/tun`.
2. **Проверьте, что контейнер запущен репозиторным compose** (в нём есть `cap_add` и `devices`):
   ```bash
   cd ndr-rules-hub && git pull && docker compose up -d --force-recreate
   docker inspect ndr-rules-hub --format '{{json .HostConfig.CapAdd}} {{json .HostConfig.Devices}}'
   # ожидается: ["NET_ADMIN"] [{"PathOnHost":"/dev/net/tun",...}]
   ```
   Если там `[]` — контейнер поднят через `docker run` или старый compose без этих флагов:
   пересоздайте через репозиторный `docker-compose.yml` (для `docker run` добавьте
   `--cap-add NET_ADMIN --device /dev/net/tun`).
3. **Проверьте внутри контейнера**: `docker compose exec rules-hub test -e /dev/net/tun && echo OK`.
4. **Хост — LXC-контейнер (Proxmox и т.п.)**: tun нужно разрешить на гипервизоре,
   в `/etc/pve/lxc/<id>.conf` добавьте и перезапустите LXC:
   ```
   lxc.cgroup2.devices.allow: c 10:200 rwm
   lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
   ```

### Если wg-quick падает с «sysctl: permission denied on key»

Для full-tunnel конфигов (`AllowedIPs = 0.0.0.0/0`) wg-quick выставляет
`net.ipv4.conf.all.src_valid_mark=1`, но `/proc/sys` внутри контейнера read-only
(особенно на ядрах 6.8+), поэтому запись запрещена даже с NET_ADMIN. Нужно два шага:

1. **Значение должно быть выставлено docker'ом при создании контейнера** — репозиторный
   `docker-compose.yml` уже содержит:
   ```yaml
   sysctls:
     - net.ipv4.ip_forward=1
     - net.ipv4.conf.all.src_valid_mark=1
   ```
   Пересоздайте контейнер: `git pull && docker compose up -d --build --force-recreate`.
2. **wg-quick в образе пропатчен** как в upstream wireguard-tools (коммит `ac74ed6`):
   запись выполняется только если значение ещё не 1. Стоковая bookworm-версия
   (1.0.20210914) писала безусловно и падала на read-only `/proc/sys` даже при
   уже выставленном значении — патч это устраняет.

Проверка: `docker compose exec rules-hub sysctl -n net.ipv4.conf.all.src_valid_mark`
— должно вывести `1`; в UI карточка «src_valid_mark (запись)» должна стать зелёной.

Если `docker compose up` сам падает с ошибкой установки этого sysctl (бывает внутри
непривилегированного LXC) — выставьте ключ на хосте/LXC (`sysctl -w
net.ipv4.conf.all.src_valid_mark=1`) и добавьте в `/etc/sysctl.conf`; либо запустите
LXC в привилегированном режиме. Альтернатива без sysctl: ограничьте `AllowedIPs`
подсетями snort.org — тогда wg-quick этот ключ не трогает.

### Если при поднятом full-tunnel туннеле недоступен web-интерфейс

Симптомы: туннель поднят, handshake есть (`docker compose exec rules-hub wg show`),
но страница Hub не открывается, а в открытой вкладке все карточки проверки окружения
показывают «нет данных». Причина — сама суть full-tunnel: wg-quick добавляет policy
routing (`ip rule not fwmark → таблица 51820`), который заворачивает в туннель ВСЁ,
включая ответные пакеты входящих соединений к web-интерфейсу (port-mapping
3080→3000): ответы уходят в wg0 и теряются.

Hub решает это автоматически: при подъёме full-tunnel конфига он добавляет правило

```bash
ip rule add from <адрес-контейнера-на-eth0> lookup main priority 100
```

(и то же для глобального IPv6, если есть) — ответные пакеты web UI идут наружу через
eth0, весь остальной исходящий трафик контейнера — через туннель. Правило снимается
при «Опустить туннель». Проверить можно так:

```bash
docker compose exec rules-hub ip rule show          # строка «100: from <IP> lookup main»
```

Аварийное восстановление доступа (когда UI уже «умер» и кнопки нажать нельзя) —
с хоста:

```bash
# вариант 1: корректно опустить туннель
docker compose exec rules-hub wg-quick down /app/data/wireguard/wg0.conf
# вариант 2: если не помогло — снести интерфейс напрямую
docker compose exec rules-hub ip link del wg0
# вариант 3: самый простой — перезапустить контейнер (туннель при этом опустится)
docker compose restart rules-hub
```

### Если загрузка правил падает с «HTTP 422» (snort.org)

Проверено на практике: snort.org отвечает `HTTP 422` с телом `["Invalid oinkcode"]`,
когда **oinkcode не принят** — код не задан, содержит опечатку или отозван. Начиная с
этой версии Hub показывает в ошибке тело ответа и отпечаток отправленного кода
(`отправлен oinkcode abcd…ef01 (40 симв.)` или `oinkcode НЕ задан`), так что причина
видна сразу. Что проверить:

1. код сохранён в **Настройки** (поле oinkcode) либо в extra источника;
2. код скопирован целиком из snort.org → **Preferences → Oinkcode** (40 hex-символов,
   без пробелов и переносов строк);
3. аккаунт snort.org активен, код не отозван (перевыпустите при сомнении);
4. если код точно верный, но 422 повторяется — учтите, что при поднятом full-tunnel
   туннеле запросы к snort.org идут с IP VPN-сервера: временно опустите туннель
   («Опустить» в вкладке WireGuard) и повторите «Обновить» — так исключите
   реакцию snort.org на IP выхода.

Справочно: `403` — неверный oinkcode либо лимит загрузок (registered — не чаще раза
в 15 минут), `429` — слишком частые запросы. Hub не перекачивает архив повторно,
если в extra источника задан `cacheTtlMinutes` (архив младше N минут — берётся
кэш), и при недоступности источника автоматически работает от ранее скачанного
архива с пометкой в логах.

### Если ошибка распаковки: «tar: … not in gzip format»

Раньше Hub сохранял тело HTTP 200 как есть: если snort.org вместо архива отдавал
HTML-страницу (лимит загрузок, ссылка из личного кабинета с oinkcode в query —
проверено: `downloads/registered/…?oinkcode=` возвращает веб-страницу, а не архив),
файл писался как `.tar.gz` и tar падал с невнятной ошибкой. Начиная с этой версии:

1. **Проверка magic-байтов** — архив сохраняется и распаковывается только если тело
   начинается с `1f 8b` (настоящий gzip); иначе в ошибку выводится заголовок HTML-страницы
   и подсказка (лимит / форма ссылки / oinkcode).
2. **Нормализация ссылок** — ссылки из личного кабинета
   (`snort.org/downloads/registered|subscribed/<файл>.tar.gz`) автоматически переписываются
   в каноническую форму `www.snort.org/reg-rules/<файл>.tar.gz/<oinkcode>` — обе работают,
   менять URL в источнике не нужно.
3. **Кэш не портится** — HTML больше не сохраняется поверх ранее скачанного архива;
   при плохом ответе Hub работает от кэша с предупреждением.
4. Ошибки tar теперь короткие («архив скачан (N байт), но tar не смог его распаковать: …»)
   вместо `Command failed: tar -xzf /app/data/cache/…`.

## API сервиса

| Метод/путь | Описание |
|---|---|
| `GET /api/health` | самодиагностика: БД, версия схемы, файлы (всегда 200) |
| `GET /api/dashboard` | сводка: источники, правила, последняя сборка, VPN, логи |
| `GET/POST /api/sources` | список / добавление источника |
| `PATCH/DELETE /api/sources/:id` | правка / удаление |
| `POST /api/sources/:id/fetch` | загрузить правила источника |
| `POST /api/fetch-all` | обновить все включённые |
| `POST /api/build` | сборка `{ "export": true }` — с экспортом |
| `GET /api/export` | скачать итоговый файл |
| `POST /api/export` | выгрузить в Clear NDR настроенным способом |
| `GET /api/rules?sid=&q=&sourceId=&page=` | просмотр базы правил |
| `GET/PUT /api/settings` | настройки (oinkcode, политики, cron, экспорт) |
| `GET/POST/PUT/DELETE /api/vpn` | статус/действия/сохранение профилей WireGuard |
| `GET /api/logs` | журнал |

## Структура

```
prisma/schema.prisma        # Source, Rule, Build, Setting, LogEntry, VpnProfile
src/lib/engine/
  parser.ts                 # парсер правил Snort2/Snort3/Suricata (+многострочные)
  convert.ts                # конвертеры IP/домены/URL → правила
  fetcher.ts                # загрузка (url/tarball/local, oinkcode/auth-key/basic)
  build.ts                  # mergeSources: дедуп по SID/содержимому, перенумерация
  exporter.ts               # файл / HTTP / каталог для Clear NDR
  vpn.ts                    # wg-quick: конфиг, up/down, status, проверка окружения
  service.ts                # оркестрация: fetch → build → export, cron, сид каталога
  seed.ts                   # каталог 25 источников + настройки по умолчанию
scripts/
  s2x_convert.py            # конвертер Snort 2/3 → Suricata 7 (калибровка зондами)
  talos_convert_batch.py    # пакетная конвертация Talos 29200/3200 + валидация
  final_assembly.py         # сборка пакета: merge + цикл suricata -T до 0 ошибок
  keyword_analysis.py       # анализ 153 ключевых слов корпуса
  make_final_files.py       # файлы поставки (full/starter/smoke/by-*)
dist/                       # ВАЛИДИРОВАННЫЙ пакет для Clear NDR (zip + README + SHA256)
src/app/api/…               # REST API (Next.js route handlers)
src/components/hub/…        # Web UI (7 вкладок)
tests/                      # vitest: парсер, конвертеры, сборка, VPN, загрузчик
Dockerfile                  # многоэтапная сборка (standalone + wireguard-tools)
docker-compose.yml          # NET_ADMIN, /dev/net/tun, volume ./data
```

### Конвейер качества правил

```
источники → fetch → merge (дедуп SID/контента) → s2x_convert → suricata -T
     ↑                                                      │
     └──── исключение/исправление битых ← разбор лога ←──┘
                                    → пакет (0 ошибок) → экспорт в Clear NDR
```

Запуск конвейера вручную (в песочнице без Docker):
```bash
python3 scripts/talos_convert_batch.py   # Talos 29200+3200 → Suricata
python3 scripts/final_assembly.py        # весь корпус + цикл валидации
python3 scripts/make_final_files.py      # файлы поставки в download/rules/
```

## Тесты

```bash
bunx vitest run
```

33 теста: разбор реальных правил Snort 3 (многострочные, pcre со скобками), конвертеры
(чанки IP, домены, URL, предохранители maxRules), стратегии дедупликации SID, перенумерация,
заглушки DELETED, хеш содержимого, wg-quick конфиги (валидные/битые), загрузка локальных
каталогов и tar.gz, интеграционный тест конвертера списка по сети (Spamhaus DROP).

## Каталог источников — анализ

См. [docs/ANALYSIS.md](docs/ANALYSIS.md): полный разбор 5 архивов snort.org с Яндекс.Диска
(реальные пересечения SID), вердикты по дубликатам, совместимость с Suricata и обзор всех
доступных источников правил с рабочими URL.
