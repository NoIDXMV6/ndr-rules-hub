#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# clearndr-osd-dashboard-import.sh — импорт каталога дополнительных дашбордов
# NDR Rules Hub в OpenSearch Dashboards (.kibana) стеков clearNDR.
#
# Пакеты (scripts/osd-packs/*.json, генератор — osd-pack-generator.py):
#   traffic | http | dns | tls | alerts | files
# Идентификаторы всех объектов — префикс ndr-pack- , поэтому импорт
# идемпотентен (повторный запуск перезаписывает), а --remove удаляет только
# управляемые объекты, не трогая штатные дашборды SELKS.
#
# Поля в пакетах записаны плейсхолдерами (__F:key__, __TS__, __IP__):
# перед записью скрипт находит индекс(ы), где реально лежат EVE-события
# (поле event_type / event.type, по _cat/indices), определяет фактические
# имена полей по _field_caps (EVE raw или ECS-маппинг); для текстовых полей
# берётся keyword-подполе, иначе Terms-агрегации OSD падают («Saved field
# "proto" is invalid for use with the "Terms" aggregation»). Index-pattern
# (титул = найденному выражению) дополняется ПОЛНЫМ списком полей из
# кластера — без этого OSD показывает «Could not locate that
# index-pattern-field» на dns.*/http.*/alert.*. Визуализации по отсутствующим
# в кластере полям вырезаются (с WARN).
#
# Объекты пишутся в .kibana сырым форматом SavedObjects (type, <type>:
# attributes, references, migrationVersion — версия миграций берётся с
# существующих объектов кластера). Bulk-запрос уходит файлом через
# --data-binary (stdin в exec-режиме) с сохранением завершающего \n —
# требование bulk API — и refresh=wait_for для немедленной видимости.
#
# Использование:
#   clearndr-osd-dashboard-import.sh --check
#   clearndr-osd-dashboard-import.sh --list
#   clearndr-osd-dashboard-import.sh --pack traffic --pack alerts [--yes] [--dry-run]
#   clearndr-osd-dashboard-import.sh --pack all [--yes]
#   clearndr-osd-dashboard-import.sh --remove traffic | --remove all [--yes]
# Опции: --es-url URL (иначе автоопределение: https/http на 127.0.0.1,
# 172.17.0.1, host.docker.internal, затем docker exec), --seed SEED,
# --instance-dir DIR, --no-color.
# Режим --check: показать, куда поступают EVE-данные, какие поля видны,
# какие index-pattern'ы есть в .kibana — диагностика пустых дашбордов.
# Коды выхода: 0 — успех, 1 — ошибка среды / данных нет, 2 — не найден пакет.
# ─────────────────────────────────────────────────────────────────────────────
set -u
SELF="$(basename "$0")"
SDIR="$(cd "$(dirname "$0")" && pwd)"
PACKS_DIR="$SDIR/osd-packs"
INSTANCE_DIR="/opt/ClearNDR"
ES_URL=""
SEED=""
YES=0 DRY=0
MODE="import"          # import | remove | list
PACKS=()               # ключи пакетов

msg()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok()   { printf '[ OK ] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
err()  { printf '[FAIL] %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list";;
    --pack) shift; PACKS+=("${1:-}");;
    --remove) shift; MODE="remove"; PACKS+=("${1:-}");;
    --es-url) ES_URL="${2:-}"; shift;;
    --seed) SEED="${2:-}"; shift;;
    --instance-dir) INSTANCE_DIR="${2:-}"; shift;;
    --yes) YES=1;;
    --dry-run) DRY=1;;
    --no-color) :;;
    --check) MODE="check";;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) err "Неизвестный аргумент: $1"; exit 1;;
  esac
  shift
done

TS="$(date +%Y%m%d-%H%M%S)"
PROG_FILE="/tmp/ndr-osd-import.progress"
BACKUP_ROOT="$INSTANCE_DIR/backups/osd-import-$TS"
BACKUP_DIR=""
# источник данных и выбранный index-pattern (заполняются по ходу)
DATA_TARGET="logstash-*"   # индексное выражение, где реально лежат EVE-события
DATA_DOCS=""               # документов с event_type под DATA_TARGET
IP_ID=""                   # id выбранного index-pattern
IP_TS=""                   # timeFieldName выбранного index-pattern

