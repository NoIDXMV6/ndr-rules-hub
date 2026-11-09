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

Доступ к OpenSearch: `--es-url` → хост `127.0.0.1:9200` → `docker exec` в
контейнер `-opensearch-<seed>`. Перед каждой заменой/удалением объект
сохраняется в `/opt/ClearNDR/backups/osd-analytics-<ts>/` (или
`osd-import-<ts>/`).

## Из хаба

Вкладка «Дашборды OpenSearch»: карточка состояния (кластер, версии, плагины,
объёмы данных, счётчики управляемых объектов), выбор вида аналитики, каталог
пакетов с чекбоксами, «сухой режим», живой лог прогона и история. Скрипты
выполняются на хосте по той же схеме, что и «Обновление Clear NDR» (общие
настройки соединения; синхронизация скриптов и пакетов — перед прогоном).

## Тесты

`scripts/test-clearndr-osd-mock.sh` — mock-стенд (фейковый docker + fake
OpenSearch API): 43 проверки (статус, upsert-идемпотентность, подстановка
полей, вырезание отсутствующих, bulk-импорт, удаление). Прогон: `bash
scripts/test-clearndr-osd-mock.sh`.
