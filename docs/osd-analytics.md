# Дашборды OpenSearch: аналитика и каталог dashboards (v1.14.0)

Раздел хаба «Дашборды OpenSearch» наполняет пустые по умолчанию разделы
OpenSearch Dashboards (OSD) **Alerting**, **Anomaly Detection** и
**Security Analytics** данными Suricata EVE (`logstash-*`) и добавляет
каталог дополнительных дашбордов.

## Почему разделы были пустыми

Плагины alerting / anomaly-detection / security-analytics входят в сборку OSD
3.x и потому видны в меню, но clearNDR не создаёт в них объектов — они пустые
«с завода». Данных для наполнения достаточно: события
`event_type = alert | flow | dns | http | tls | fileinfo` в индексах
`logstash-*`.

## Что создаётся

### Alerting (мониторы, префикс «NDR ·»)

| Монитор | Условие | Interval | Severity |
|---|---|---|---|
| 01 Критический алерт Suricata | `alert.severity=1` > 0 | 5 мин | 1 (Critical) |
| 02 Всплеск алертов severity 2 | > 50 за период | 10 мин | 2 |
| 03 DNS-флуд | `event_type:dns` > 1000 | 5 мин | 3 |
| 04 Активность fileinfo | `event_type:fileinfo` > 0 | 15 мин | 5 (Info) |
| 05 Всплеск сетевых потоков | `event_type:flow` > 5000 | 5 мин | 3 |

Действие каждого монитора — запись в индекс аудита `ndr-alerts-audit`
(работает без SMTP/Slack; webhook можно добавить штатными средствами OSD →
Notifications). Просмотр срабатываний: OSD → Alerting → Monitors → Findings,
а также индекс `ndr-alerts-audit`.

### Anomaly Detection (ML-детекторы)

- «NDR · Аномалии объёма трафика (исходящие байты)» — сумма
  `flow.bytes_toserver` по каждому источнику (категория — src_ip);
- «NDR · Аномалии DNS-запросов по источникам» — число dns-событий по
  каждому источнику.

Интервал детекции 5 мин, окно задержки 2 мин. Первые результаты — через
10–15 минут: OSD → Anomaly Detection → Detector results.

### Security Analytics

Детектор «NDR · Suricata network (Sigma)» типа `network` по `logstash-*` +
маппинг EVE→ECS (`src_ip→source.ip`, `dest_ip→destination.ip`,
`alert.signature→rule.name` и т.д.). Встроенные Sigma-правила network
подключаются плагином автоматически; свои правила — OSD → Security
Analytics → Rules.

## Каталог дашбордов (packs)

| Ключ | Название | Содержимое |
|---|---|---|
| `traffic` | Обзор трафика | metric, динамика событий, pie транспорта, топ источников/портов/протоколов |
| `http` | HTTP | динамика, методы, топ хостов/URL, коды ответа |
| `dns` | DNS | динамика, топ запросов, типы, rcode, источники |
| `tls` | TLS | динамика, топ SNI, JA3-отпечатки, источники |
| `alerts` | Алерты Suricata | динамика по severity, топ сигнатур, категории, источники/цели |
| `files` | Файлы | всего, топ имён, типы (magic), динамика |

Поля в пакетах записаны плейсхолдерами и подставляются при импорте по
фактическим маппингам кластера (`_field_caps`): EVE raw или ECS. Если поля в
кластере нет — соответствующая визуализация пропускается с WARN. Пакеты
идемпотентны (`ndr-pack-*`), штатные дашборды SELKS не затрагиваются.

## Скрипты

- `scripts/clearndr-osd-analytics-setup.sh` — режимы `--status`,
  `--apply-alerting`, `--apply-anomaly`, `--apply-security`, `--apply-all`,
  `--remove-managed`; опции `--yes`, `--dry-run`, `--instance-dir`,
  `--es-url`, `--seed`, `--webhook`.