# ── доступ к ES (как в clearndr-osd-analytics-setup.sh): --es-url → https/http
#    на 127.0.0.1, 172.17.0.1, host.docker.internal → docker exec ──────────────
ES_MODE=""            # host | exec
OS_CT=""
ES_BASE=""            # база вида https://host:9200
AUTH=""               # 401/403, если OpenSearch требует авторизацию
es_mask() { printf '%s' "$1" | sed -E 's#(://[^/@:]+):[^@]*@#\1:***@#'; }
es() { # es METHOD PATH [BODY] — по выбранному каналу
  local m="$1" p="$2" b="${3:-}"
  case "$p" in /*) ;; *) p="/$p" ;; esac
  case "$ES_MODE" in
    host) curl -sk --noproxy '*' --max-time 20 -X "$m" -H 'Content-Type: application/json' ${b:+-d "$b"} "$ES_BASE$p" 2>/dev/null ;;
    exec) docker exec "$OS_CT" curl -sk --noproxy '*' --max-time 20 -X "$m" -H 'Content-Type: application/json' ${b:+-d "$b"} "$ES_BASE$p" 2>/dev/null ;;
  esac
}
es_jq_get() {
  python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); raise SystemExit
print($1)" 2>/dev/null
}
es_file() { # es_file METHOD PATH BODY_FILE — тело из файла: большие JSON
  # (полный список полей index-pattern — сотни КБ) не пролезают в argv curl
  # (лимит ядра MAX_ARG_STRLEN 128 КБ), поэтому пишутся во временный файл
  local m="$1" p="$2" f="$3"
  case "$p" in /*) ;; *) p="/$p" ;; esac
  case "$ES_MODE" in
    host) curl -sk --noproxy '*' --max-time 30 -X "$m" -H 'Content-Type: application/json' \
            --data-binary @"$f" "$ES_BASE$p" 2>/dev/null ;;
    exec) cat "$f" | docker exec -i "$OS_CT" curl -sk --noproxy '*' --max-time 30 -X "$m" \
            -H 'Content-Type: application/json' --data-binary @- "$ES_BASE$p" 2>/dev/null ;;
  esac
}
es_bulk() { # es_bulk FILE — NDJSON-файл → POST /_bulk
  # тело передаётся файлом/потоком: command substitution съедает завершающий
  # \n, а bulk API OpenSearch требует тело с \n на конце (иначе 400 «must be
  # terminated by a newline»); Content-Type — application/x-ndjson.
  local file="$1" out rc=1
  case "$ES_MODE" in
    host)
      out="$(curl -sk --noproxy '*' --max-time 90 -X POST \
        -H 'Content-Type: application/x-ndjson' --data-binary @"$file" \
        "$ES_BASE/_bulk?refresh=wait_for" 2>/dev/null)" && rc=0 ;;
    exec)
      out="$(cat "$file" | docker exec -i "$OS_CT" curl -sk --noproxy '*' --max-time 90 -X POST \
        -H 'Content-Type: application/x-ndjson' --data-binary @- \
        "$ES_BASE/_bulk?refresh=wait_for" 2>/dev/null)" && rc=0 ;;
  esac
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    printf '%s' '{"error":{"reason":"bulk: нет ответа от OpenSearch (канал '"$ES_MODE"')"}}'
  else
    printf '%s' "$out"
  fi
}
have_docker() { docker info >/dev/null 2>&1; }
find_os_container() {
  have_docker || return 1
  if [ -n "$SEED" ]; then
    docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- "-opensearch-[A-Za-z0-9_]+$" | grep -- "$SEED" | head -1 && return 0
  fi
  docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- "-opensearch-[A-Za-z0-9_]+$" | head -1
}
try_base() { # $1=base → печатает cluster_name при успехе
  local out code body
  out="$(curl -sk --noproxy '*' --max-time 5 -w '\n%{http_code}' "$1/" 2>/dev/null)" || return 1
  code="$(printf '%s' "$out" | tail -1)"; body="$(printf '%s' "$out" | sed '$d')"
  case "$code" in
    200) printf '%s' "$body" | es_jq_get "str(d.get('cluster_name',''))"; return 0 ;;
    401|403) AUTH="$code"; return 1 ;;
    *) return 1 ;;
  esac
}
detect_es() {
  local b r out code body cands=""
  if [ -n "$ES_URL" ]; then
    # явный URL — только он, без тихого отката на авто-кандидаты
    case "$ES_URL" in
      *://*) cands="${ES_URL%/}" ;;
      *) cands="https://$ES_URL http://$ES_URL" ;;
    esac
  else
    cands="https://127.0.0.1:9200 http://127.0.0.1:9200 https://172.17.0.1:9200 http://172.17.0.1:9200 https://host.docker.internal:9200 http://host.docker.internal:9200"
  fi
  for b in $cands; do
    r="$(try_base "$b")"
    if [ -n "$r" ]; then ES_MODE="host"; ES_BASE="${b%/}"; ok "OpenSearch: $(es_mask "$ES_BASE")"; return 0; fi
  done
  if [ -n "$ES_URL" ]; then
    err "OpenSearch недоступен по --es-url ($(es_mask "$ES_URL"))$([ -n "$AUTH" ] && printf ' (HTTP %s — нужна авторизация, добавьте user:pass в URL)' "$AUTH")"
    return 1
  fi
  OS_CT="$(find_os_container 2>/dev/null || true)"
  if [ -n "$OS_CT" ]; then
    for b in https://127.0.0.1:9200 http://127.0.0.1:9200; do
      out="$(docker exec "$OS_CT" curl -sk --noproxy '*' --max-time 8 -w '\n%{http_code}' "$b/" 2>/dev/null)" || continue
      code="$(printf '%s' "$out" | tail -1)"; body="$(printf '%s' "$out" | sed '$d')"
      case "$code" in
        200) r="$(printf '%s' "$body" | es_jq_get "str(d.get('cluster_name',''))")"
             if [ -n "$r" ]; then ES_MODE="exec"; ES_BASE="${b%/}"; ok "OpenSearch через контейнер: $OS_CT ($ES_BASE)"; return 0; fi ;;
        401|403) AUTH="$code" ;;
      esac
    done
  fi
  local hint=""
  [ -n "$AUTH" ] && hint="; OpenSearch отвечает HTTP $AUTH — укажите --es-url https://user:pass@host:9200"
  if [ -z "$AUTH" ] && ! have_docker; then
    hint="; docker недоступен из этого окружения (в контейнере хаба local-режим требует -v /var/run/docker.sock:/var/run/docker.sock и -v /opt/ClearNDR:/opt/ClearNDR)"
  fi
  err "OpenSearch не найден (127.0.0.1:9200, 172.17.0.1:9200, host.docker.internal:9200 — https/http, docker exec)$hint"
  return 1
}
backup_obj() { # $1=file-slug $2=json
  if [ -z "$BACKUP_DIR" ]; then mkdir -p "$BACKUP_ROOT" 2>/dev/null && BACKUP_DIR="$BACKUP_ROOT"; fi
  [ -n "$BACKUP_DIR" ] && printf '%s' "$2" > "$BACKUP_DIR/$1.json" 2>/dev/null || true
}

# ── источник данных: где реально лежат EVE-события ─────────────────────────
# «No results found» / Count 0 почти всегда значит, что index-pattern смотрит
# не на тот индекс или EVE вообще не поступает; поэтому перед импортом ищем
# индексы с документами, у которых есть поле event_type (event.type — ECS).
# Индексы сначала группируются по префиксу (logstash-flow-2026.11.10 →
# logstash-flow-*), пробы event_type идут по ГРУППАМ — так в выражение
# попадают и мелкие группы (http-*/tls-*/fileinfo-*), которые раньше
# отрезались лимитом «топ-8 индексов».
discover_data_target() {
  step "Источник данных"
  local cat_file="$PROG_FILE.catidx" groups_file="$PROG_FILE.groups"
  es GET '/_cat/indices?format=json&h=index,docs.count&s=docs.count:desc' > "$cat_file" 2>/dev/null || true
  python3 - "$cat_file" > "$groups_file" <<'PYGRP'
import json, sys, re
try:
    rows = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    rows = []
agg, order = {}, []
for r in rows if isinstance(rows, list) else []:
    n = str(r.get("index", "") or "")
    try: c = int(r.get("docs.count") or 0)
    except Exception: c = 0
    if not n or n.startswith(".") or c <= 0:
        continue
    pref = re.sub(r"\d[\d._-]*$", "*", n)   # logstash-flow-2026.11.10 → logstash-flow-*
    if pref not in agg:
        agg[pref] = [0, 0]; order.append(pref)
    agg[pref][0] += c; agg[pref][1] += 1
order.sort(key=lambda p: -agg[p][0])
for p in order[:16]:
    print("%s\t%d\t%d" % (p, agg[p][0], agg[p][1]))
PYGRP
  if [ ! -s "$groups_file" ]; then
    warn "список индексов недоступен — использую logstash-* без проверки"
    DATA_TARGET="logstash-*"; DATA_DOCS=""
    return 0
  fi
  local hits="" n=0 pref cnt
  while IFS=$'\t' read -r pref _ _; do
    [ -n "$pref" ] || continue
    cnt="$(es GET "/${pref}/_search?q=_exists_:event_type&size=0" | es_jq_get "str((d.get('hits') or {}).get('total',{}).get('value',0))")"
    case "$cnt" in ''|0)
      cnt="$(es GET "/${pref}/_search?q=_exists_:event.type&size=0" | es_jq_get "str((d.get('hits') or {}).get('total',{}).get('value',0))")"
    ;; esac
    case "$cnt" in ''|0) continue;; esac
    hits+="${cnt} ${pref}"$'\n'
    n=$((n+1))
  done < "$groups_file"
  if [ "$n" -eq 0 ]; then
    warn "EVE-события (event_type/event.type) не найдены ни в одном индексе — Suricata EVE не поступает в OpenSearch"
    warn "использую logstash-*: пока данные не появятся, дашборды будут пустыми"
    DATA_TARGET="logstash-*"; DATA_DOCS=0
    return 0
  fi
  local expr
  expr="$(printf '%s' "$hits" | python3 -c '
