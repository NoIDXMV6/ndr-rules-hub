# Итоговые наборы правил для Clear NDR — валидированный пакет

Дата сборки: 2026-11-07
**Весь пакет прошёл валидацию движком Suricata 7.0.10 (`suricata -T`): 0 ошибок загрузки.**
Полная сборка: 113,843 уникальных правил из 13 источников.

## Контроль качества

- Дедупликация по SID (приоритет более высокого rev) и по содержимому.
- Правила Snort 2/3 конвертированы в Suricata 7 конвертером s2x (sticky-буферы → dot-формы,
  inline-модификаторы content → отдельные ключевые слова, bufferlen → bsize и т.д.).
- Цикл валидации: `suricata -T` → разбор лога → исправление/исключение битых правил → повтор до 0 ошибок.
- Исключено валидатором: 234 правила (0.21%) — несжимаемые несовместимости
  (byte_math, sip_*-буферы, dce_*, ber_*, конфликт направлений, битые заголовки Quadrant).
- Лимит длины правила Suricata 8192 байта учтён: длинные IP-листы разбиты на несколько правил.

## Состав пакета

| Файл | Правил | Назначение |
|---|---|---|
| `clearndr-full-20261107.rules` | 113,843 | Полный валидированный набор (все источники) |
| `clearndr-starter-20261107.rules` | 53,674 | Рекомендуемый стартовый набор (высокий сигнал) |
| `clearndr-smoke-20261107.rules` | 123 | Быстрая проверка импорта |
| `by-category/clearndr-cat-exploits-web-20261107.rules` | 37,747 | Категория: exploits-web — Эксплуатация уязвимостей, веб-атаки, exploit-kit'ы, шеллкоды |
| `by-category/clearndr-cat-ip-feeds-20261107.rules` | 87 | Категория: ip-feeds — Динамические IP-фиды: Blocklist.de, CINS Army, Spamhaus DROP, Feodo Tracker |
| `by-category/clearndr-cat-malware-cnc-20261107.rules` | 40,053 | Категория: malware-cnc — Вредоносное ПО, C&C-каналы, C2-домены, кража учётных данных, криптомайнеры |
| `by-category/clearndr-cat-policy-info-20261107.rules` | 32,656 | Категория: policy-info — Политики, информационные события, фишинг, прочая активность |
| `by-category/clearndr-cat-recon-dos-20261107.rules` | 3,300 | Категория: recon-dos — Сканирование, разведка, DoS/DDoS |
| `by-source/clearndr-src-abusech-sslbl-20261107.rules` | 10,957 | Источник: Abuse.ch SSL Blacklist (SSL certificates) |
| `by-source/clearndr-src-blocklistde-20261107.rules` | 53 | Источник: Blocklist.de (атакующие IP) |
| `by-source/clearndr-src-cins-army-20261107.rules` | 30 | Источник: CINS Army List (плохие IP) |
| `by-source/clearndr-src-et-open-20261107.rules` | 51,311 | Источник: ET Open Ruleset (Emerging Threats) |
| `by-source/clearndr-src-feodo-iplist-20261107.rules` | 1 | Источник: Feodo Tracker Botnet C2 (IP list → правила) |
| `by-source/clearndr-src-feodo-rules-20261107.rules` | 5 | Источник: Feodo Tracker Botnet C2 (rules) |
| `by-source/clearndr-src-phishing-army-20261107.rules` | 5,000 | Источник: Phishing Army (антифишинг) |
| `by-source/clearndr-src-pt-attack-detection-20261107.rules` | 161 | Источник: Positive Technologies Attack Detection Team |
| `by-source/clearndr-src-quadrant-20261107.rules` | 153 | Источник: Quadrant Suricata Ruleset |
| `by-source/clearndr-src-spamhaus-drop-20261107.rules` | 3 | Источник: Spamhaus DROP (угнанные сети) |
| `by-source/clearndr-src-oisf-traffic-id-20261107.rules` | 32 | Источник: Suricata Traffic ID Ruleset (OISF) |
| `by-source/clearndr-src-talos-snort2-converted-20261107.rules` | 45,992 | Источник: Talos Snort 2.9 (конвертировано в Suricata) |
| `by-source/clearndr-src-talos-snort3-converted-20261107.rules` | 145 | Источник: Talos Snort 3 (конвертировано в Suricata) |

## Рекомендуемый порядок тестирования

1. **smoke** — `clearndr-smoke-*.rules` (123 правил): проверка механизма импорта.
2. **starter** — `clearndr-starter-*.rules` (53,674 правил): высокий сигнал — основной файл для пилота.
3. **by-category** — выборочные категории под профиль сети.
4. **full** — полный набор (113,843 правил).

## Импорт в Clear NDR

1. UI Clear NDR → **Sources** → **Import** → загрузить выбранный `.rules` файл.
2. Переменные `$HOME_NET`/`$EXTERNAL_NET` — стандартные значения Suricata.
3. Перезагрузить правила и сверить количество загруженных с таблицей (должно совпасть — все правила валидированы).

## Проверка целостности

`sha256sum -c SHA256SUMS.txt`