- `scripts/clearndr-osd-dashboard-import.sh` — `--list`, `--pack <key|all>`,
  `--remove <key|all>`; те же опции соединения.
- `scripts/osd-pack-generator.py` — генератор пакетов (пересоздаёт
  `scripts/osd-packs/*.json`).

## Доступ к OpenSearch (автоопределение канала)

Порядок перебора (первый отвечивший кластер используется дальше):

1. **OpenSearch URL** из настроек раздела (вкладка → поле «OpenSearch URL»;
   пусто = авто). Можно с авторизацией: `https://user:pass@host:9200`.
2. `https://127.0.0.1:9200` и `http://127.0.0.1:9200` — режим SSH (скрипт
   выполняется на хосте) или хаб с `--network host`.
3. `https://172.17.0.1:9200` и `http://172.17.0.1:9200` — шлюз docker-моста:
   основной вариант для **local**-режима (хаб в контейнере), работает, если
   9200 опубликован на хосте (`ss -ltnp | grep 9200`).
4. `https://host.docker.internal:9200` (https/http).
5. `docker exec` в контейнер `-opensearch-<seed>` — работает всегда, когда
   контейнеру хаба смонтирован `/var/run/docker.sock` (даже если 9200 не
   опубликован на хосте).

Схема (https/http) определяется автоматически, самоподписанный сертификат
принимается (`curl -k`). Если OpenSearch отвечает `401/403` — в ошибку
добавляется подсказка указать URL с учётными данными. Команда/хост, по
которому OpenSearch найден, показываются в карточке состояния раздела
(«Канал») и выводятся скриптами.

## Режим local: требования к контейнеру хаба

Контейнер хаба на хосте с Clear NDR должен быть запущен с монтированиями:

```sh
docker run … \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/ClearNDR:/opt/ClearNDR \
  ndr-rules-hub
```

- `/var/run/docker.sock` — поиск контейнеров стека, канал `docker exec`,
  статус стека, определение версии OSD;
- каталог инстанса **по тому же пути**, что на хосте (`/opt/ClearNDR`) —
  бэкапы объектов, реконструкция compose, `stamusctl`;
- `docker` CLI, `python3` и `stamusctl` (amd64) уже входят в образ;
- healthUrl должен быть доступен из контейнера (например
  `https://172.17.0.1/`). Если указан публичный домен и он не проксирует
  `/rest/`, probe стека автоматически пробует шлюз `https://172.17.0.1`.

Если монтирований нет, раздел показывает причину (нет docker-сокета / нет
прав / нет docker CLI) и подсказку с готовой командой запуска.

## Резервные копии и удаление

Перед каждой заменой/удалением объект сохраняется в
`/opt/ClearNDR/backups/osd-analytics-<ts>/` (или `osd-import-<ts>/`).

## Из хаба

Вкладка «Дашборды OpenSearch»: карточка состояния (кластер, версии, канал
доступа, плагины, объёмы данных, счётчики управляемых объектов), поле
«OpenSearch URL» для переопределения автоопределения, выбор вида аналитики,
каталог пакетов с чекбоксами, «сухой режим», живой лог прогона и история.
Скрипты выполняются на хосте по той же схеме, что и «Обновление Clear NDR»
(общие настройки соединения; синхронизация скриптов и пакетов — перед
прогоном).

## Тесты

- `scripts/test-clearndr-osd-mock.sh` — mock-стенд (фейковый docker + fake
  OpenSearch API): 53 проверки (статус, upsert-идемпотентность, подстановка
  полей, вырезание отсутствующих, bulk-импорт, удаление, автоопределение
  канала, `--es-url`, маскирование учётных данных). Прогон:
  `bash scripts/test-clearndr-osd-mock.sh`.
- `scripts/test-osd-probe-smoke.sh` — сквозной smoke TS-генерируемого
  probe-скрипта (канал docker exec против фейкового кластера): вывод
  cluster/es_url/es_channel/счётчиков. Прогон:
  `bash scripts/test-osd-probe-smoke.sh`.