import sys
items = []
for line in sys.stdin:
    p = line.split()
    if len(p) == 2: items.append((int(p[0]), p[1]))
items.sort(key=lambda x: -x[0])
# зонтичный logstash-* не смешиваем с конкретными группами: он их уже
# включает (двойной счёт в выражении и в field_caps)
if len(items) > 1:
    items = [x for x in items if x[1] != "logstash-*"]
for c, p in items[:16]:
    sys.stderr.write("%s\t%d\n" % (p, c))
print(",".join(p for _, p in items[:16]))
' 2> "$PROG_FILE.dsrc")"
  [ -n "$expr" ] || expr="logstash-*"
  DATA_TARGET="$expr"
  DATA_DOCS="$(printf '%s' "$hits" | awk '{s+=$1} END{print s+0}')"
  ok "EVE-данные: $DATA_TARGET (документов с event_type: $DATA_DOCS)"
  python3 -c "
import sys
for line in open('$PROG_FILE.dsrc', encoding='utf-8'):
    p = line.rstrip('\n').split('\t')
    if len(p) == 2: print('  %s — %s док. с event_type' % (p[0], p[1]))
" 2>/dev/null || true
}

verify_data() { # $1 = поле времени — увидят ли дашборды данные под паттерном
  local docs resp ts_ms human age_h
  docs="$(es GET "/$DATA_TARGET/_count" | es_jq_get "str(d.get('count',''))")"
  msg "документов в $DATA_TARGET: ${docs:-?}"
  if [ -z "$docs" ] || [ "$docs" = "0" ]; then
    warn "документов нет — дашборды будут пустыми; проверьте поставку EVE (eve.json → Logstash/Filebeat → OpenSearch) и имя индекса"
    return 0
  fi
  [ -n "${1:-}" ] || return 0
  resp="$(es POST "/$DATA_TARGET/_search" '{"size":0,"track_total_hits":false,"aggs":{"m":{"max":{"field":"'"$1"'"}}}}')"
  ts_ms="$(printf '%s' "$resp" | es_jq_get "str((d.get('aggregations') or {}).get('m',{}).get('value',''))")"
  case "$ts_ms" in ''|None|0|0.0)
    warn "поле времени «$1» не содержит значений в $DATA_TARGET — панели будут пустыми (timeFieldName паттерна не совпадает с данными)"
    return 0
  ;; esac
  human="$(python3 -c "
import datetime
print(datetime.datetime.utcfromtimestamp($ts_ms/1000).strftime('%Y-%m-%d %H:%M UTC'))" 2>/dev/null)"
  age_h=$(( ($(date +%s) - ${ts_ms%.*}/1000) / 3600 ))
  msg "последнее событие: ${human:-?} (${age_h} ч назад)"
  if [ "$age_h" -ge 48 ]; then
    warn "данные старше 48 ч — выберите в OSD более широкий диапазон времени, иначе панели покажут «No results found»"
  fi
  return 0
}

