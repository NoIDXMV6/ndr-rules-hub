# NDR Rules Hub

Сервис управления источниками правил **Snort / Suricata** с полнофункциональным Web UI, автоматической
загрузкой по расписанию, дедупликацией, устранением конфликтов SID и экспортом итогового набора
в **Clear NDR** (https://docs.clearndr.io). Поставляется как **Docker-контейнер**.

![stack](https://img.shields.io/badge/Next.js%2016-TypeScript-blue) ![db](https://img.shields.io/badge/SQLite-Prisma-orange) ![vpn](https://img.shields.io/badge/WireGuard-integrated-green)

## Возможности

| Блок | Что умеет |
|---|---|
| **Источники** | Каталог из 25 преднастроенных источников (13 исходных из Clear NDR + 12 новых). Добавление своих по URL/архиву/локальному файлу. Типы: ruleset, tar.gz-архив, IP/домен/URL-списки (конвертеры) |
| **Загрузка** | HTTP(S) с поддержкой **oinkcode** (snort.org, без логина/пароля), auth-key, Basic. Обработка лимитов snort.org (403 → понятное сообщение). Локальные архивы и каталоги |
| **Конвертеры** | Списки IP/CIDR → правила (чанки по N адресов на SID), домены → DNS-правила, URL → HTTP-правила. SID из приватного диапазона 1 000 000+ |
| **Дедупликация** | По SID (стратегии: максимальный rev / приоритет источника / перенумерация в приватный диапазон) и по содержимому (канонический SHA-1 без sid/rev/msg/metadata) |
| **Совместимость** | Автообнаружение ключевых слов Snort 2 (preproc, react, rawbytes…) и Snort 3 (keystore, pkt_trace…), отсутствующих в Suricata, с фильтрацией на этапе сборки |
| **Сборка** | Итоговый `suricata.rules`-файл с заголовком, статистикой по каждому источнику и SHA-256 |
| **Экспорт в Clear NDR** | 1) файл для ручного импорта; 2) HTTP POST в эндпоинт Clear NDR; 3) копирование в общий каталог (volume) |
| **WireGuard VPN** | Полноценная настройка: редактор wg-quick конфига, проверка синтаксиса, up/down, статус (`wg show`), проверка окружения (wg, wg-quick, /dev/net/tun, NET_ADMIN). Загрузка правил через туннель |
| **Расписание** | cron (node-cron): обновление источников → сборка → экспорт. Управление из UI |
| **Журнал** | Все события загрузок/сборок/экспорта/VPN с уровнями и фильтрами |

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
> Учитывайте суточный лимит загрузок snort.org — не включайте одновременно несколько зеркал одного набора.

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
В образе установлены `wireguard-tools` (wg + wg-quick) и `iptables`. В UI (вкладка **WireGuard VPN**):

1. вставьте конфиг `.conf` (формат wg-quick), при необходимости задайте имя интерфейса
   комментарием `# InterfaceName: wg-office`;
2. «Проверить синтаксис конфига» → «Сохранить» → «Поднять туннель»;
3. статус handshake/трафика виден в блоке «Активные интерфейсы».

Если туннель должен обслуживать только загрузки с snort.org — ограничьте `AllowedIPs`
подсетями snort.org вместо `0.0.0.0/0`.

## API сервиса

| Метод/путь | Описание |
|---|---|
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
src/app/api/…               # REST API (Next.js route handlers)
src/components/hub/…        # Web UI (7 вкладок)
tests/                      # vitest: парсер, конвертеры, сборка, VPN, загрузчик
Dockerfile                  # многоэтапная сборка (standalone + wireguard-tools)
docker-compose.yml          # NET_ADMIN, /dev/net/tun, volume ./data
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