sample_migration_versions() { # {"dashboard":"7.9.3",...} — версии миграций
  # существующих объектов .kibana (сырой формат требует migrationVersion,
  # иначе OSD при чтении прогонит объект через цепочку миграций)
  es GET '/.kibana/_search?q=type:dashboard%20OR%20type:visualization%20OR%20type:index-pattern&size=200' \
    | python3 -c '
import json, sys, collections
mv = collections.defaultdict(collections.Counter)
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
for h in ((d.get("hits") or {}).get("hits") or []):
    s = h.get("_source") or {}
    t, m = s.get("type"), (s.get("migrationVersion") or {})
    if t and isinstance(m, dict) and m.get(t):
        mv[t][str(m[t])] += 1
print(json.dumps({t: c.most_common(1)[0][0] for t, c in mv.items()}))
' 2>/dev/null
}

# ── поля событий (кандидаты EVE и ECS) ───────────────────────────────────────
FIELD_CANDIDATES='
ts timestamp|@timestamp|time
src_ip src_ip|source.ip|source_ip|source.address
dst_ip dest_ip|destination.ip|destination_ip|destination.address
dst_port dest_port|destination.port
proto proto|network.transport
event_type event_type|event.type
app_proto app_proto|network.protocol
alert_sev alert.severity|event.severity
alert_name alert.signature|rule.name
alert_cat alert.category|rule.category
dns_name dns.rrname|dns.query.name|dns.name
dns_type dns.type|dns.query.type
dns_rcode dns.rcode|dns.response_code
http_host http.hostname|http.host|url.domain
http_url http.url|url.original
http_method http.http_method|http.request.method
http_status http.status|http.response.status_code
tls_sni tls.client.server_name|tls.sni|server.name
ja3 tls.ja3.hash|tls.ja3|tls.client.ja3
file_name fileinfo.filename|file.name
file_magic fileinfo.magic|file.magic
'
FIELD_CAPS_FIELDS="$(printf '%s\n' "$FIELD_CANDIDATES" | sed -n 's/^[a-z_0-9]* //p' | tr '\n' ',' | sed 's/|/,/g; s/,$//')"
# +keyword-подполя: _field_caps возвращает только запрошенные имена, а без
# запроса proto.keyword не проверить, есть ли он в кластере (нужен для Terms)
FIELD_CAPS_FIELDS="${FIELD_CAPS_FIELDS},$(printf '%s' "$FIELD_CAPS_FIELDS" | tr ',' '\n' | sed '/^$/d; s/$/.keyword/' | paste -sd, -)"
detect_fields() { # «KEY<TAB>поле<TAB>тип»
  local caps_file="$PROG_FILE.fieldcaps" cands_file="$PROG_FILE.cands"
  printf '%s' "$FIELD_CANDIDATES" > "$cands_file"
  es GET "/$DATA_TARGET/_field_caps?fields=${FIELD_CAPS_FIELDS}&ignore_unavailable=true&allow_no_indices=true" > "$caps_file" 2>/dev/null || true
  python3 - "$cands_file" "$caps_file" <<'PYFC'
import json, sys
cands = {}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    key, fields = line.split(None, 1)
    cands[key] = fields.split("|")
try:
    fc = json.load(open(sys.argv[2], encoding="utf-8")).get("fields", {})
except Exception:
    fc = {}
have = {n: ",".join(sorted(s.keys())) for n, s in fc.items()}
for key, fields in cands.items():
    for f in fields:
        if f in have:
            types = have[f]
            # текстовое поле непригодно для Terms-агрегаций OSD — берём
            # keyword-подполе (динамический маппинг создаёт его автоматически)
            if "text" in types and "keyword" not in types and (f + ".keyword") in have:
                f = f + ".keyword"
                types = have[f]      # тип показываем уже у разрешённого поля
            print("%s\t%s\t%s" % (key, f, types))
            break
PYFC
}

fetch_ip_fields() { # полный список полей кластера → $PROG_FILE.ipfields; печатает число полей
  local f="$PROG_FILE.ipfields"
  es GET "/$DATA_TARGET/_field_caps?fields=*&ignore_unavailable=true&allow_no_indices=true" > "$PROG_FILE.fcall" 2>/dev/null || true
  python3 - "$PROG_FILE.fcall" "$f" <<'PYIPF'
import json, sys
NUM = {"long", "integer", "short", "byte", "double", "float", "half_float",
       "scaled_float", "unsigned_long"}
def osd_type(ts):
    # пустое множество — поле-«объект» (dns, http, tls, flow, fileinfo…):
    # в _field_caps у него единственный вариант «object», который выше
    # пропускается; раньше next(iter(set())) падал StopIteration
    if not ts:
        return None
    if len(ts) > 1:
        return "conflict"
    t = next(iter(ts))
    if t in ("keyword", "text", "match_only_text", "constant_keyword", "wildcard"):
        return "string"
    if t in NUM:
        return "number"
    if t in ("date", "date_nanos"):
        return "date"
    if t == "boolean":
        return "boolean"
    if t == "ip":
        return "ip"
    if t in ("geo_point", "geo_shape"):
        return "geo_point"
    return None            # object и прочее — в паттерн не входит
try:
    fc = json.load(open(sys.argv[1], encoding="utf-8")).get("fields", {})
except Exception:
    fc = {}
out = []
for name, variants in fc.items():
    if not name or name.startswith("_"):
        continue
    types, searchable, aggregatable = set(), False, False
    for t, v in variants.items():
        if t == "object":
            continue
        types.add(t)
        searchable = searchable or bool(v.get("searchable"))
        aggregatable = aggregatable or bool(v.get("aggregatable"))
    tt = osd_type(types)
    if tt is None:
        continue
    out.append({"name": name, "type": tt, "esTypes": sorted(types), "count": 1,
                "scripted": False, "searchable": searchable,
                "aggregatable": bool(aggregatable) if tt != "conflict" else False,
                "readFromDocValues": bool(aggregatable and tt in ("string", "number", "date", "boolean", "ip"))})
out.sort(key=lambda e: e["name"])
open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False))
print(len(out))
PYIPF
}

# ── index-pattern: найти/создать + полный список полей ────────────────────
# Выбор паттерна управляется ДАННЫМИ, а не именем:
#   1) точное совпадение титула с $DATA_TARGET (наш или зонтичный SELKS);
#   2) наш ndr-logstash-pattern (титул мог «уплыть» вместе с составом индексов);
#   3) иначе — создаём свой.
# Фолбэк «любой logstash*» убран: им становился, например, logstash-smb-*,
# который не покрывает flow/dns/http/alert-индексы — дашборды при этом пустые
# («No results found», «Could not locate that index-pattern-field»).
# Кандидат принимается, только если его поле времени содержит данные по
# $DATA_TARGET (максимум по полю не пуст); у своего паттерна поле времени
# лечится на ts_field, чужой — пропускается. У найденного паттерна поля
# MERGE-ятся (существующие записи главнее — объекты SELKS не обедняем),
# у своего — заменяются. Большие тела идут через es_file: список полей не
# влезает в argv curl (MAX_ARG_STRLEN 128 КБ).
ip_time_ok() { # $1=индексное выражение $2=поле времени → 0, если по нему есть значения
  local resp v
  [ -n "${2:-}" ] || return 1
  resp="$(es POST "/$1/_search" '{"size":0,"track_total_hits":false,"aggs":{"m":{"max":{"field":"'"$2"'"}}}}')"
  v="$(printf '%s' "$resp" | es_jq_get "str((d.get('aggregations') or {}).get('m',{}).get('value',''))")"
  case "$v" in ''|None|0|0.0) return 1;; *) return 0;; esac
}
ensure_index_pattern() { # $1 = файл с JSON-массивом полей; задаёт IP_ID, IP_TS
  local ts_field
  ts_field="$(awk -F'\t' '$1=="ts"{print $2; exit}' "$PROG_FILE.fields")"
  ts_field="${ts_field:-timestamp}"
  if [ "$DRY" -eq 1 ]; then
    msg "  dry-run: index-pattern «$DATA_TARGET» (time=$ts_field) был бы найден/создан/обновлён полным списком полей" >&2
    IP_ID="ndr-logstash-pattern"; IP_TS="$ts_field"
    return 0
  fi
  local hit_file="$PROG_FILE.iphit" upd_file="$PROG_FILE.ipupd" sel
  es GET '/.kibana/_search?q=type:index-pattern&size=50' > "$hit_file" 2>/dev/null || true
  sel="$(python3 - "$hit_file" "$1" "$DATA_TARGET" "$upd_file" <<'PYIP'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    d = {}
try:
    ours = json.load(open(sys.argv[2], encoding="utf-8"))
except Exception:
    ours = []
want, upd_file = sys.argv[3], sys.argv[4]
cands = []
for h in ((d.get("hits") or {}).get("hits") or []):
    s = h.get("_source") or {}
    ipa = s.get("index-pattern") or {}
    iid = (h.get("_id", "") or "").split(":", 1)[-1]
    cands.append((iid, str(ipa.get("title", "") or ""),
                  str(ipa.get("timeFieldName", "") or ""), ipa.get("fields") or "[]"))
exact = [c for c in cands if c[1] == want]
mine  = [c for c in cands if c[0] == "ndr-logstash-pattern"]
if exact:
    pick, mode = exact[0], "exact"
elif mine:
    pick, mode = mine[0], "mine"
else:
    print("NONE"); raise SystemExit
iid, title, tf, cur_raw = pick
if mode == "exact":
    # чужой/найденный паттерн: поля объединяем — существующие записи главнее,
    # ничего из объектов SELKS не выбрасываем
    try: cur = json.loads(cur_raw)
    except Exception: cur = []
    if not isinstance(cur, list): cur = []
    have = {e.get("name") for e in cur if isinstance(e, dict)}
    out = [e for e in cur if isinstance(e, dict)]
    out += [e for e in ours if e.get("name") not in have]
    out.sort(key=lambda e: str(e.get("name", "")))
    body = {"doc": {"index-pattern": {"fields": json.dumps(out, ensure_ascii=False)}}}
else:
    # свой паттерн: список полей заменяем целиком и синхронизируем титул
    out = sorted(ours, key=lambda e: str(e.get("name", "")))
    body = {"doc": {"index-pattern": {"fields": json.dumps(out, ensure_ascii=False),
                                      "title": want}}}
open(upd_file, "w", encoding="utf-8").write(json.dumps(body, ensure_ascii=False))
print("\t".join([iid, title, tf, mode]))
PYIP
)"
  local ip="" ip_title="" ip_tf="" mode=""
  [ -n "$sel" ] && { ip="$(printf '%s' "$sel" | cut -f1)"; [ "$ip" = "NONE" ] && ip=""; }
  if [ -n "$ip" ]; then
    ip_title="$(printf '%s' "$sel" | cut -f2)"
    ip_tf="$(printf '%s' "$sel" | cut -f3)"
    mode="$(printf '%s' "$sel" | cut -f4)"
    if ! ip_time_ok "$DATA_TARGET" "$ip_tf"; then
      if [ "$mode" = "mine" ]; then
        warn "у своего index-pattern поле времени «$ip_tf» без данных по $DATA_TARGET — переключаю на «$ts_field»"
        ip_tf="$ts_field"
        es POST "/.kibana/_update/index-pattern:$ip" \
          "{\"doc\":{\"index-pattern\":{\"timeFieldName\":\"$ts_field\"}}}" >/dev/null 2>&1
      else
        warn "index-pattern «$ip_title» ($ip) пропущен: поле времени «$ip_tf» не содержит данных по $DATA_TARGET"
        warn "создаю свой паттерн — чужой смотреть не надо, иначе панели пустые"
        ip=""
      fi
    fi
  fi
  if [ -n "$ip" ]; then
    IP_ID="$ip"
    IP_TS="${ip_tf:-$ts_field}"
    local what="найден"
    [ "$mode" = "mine" ] && what="наш"
    ok "index-pattern $what: $ip («${ip_title:-?}», time=$IP_TS)" >&2
    resp="$(es_file POST "/.kibana/_update/index-pattern:$ip" "$upd_file")"
    if printf '%s' "$resp" | grep -q '"error"'; then
      warn "не удалось дописать поля в index-pattern ($(printf '%s' "$resp" | head -c 160))"
    else
      ok "поля index-pattern синхронизированы из кластера ($(python3 -c "import json;print(len(json.load(open('$1'))))" 2>/dev/null || echo '?') полей)" >&2
    fi
    return 0
  fi
  ip="ndr-logstash-pattern"
  python3 -c "
import json, sys
src = {'type': 'index-pattern',
       'index-pattern': {'title': sys.argv[1], 'timeFieldName': sys.argv[2],
                          'fields': open(sys.argv[3], encoding='utf-8').read()}}
try:
    mv = (json.loads(sys.argv[4]) or {}).get('index-pattern')
except Exception:
    mv = None
if mv: src['migrationVersion'] = {'index-pattern': mv}
open(sys.argv[5], 'w', encoding='utf-8').write(json.dumps(src, ensure_ascii=False))" \
    "$DATA_TARGET" "$ts_field" "$1" "${MV_JSON:-}" "$upd_file"
  resp="$(es_file POST "/.kibana/_doc/index-pattern:$ip" "$upd_file")"
  local id
  id="$(printf '%s' "$resp" | es_jq_get "str(d.get('_id','').split(':',1)[-1])")"
  if [ -n "$id" ]; then
    IP_ID="$ip"; IP_TS="$ts_field"
    ok "index-pattern создан: $ip ($DATA_TARGET, time=$ts_field, полный список полей)" >&2
    return 0
  fi
  err "не удалось создать index-pattern ($(printf '%s' "$resp" | head -c 160))" >&2
  return 1
}

# ── рендер пакета: подстановка полей, вырезание отсутствующих визов ──────────
render_pack() { # $1=pack-file $2=index-pattern-id $3=fields-file $4=mv-json $5=ts-field; NDJSON на stdout
  python3 - "$1" "$2" "$3" "$4" "${5:-timestamp}" <<'PYRENDER'
import json, sys, re
pack_path, ip_id, fields_file = sys.argv[1], sys.argv[2], sys.argv[3]
ts_field = sys.argv[5] or "timestamp"
try:
    mv_map = json.loads(sys.argv[4]) if sys.argv[4] else {}
except Exception:
    mv_map = {}
fields = {}
for line in open(fields_file, encoding="utf-8"):
    parts = line.rstrip("\n").split("\t")
    if len(parts) == 3:
        fields[parts[0]] = parts[1]
pack = json.load(open(pack_path, encoding="utf-8"))

def subst(s):
    s = s.replace("__IP__", ip_id)
    if s == "__TS__":
        # поле времени — из найденного index-pattern, а не из кандидатов:
        # диапазон времени панели обязан совпадать с timeFieldName паттерна
        return ts_field
    return re.sub(r"__F:([a-z_0-9]+)__", lambda m: fields.get(m.group(1), m.group(0)), s)

def vis_fields(obj):
    """Поля, на которые ссылается визуализация (для проверки наличия)."""
    out = set()
    vs = obj["attributes"].get("visState", "")
    for m in re.finditer(r"__F:([a-z_0-9]+)__", vs or ""):
        out.add(m.group(1))
    for m in re.finditer(r"__F:([a-z_0-9]+)__", obj["attributes"].get("kibanaSavedObjectMeta", {}).get("searchSourceJSON", "")):
        out.add(m.group(1))
    return out

missing_all = set()
keep, vis_ok = [], {}
for o in pack["objects"]:
    if o["type"] == "visualization":
        miss = {f for f in vis_fields(o) if f not in fields}
        if miss:
            missing_all |= miss
            vis_ok[o["id"]] = False
            continue
        vis_ok[o["id"]] = True
for o in pack["objects"]:
    t = o["type"]
    if t == "visualization":
        keep.append(o)
    elif t == "dashboard":
        panels = json.loads(o["attributes"]["panelsJSON"])
        refs = [r for r in o["references"]]
        panels2, refs2 = [], []
        i = 0
        for p in panels:
            if vis_ok.get(p.get("id"), False):
                i += 1
                p = dict(p)
                p["panelIndex"] = str(i)
                p["gridData"] = dict(p["gridData"]); p["gridData"]["i"] = str(i)
                panels2.append(p)
        for r in refs:
            if vis_ok.get(r["id"], False):
                refs2.append(r)
        o = json.loads(json.dumps(o))  # deep copy
        o["attributes"]["panelsJSON"] = json.dumps(panels2, ensure_ascii=False)
        o["references"] = refs2
        keep.append(o)
    else:
        keep.append(o)

out = []
for o in keep:
    s = json.dumps(o, ensure_ascii=False)
    s = subst(s)
    s = subst(s)  # повтор: поля внутри подставленных значений
    doc = {"_index": ".kibana", "_id": "%s:%s" % (o["type"], o["id"])}
    attrs = json.loads(s)
    # сырой формат .kibana: type + атрибуты под именем типа + references
    # (envelope «attributes» — только у SavedObjects HTTP API, не в индексе)
    src = {"type": o["type"], o["type"]: attrs["attributes"],
           "references": attrs.get("references", [])}
    if o["type"] in mv_map:
        src["migrationVersion"] = {o["type"]: mv_map[o["type"]]}
    out.append(json.dumps({"index": doc}, ensure_ascii=False))
    out.append(json.dumps(src, ensure_ascii=False))
sys.stderr.write(json.dumps({"missing": sorted(missing_all), "count": len(keep)}, ensure_ascii=False) + "\n")
print("\n".join(out))
PYRENDER
}

# ── режимы ───────────────────────────────────────────────────────────────────
do_list() {
  step "Доступные пакеты ($PACKS_DIR)"
  for f in "$PACKS_DIR"/*.json; do
    [ -f "$f" ] || { warn "пакеты не найдены в $PACKS_DIR"; return 0; }
    python3 -c "
import json,sys
p=json.load(open('$f'))
d=sum(1 for o in p['objects'] if o['type']=='dashboard')
v=sum(1 for o in p['objects'] if o['type']=='visualization')
print('  %-8s %-24s дашбордов=%d визуализаций=%d — %s' % (p['key'], p['title'], d, v, p['description']))
"
  done
}

expand_packs() {
  if [ "${#PACKS[@]}" -eq 0 ]; then err "не выбран пакет: --pack <key|all>"; return 1; fi
  local expanded=() p
  for p in "${PACKS[@]}"; do
    case "$p" in
      all)
        for f in "$PACKS_DIR"/*.json; do
          [ -f "$f" ] && expanded+=("$(basename "$f" .json)")
        done ;;
      traffic|http|dns|tls|alerts|files) expanded+=("$p");;
      "") err "пустое значение --pack"; return 1;;
      *) err "неизвестный пакет: $p (доступны: traffic http dns tls alerts files all)"; return 1;;
    esac
  done
  PACKS=("${expanded[@]}")
  # уникализация с сохранением порядка
  local -A seen=(); local uniq=()
  for p in "${PACKS[@]}"; do [ -z "${seen[$p]:-}" ] && seen[$p]=1 && uniq+=("$p"); done
  PACKS=("${uniq[@]}")
  return 0
}

do_import() {
  discover_data_target || return 1
  step "Определение полей событий ($DATA_TARGET)"
  detect_fields > "$PROG_FILE.fields" || true
  local nf; nf="$(wc -l < "$PROG_FILE.fields" | tr -d ' ')"
  [ "$nf" -gt 0 ] || { err "поля не определены — в $DATA_TARGET нет полей EVE/ECS (есть ли данные? см. --check)"; return 1; }
  ok "определено полей-кандидатов: $nf"
  # версии миграций существующих объектов — для сырого формата .kibana
  MV_JSON="$(sample_migration_versions)"

  step "Полный список полей index-pattern"
  local nf_all; nf_all="$(fetch_ip_fields)"
  case "$nf_all" in ''|0) err "не удалось получить список полей из $DATA_TARGET"; return 1;; esac
  ok "полей в index-pattern: $nf_all"

  step "Index-pattern"
  ensure_index_pattern "$PROG_FILE.ipfields" || return 1

  local created=0 updated=0 failed=0 p
  for p in "${PACKS[@]}"; do
    local f="$PACKS_DIR/$p.json"
    [ -f "$f" ] || { err "файл пакета не найден: $f"; return 2; }
    step "Импорт пакета: $p"
    render_pack "$f" "$IP_ID" "$PROG_FILE.fields" "${MV_JSON:-}" "$IP_TS" > "$PROG_FILE.bulk" 2> "$PROG_FILE.render" || true
    # render_pack пишет в stderr JSON {"missing": [...], "count": N} — показываем
    # вырезанные визуализации: это внятное объяснение, каких полей нет в кластере
    local miss
    miss="$(python3 -c "
import json
try: m = json.load(open('$PROG_FILE.render', encoding='utf-8')).get('missing', [])
except Exception: m = []
print(', '.join(m))" 2>/dev/null)"
    [ -n "$miss" ] && warn "пакет $p: визуализации по отсутствующим в $DATA_TARGET полям вырезаны: $miss"
    # NDJSON считается по файлу stdout (stderr уходит в отдельный файл)
    local lines; lines="$(grep -c . "$PROG_FILE.bulk" || true)"
    if [ "$lines" -eq 0 ]; then warn "пакет $p: все визуализации вырезаны (поля отсутствуют)"; continue; fi
    if [ "$DRY" -eq 1 ]; then
      msg "  dry-run: было бы записано объектов: $((lines / 2))"
      continue
    fi
    # бэкап существующих объектов с теми же id
    grep '"index"' "$PROG_FILE.bulk" | python3 -c '
import json,sys
for line in sys.stdin:
    d=json.loads(line)["index"]
    print(d["_id"])
' | while read -r doc_id; do
      backup_obj "$(printf '%s' "$doc_id" | tr -c 'A-Za-z0-9._-' '_')" "$(es GET "/.kibana/_doc/$doc_id")"
    done
    local resp rc
    resp="$(es_bulk "$PROG_FILE.bulk")"
    rc="$(printf '%s' "$resp" | es_jq_get "str(d.get('errors'))")"
    if [ "$rc" = "False" ]; then
      ok "пакет $p импортирован: $((lines / 2)) объектов"
      created=$((created + lines / 2))
    else
      local errs; errs="$(printf '%s' "$resp" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("ответ не разобран"); raise SystemExit
e=d.get("error")
if e and not d.get("items"):
    print("bulk не принят — %s" % str(e)[:200]); raise SystemExit
n=0
for it in d.get("items", []):
    r=it.get("index") or it.get("create") or {}
    if r.get("error"):
        n+=1
        if n<=3: print(r.get("_id",""), "->", str(r.get("error"))[:160])
print("ошибок:", n)
' 2>/dev/null)"
      err "пакет $p: ошибки bulk — $errs"; failed=$((failed+1))
    fi
  done
  if [ "$DRY" -ne 1 ]; then
    step "Проверка"
    local have_n
    have_n="$(es GET '/.kibana/_search?q=_id:ndr-pack-*&size=0' | es_jq_get "str(d['hits']['total']['value'])")"
    ok "объектов ndr-pack-* в .kibana: ${have_n:-0}"
    verify_data "$IP_TS"
    msg "Откройте OpenSearch Dashboards → Dashboards — дашборды «NDR · …» появятся в списке."
    msg "Панели пустые? Обновите страницу OSD (кэш полей паттерна) и проверьте диапазон времени."
  fi
  [ "$failed" -eq 0 ]
}

do_check() { # диагностика: данные, поля, index-pattern'ы — без изменений в кластере
  discover_data_target
  step "Определение полей событий ($DATA_TARGET)"
  detect_fields > "$PROG_FILE.fields" || true
  local nf; nf="$(wc -l < "$PROG_FILE.fields" | tr -d ' ')"
  if [ "$nf" -gt 0 ]; then
    ok "полей-кандидатов найдено: $nf"
    awk -F'\t' '{printf "  %-12s → %s (%s)\n", $1, $2, $3}' "$PROG_FILE.fields"
  else
    err "поля EVE/ECS в $DATA_TARGET не найдены"
  fi
  step "Полный список полей index-pattern"
  local nf_all; nf_all="$(fetch_ip_fields)"
  ok "полей в кластере под $DATA_TARGET: ${nf_all:-0}"
  step "Index-pattern'ы в .kibana"
  es GET '/.kibana/_search?q=type:index-pattern&size=50' | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = {}
rows = []
for h in ((d.get("hits") or {}).get("hits") or []):
    s = h.get("_source") or {}
    ipa = s.get("index-pattern") or {}
    try: nf = len(json.loads(ipa.get("fields") or "[]"))
    except Exception: nf = 0
    rows.append((h.get("_id", ""), str(ipa.get("title", "")), str(ipa.get("timeFieldName", "")), nf))
if not rows:
    print("  (нет)")
for r in sorted(rows):
    print("  %s — «%s», time=%s, полей в паттерне: %d" % r)
' 2>/dev/null
  step "Данные"
  verify_data "$(awk -F'\t' '$1=="ts"{print $2; exit}' "$PROG_FILE.fields")"
  if [ "${DATA_DOCS:-0}" != "0" ] && [ "$nf" -gt 0 ]; then
    return 0
  fi
  return 1
}

do_remove() {
  step "Удаление объектов ndr-pack-*"
  local pat
  case "${PACKS[0]:-}" in
    all|"") pat="ndr-pack-*";;
    *) 
      local p
      for p in "${PACKS[@]}"; do
        case "$p" in traffic|http|dns|tls|alerts|files) ;; *) err "неизвестный пакет: $p"; return 1;; esac
      done
      pat="$(printf 'ndr-pack-(%s)-*|"ndr-pack-(%s)"' "$(IFS='|'; echo "${PACKS[*]}")" "$(IFS='|'; echo "${PACKS[*]}")")"
      ;;
  esac
  if [ "$DRY" -eq 1 ]; then
    msg "  dry-run: удалил бы объекты по маске id: $pat"
    return 0
  fi
  local ids
  ids="$(es GET '/.kibana/_search?q=_id:ndr-pack-*&size=500' | python3 -c '
import json,sys,re
pat = sys.argv[1]
try: rx = re.compile("^(" + "|".join(re.escape(x) for x in [pat]) + ")$")
except Exception: rx=None
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
for h in ((d.get("hits") or {}).get("hits") or []):
    print(h.get("_id",""))
' "$pat" 2>/dev/null)"
  # для простоты: удаляем ВСЕ ndr-pack-* при all, при выбранном пакете фильтруем по id
  if [ "${PACKS[0]:-}" != "all" ] && [ -n "${PACKS[0]:-}" ]; then
    ids="$(printf '%s\n' "$ids" | grep -E -- "ndr-pack-($(IFS='|'; echo "${PACKS[*]}"))" || true)"
  fi
  local n=0
  printf '%s\n' "$ids" | while read -r doc_id; do
    [ -n "$doc_id" ] || continue
    backup_obj "$(printf '%s' "$doc_id" | tr -c 'A-Za-z0-9._-' '_')" "$(es GET "/.kibana/_doc/$doc_id")"
    es DELETE "/.kibana/_doc/$doc_id" >/dev/null 2>&1 && { ok "удалён: $doc_id"; n=$((n+1)); } || warn "не удалён: $doc_id"
  done
  ok "Готово (бэкапы: ${BACKUP_ROOT:-—})"
}

# ── main ─────────────────────────────────────────────────────────────────────
SUF=""; [ "$DRY" -eq 1 ] && SUF=" (dry-run)"
msg "$SELF — режим: $MODE$SUF"
case "$MODE" in
  list)   do_list; exit 0;;
  remove)
    [ "$YES" -eq 1 ] || { [ -t 0 ] || { err "нужен --yes для неинтерактивного удаления"; exit 1; }; }
    if [ "$YES" -ne 1 ] && [ -t 0 ]; then
      printf 'Удалить объекты пакетов (%s)? [y/N] ' "${PACKS[0]:-all}"
      read -r a; case "$a" in y*|Y*) ;; *) msg "Отменено"; exit 0;; esac
    fi
    expand_packs || exit 2
    detect_es || exit 1
    do_remove; exit 0;;
  import)
    expand_packs || exit 2
    detect_es || exit 1
    do_import; exit $?;;
  check)
    detect_es || exit 1
    do_check; exit $?;;
esac
