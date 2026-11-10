#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# clearndr-osd-analytics-setup.sh — наполнение разделов OpenSearch Dashboards
# «Alerting», «Anomaly Detection» и «Security Analytics» данными Suricata EVE
# (индексы logstash-*), созданными стеком clearNDR.
#
# Почему эти разделы пусты: плагины в сборке OSD 3.x включены, но ни один
# объект (монитор/детектор) в них не создан — стек clearNDR не делает этого
# сам. Данных достаточно: event_type=alert/flow/dns/http/tls/fileinfo в
# logstash-*. Этот скрипт создаёт управляемые объекты (префикс «NDR ·»):
#
#   Alerting   — per-index мониторы: критичные алерты, всплески, DNS-флуд,
#                файловая активность, всплеск потоков. Действие — запись в
#                индекс аудита ndr-alerts-audit (работает без SMTP/Slack).
#   Anomaly    — детекторы: объём трафика (bytes) по источникам, число DNS
#                запросов по источникам (ML Commons, интервал 5 мин).
#   Security Analytics — детектор типа network по logstash-* c маппингом
#                полей EVE→ECS и включением встроенных правил (Sigma).
#
# Объекты идемпотентны: повторный запуск обновляет, а не дублирует (upsert по
# имени). Перед каждой заменой копия сохраняется в backups/. Удаление всех
# управляемых объектов: --remove-managed.
#
# Использование:
#   clearndr-osd-analytics-setup.sh --status
#   clearndr-osd-analytics-setup.sh --apply-alerting|--apply-anomaly|
#        --apply-security|--apply-all [--yes] [--dry-run]
#   clearndr-osd-analytics-setup.sh --remove-managed [--yes]
# Опции: --instance-dir DIR (по умолч. /opt/ClearNDR), --es-url URL (иначе
# автоопределение: https/http на 127.0.0.1, 172.17.0.1, host.docker.internal,
# затем docker exec в контейнер -opensearch-<seed>; URL с авторизацией —
# https://user:pass@host:9200), --seed SEED, --webhook URL (доп. действие webhook,
# требует настроенный канал notifications), --no-color.
# Коды выхода: 0 — успех (допустимы предупреждения), 1 — ошибка среды.
# ─────────────────────────────────────────────────────────────────────────────
set -u
SELF="$(basename "$0")"
INSTANCE_DIR="/opt/ClearNDR"
ES_URL=""
SEED=""
WEBHOOK=""
YES=0 DRY=0 NO_COLOR=0
MODE=""

msg()   { printf '%s\n' "$*"; }
step()  { printf '\n== %s\n' "$*"; }
ok()    { printf '[ OK ] %s\n' "$*"; }
warn()  { printf '[WARN] %s\n' "$*"; }
err()   { printf '[FAIL] %s\n' "$*"; }
have()  { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --status|--apply-alerting|--apply-anomaly|--apply-security|--apply-all|--remove-managed)
      MODE="${1#--}"; MODE="${MODE#apply-}"; [ "$1" = "--remove-managed" ] && MODE="remove";;
    --instance-dir) INSTANCE_DIR="${2:-}"; shift;;
    --es-url)       ES_URL="${2:-}"; shift;;
    --seed)         SEED="${2:-}"; shift;;
    --webhook)      WEBHOOK="${2:-}"; shift;;
    --yes)          YES=1;;
    --dry-run)      DRY=1;;
    --no-color)     NO_COLOR=1;;
    -h|--help)      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) err "Неизвестный аргумент: $1"; exit 1;;
  esac
  shift
done
[ -n "$MODE" ] || { err "Не выбран режим: --status | --apply-alerting | --apply-anomaly | --apply-security | --apply-all | --remove-managed"; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$INSTANCE_DIR/backups/osd-analytics-$TS"
PROG_FILE="/tmp/ndr-osd-analytics.progress"

# ── выбор контейнера opensearch ──────────────────────────────────────────────
find_os_container() {
  have_docker || return 1
  if [ -n "$SEED" ]; then
    docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- "-opensearch-[A-Za-z0-9_]+$" | grep -- "$SEED" | head -1 && return 0
  fi
  docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- "-opensearch-[A-Za-z0-9_]+$" | head -1
}
have_docker() { docker info >/dev/null 2>&1; }

# ── доступ к ES: --es-url → https/http на 127.0.0.1, 172.17.0.1,
#    host.docker.internal → docker exec в контейнер opensearch ────────────────
# Из контейнера хаба (local-режим) 127.0.0.1 — сам хаб, поэтому перебираем
# шлюз docker-моста и host.docker.internal; на хосте (ssh) первым отвечает
# 127.0.0.1. Схема определяется автоматически (security-плагин = https).
ES_MODE=""            # host | exec
OS_CT=""
ES_BASE=""            # база вида https://host:9200 (без завершающего /)
AUTH=""               # 401/403, если OpenSearch требует авторизацию
es_mask() { printf '%s' "$1" | sed -E 's#(://[^/@:]+):[^@]*@#\1:***@#'; }
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
es() { # es METHOD PATH [BODY] — по выбранному каналу
  local m="$1" p="$2" b="${3:-}"
  case "$p" in /*) ;; *) p="/$p" ;; esac
  case "$ES_MODE" in
    host) curl -sk --noproxy '*' --max-time 20 -X "$m" -H 'Content-Type: application/json' ${b:+-d "$b"} "$ES_BASE$p" 2>/dev/null ;;
    exec) docker exec "$OS_CT" curl -sk --noproxy '*' --max-time 20 -X "$m" -H 'Content-Type: application/json' ${b:+-d "$b"} "$ES_BASE$p" 2>/dev/null ;;
  esac
}
es_jq_get() { # вытащить простое значение python-ом: es_jq_get '<py-expr над json из stdin>'
  python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); raise SystemExit
print($1)" 2>/dev/null
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

# ── доступ к .kibana (запись объектов дашбордов не нужна здесь, но remove
#    дашбордов из pack'ов выполняет clearndr-osd-dashboard-import.sh) ─────────
BACKUP_DIR=""
backup_obj() { # $1=name-file $2=json
  [ -n "$BACKUP_DIR" ] || { mkdir -p "$BACKUP_ROOT" 2>/dev/null && BACKUP_DIR="$BACKUP_ROOT"; }
  [ -n "$BACKUP_DIR" ] || return 0
  printf '%s' "$2" > "$BACKUP_DIR/$1.json" 2>/dev/null || true
}

# ── определение полей через _field_caps ─────────────────────────────────────
FIELD_CANDIDATES='
ts timestamp|@timestamp|time
src_ip src_ip|source.ip|source_ip|source.address
dst_ip dest_ip|destination.ip|destination_ip|destination.address
dst_port dest_port|destination.port
proto proto|network.transport
event_type event_type|event.type
app_proto app_proto|network.protocol
alert_sev alert.severity|event.severity
alert_sid alert.signature_id|rule.id
alert_name alert.signature|rule.name
alert_cat alert.category|rule.category
bytes_out flow.bytes_toserver|source.bytes
bytes_in flow.bytes_toclient|destination.bytes
pkts_out flow.packets_toserver|source.packets
dns_name dns.rrname|dns.query.name|dns.name
dns_type dns.type|dns.query.type
dns_rcode dns.rcode|dns.response_code
http_host http.hostname|http.host|url.domain
http_url http.url|url.original
http_method http.http_method|http.request.method
http_status http.status|http.response.status_code
http_ua http.http_user_agent|user_agent.original
tls_sni tls.client.server_name|tls.sni|server.name
ja3 tls.ja3.hash|tls.ja3|tls.client.ja3
file_name fileinfo.filename|file.name
file_size fileinfo.size|file.size
file_magic fileinfo.magic|file.magic
'
FIELD_CAPS_FIELDS="$(printf '%s\n' "$FIELD_CANDIDATES" | sed -n 's/^[a-z_0-9]* //p' | tr '\n' ',' | sed 's/|/,/g; s/,$//')"
detect_fields() { # печатает «KEY<TAB>поле<TAB>тип» по _field_caps (через es())
  local caps_file="$PROG_FILE.fieldcaps" cands_file="$PROG_FILE.cands"
  printf '%s' "$FIELD_CANDIDATES" > "$cands_file"
  es GET "/logstash-*/_field_caps?fields=${FIELD_CAPS_FIELDS}&ignore_unavailable=true&allow_no_indices=true" > "$caps_file" 2>/dev/null || true
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
have = {}
for fname, spec in fc.items():
    have[fname] = ",".join(sorted(spec.keys()))
for key, fields in cands.items():
    for f in fields:
        if f in have:
            print("%s\t%s\t%s" % (key, f, have[f]))
            break
PYFC
}

# python-хелпер сбора полей в JSON для подстановки в объекты
fields_json() { # stdin: вывод detect_fields → {"key":"field",...,"__types__":{...}}
  python3 -c '
import json, sys
d, tp = {}, {}
for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) == 3:
        d[parts[0]] = parts[1]
        tp[parts[0]] = parts[2]
d["__types__"] = tp
print(json.dumps(d))
'
}

# ── Alerting: спецификация мониторов (строится python-ом с полями) ──────────
alerting_specs_py() { # $1 = JSON полей; печатает NDJSON: name<TAB>json
  python3 - "$1" "$WEBHOOK" <<'PYSPEC'
import json, sys
F = json.loads(sys.argv[1])
hook = sys.argv[2]
def f(k, default):
    v = F.get(k) or default
    return v
sev   = f("alert_sev", "alert.severity")
etype = f("event_type", "event_type")
dnsq  = f("event_type", "event_type")
sig   = f("alert_sid", "alert.signature_id")
flowb = f("bytes_out", "flow.bytes_toserver")

def monitor(name, desc, query, threshold, severity, interval=5):
    body = {
        "type": "monitor",
        "schema_version": 1,
        "name": name,
        "monitor_type": "per_index",
        "enabled": True,
        "description": desc + " · создано NDR Rules Hub",
        "schedule": {"period": {"interval": interval, "unit": "MINUTES"}},
        "inputs": [{
            "search": {
                "indices": ["logstash-*"],
                "query": {"query": query}
            }
        }],
        "triggers": [{
            "name": name + " — срабатывание",
            "severity": severity,
            "condition": {"script": {
                "source": "ctx.results[0].hits.total.value > %d" % threshold,
                "lang": "painless"
            }},
            "actions": [{
                "name": "audit-index",
                "action_type": "index",
                "index": "ndr-alerts-audit",
                "doc_type": "_doc",
                "message": (name + ": {{ctx.results.0.hits.total.value}} событий за "
                            "{{ctx.periodStart}}–{{ctx.periodEnd}}")
            }]
        }]
    }
    if hook:
        body["triggers"][0]["actions"].append({
            "name": "webhook", "action_type": "webhook",
            "message": name, "destination_id": hook
        })
    return body

specs = [
    ("NDR · 01 Критический алерт Suricata (severity 1)",
     "Любое событие alert с alert.severity=1",
     {"bool": {"filter": [{"term": {etype: "alert"}}, {"term": {sev: 1}}]}},
     0, "1", 5),
    ("NDR · 02 Всплеск алертов severity 2",
     "Более 50 событий alert.severity=2 за 10 минут — массовая активность",
     {"bool": {"filter": [{"term": {etype: "alert"}}, {"term": {sev: 2}}]}},
     50, "2", 10),
    ("NDR · 03 DNS-флуд",
     "Более 1000 dns-событий за 5 минут от стека",
     {"bool": {"filter": [{"term": {etype: "dns"}}]}},
     1000, "3", 5),
    ("NDR · 04 Активность fileinfo",
     "Зафиксирована передача файлов (event_type=fileinfo)",
     {"bool": {"filter": [{"term": {etype: "fileinfo"}}]}},
     0, "5", 15),
    ("NDR · 05 Всплеск сетевых потоков",
     "Более 5000 событий flow за 5 минут — сканирование/флуд/DDoS",
     {"bool": {"filter": [{"term": {etype: "flow"}}]}},
     5000, "3", 5),
]
for name, desc, q, thr, sv, iv in specs:
    print(json.dumps(name) + "\t" + json.dumps(monitor(name, desc, q, thr, sv, iv)))
PYSPEC
}

# ── Anomaly: спецификация детекторов ─────────────────────────────────────────
anomaly_specs_py() { # $1 = JSON полей; NDJSON name<TAB>json
  python3 - "$1" <<'PYSPEC'
import json, sys
F = json.loads(sys.argv[1])
def f(k, default):
    return F.get(k) or default
ts    = f("ts", "timestamp")
src   = f("src_ip", "src_ip")
bout  = f("bytes_out", "flow.bytes_toserver")
bin_  = f("bytes_in", "flow.bytes_toclient")
etype = f("event_type", "event_type")

def det(name, desc, features, category=None):
    d = {
        "name": name,
        "description": desc + " · создано NDR Rules Hub",
        "time_field": ts,
        "indices": ["logstash-*"],
        "feature_attributes": features,
        "detection_interval": {"period": {"interval": 5, "unit": "MINUTES"}},
        "window_delay": {"period": {"interval": 2, "unit": "MINUTES"}},
    }
    if category:
        d["category_field"] = [category]
    return d

out = []
if F.get("bytes_out"):
    out.append(("NDR · Аномалии объёма трафика (исходящие байты)",
        det("NDR · Аномалии объёма трафика (исходящие байты)",
            "ML-детектор: суммарные байты flow к серверам по каждому источнику",
            [{"feature_name": "bytes_to_server",
              "feature_type": "aggregation_feature",
              "aggregation_query": {"bytes_sum": {"sum": {"field": bout}}}}],
            src if F.get("__types__", {}).get("src_ip") in ("ip", "keyword") else None)))
out.append(("NDR · Аномалии DNS-запросов по источникам",
    det("NDR · Аномалии DNS-запросов по источникам",
        "ML-детектор: количество dns-событий по каждому источнику",
        [{"feature_name": "dns_events",
          "feature_type": "aggregation_feature",
          "aggregation_query": {"dns_cnt": {
              "filter": {"term": {etype: "dns"}},
              "aggs": {"cnt": {"value_count": {"field": "_index"}}}}}}],
        src if F.get("__types__", {}).get("src_ip") in ("ip", "keyword") else None)))
for name, body in out:
    print(json.dumps(name) + "\t" + json.dumps(body))
PYSPEC
}

# ── Security Analytics: детектор network + маппинг EVE→ECS ───────────────────
security_py() { # $1 = JSON полей; печатает 3 строки NDJSON: kind<TAB>json
  python3 - "$1" <<'PYSPEC'
import json, sys
F = json.loads(sys.argv[1])
def f(k, default):
    return F.get(k) or default
mappings = {
    "source.ip": f("src_ip", "src_ip"),
    "destination.ip": f("dst_ip", "dest_ip"),
    "destination.port": f("dst_port", "dest_port"),
    "network.transport": f("proto", "proto"),
    "rule.name": f("alert_name", "alert.signature"),
    "rule.id": f("alert_sid", "alert.signature_id"),
    "rule.category": f("alert_cat", "alert.category"),
    "event.severity": f("alert_sev", "alert.severity"),
    "network.protocol": f("app_proto", "app_proto"),
}
dets = {
    "kind": "detector",
    "body": {
        "name": "NDR · Suricata network (Sigma)",
        "enabled": True,
        "detector_type": "network",
        "inputs": [{"detector_input": {"indices": ["logstash-*"], "description": "EVE-события Suricata из clearNDR"}}],
        "schedule": {"period": {"interval": 5, "unit": "MINUTES"}},
        "auto_create_alerts": True,
    }
}
m = {"kind": "mappings", "body": {"index_name": "logstash-*", "log_type": "network", "field_mappings": mappings}}
# NB: первая колонка — явный маркер (пустое первое поле bash read не читает)
print("mappings\t" + json.dumps(m["body"]))
print("detector\t" + json.dumps(dets["body"]))
PYSPEC
}

# ── применение спецификаций: upsert по имени ─────────────────────────────────
apply_specs() { # $1=api-base $2=файл NDJSON (name<TAB>json) $3=тип (для логов)
  local api="$1" ndjson="$2" kind="$3" created=0 updated=0 skipped=0 line name body id resp existing
  existing="$(es GET "$api?size=200" 2>/dev/null || true)"
  while IFS=$'\t' read -r name body; do
    [ -n "${name:-}" ] || continue
    id="$(printf '%s' "$existing" | python3 -c '
import json,sys
name=json.loads(sys.argv[1])
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
hits=(d.get("hits") or {}).get("hits") or []
for h in hits:
    if (h.get("_source") or {}).get("name")==name:
        print(h["_id"]); break
' "$name" 2>/dev/null)"
    if [ "$DRY" -eq 1 ]; then
      msg "  dry-run: $kind «$name» был бы ${id:+обновлен (id=$id)}${id:-создан}"
      continue
    fi
    if [ -n "$id" ]; then
      resp="$(es GET "$api/$id" | es_jq_get "str((d.get('_source') or {}).get('name',''))")"
      if [ -n "$resp" ]; then backup_obj "$kind-$(printf '%s' "$id" | tr -c 'A-Za-z0-9._-' '_')" "$(es GET "$api/$id")"; fi
      if es PUT "$api/$id" "$body" | grep -q '"_id"'; then
        ok "$kind обновлён: $name (id=$id)"; updated=$((updated+1))
      else
        warn "не удалось обновить $kind: $name"; skipped=$((skipped+1))
      fi
    else
      resp="$(es POST "$api" "$body")"
      id="$(printf '%s' "$resp" | es_jq_get "str(d.get('_id',''))")"
      if [ -n "$id" ]; then
        ok "$kind создан: $name (id=$id)"; created=$((created+1))
      else
        warn "не удалось создать $kind: $name — $(printf '%s' "$resp" | head -c 200)"; skipped=$((skipped+1))
      fi
    fi
  done < "$ndjson"
  msg "  Итого ($kind): создано=$created обновлено=$updated пропущено=$skipped"
}

# ── удаление управляемых объектов ────────────────────────────────────────────
remove_managed() {
  step "Удаление управляемых объектов (префикс «NDR ·»)"
  for spec in "_plugins/_alerting/monitors|монитор" "_plugins/_anomaly_detection/detectors|детектор AD" "_plugins/_security_analytics/detectors|детектор SA"; do
    api="${spec%%|*}"; kind="${spec##*|}"
    list="$(es GET "$api?size=200")"
    printf '%s' "$list" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
for h in ((d.get("hits") or {}).get("hits") or []):
    n=(h.get("_source") or {}).get("name","")
    if n.startswith("NDR"):
        print("%s\t%s" % (h.get("_id",""), n))
' 2>/dev/null | while IFS=$'\t' read -r id name; do
      [ -n "$id" ] || continue
      if [ "$DRY" -eq 1 ]; then msg "  dry-run: удалил бы $kind «$name»"; continue; fi
      backup_obj "$kind-$id" "$(es GET "$api/$id")"
      es DELETE "$api/$id" >/dev/null 2>&1 && ok "удалён $kind: $name" || warn "не удалось удалить $kind: $name"
    done
  done
  ok "Готово"
}

# ── STATUS ───────────────────────────────────────────────────────────────────
do_status() {
  step "Кластер"
  info="$(es GET /)"
  cname="$(printf '%s' "$info" | es_jq_get "str(d.get('cluster_name',''))")"
  cver="$(printf '%s' "$info" | es_jq_get "str((d.get('version') or {}).get('number',''))")"
  [ -n "$cname" ] && ok "кластер: $cname, OpenSearch $cver" || { err "кластер недоступен"; return 1; }

  step "Плагины (что доступно наполнить)"
  plugins="$(es GET '/_cat/plugins?h=component')"
  for p in opensearch-alerting opensearch-anomaly-detection opensearch-security-analytics; do
    if printf '%s' "$plugins" | grep -q "$p"; then ok "$p: установлен"; else warn "$p: ОТСУТСТВУЕТ — раздел наполнить нельзя"; fi
  done

  step "Данные событий"
  idx="$(es GET '/_cat/indices/logstash-*?h=index,docs.count&bytes=mb')"
  nidx="$(printf '%s' "$idx" | grep -c . || true)"
  docs="$(printf '%s' "$idx" | awk '{s+=$2} END{printf "%d", s+0}')"
  ok "индексов logstash-*: $nidx, документов: $docs"

  step "Поля событий (автоопределение EVE/ECS)"
  detect_fields > "$PROG_FILE.fields" 2>/dev/null || true
  nf=0
  while IFS=$'\t' read -r k f t; do
    [ -n "$k" ] || continue
    printf '  %-12s -> %-24s (%s)\n' "$k" "$f" "$t"
    nf=$((nf+1))
  done < "$PROG_FILE.fields"
  [ "$nf" -gt 0 ] && ok "определено полей: $nf" || warn "поля не определены (нет данных?)"

  step "Существующие управляемые объекты"
  for spec in "_plugins/_alerting/monitors|мониторы Alerting" "_plugins/_anomaly_detection/detectors|детекторы Anomaly" "_plugins/_security_analytics/detectors|детекторы Security Analytics"; do
    api="${spec%%|*}"; kind="${spec##*|}"
    n="$(es GET "$api?size=200" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("0"); raise SystemExit
hits=(d.get("hits") or {}).get("hits") or []
print(sum(1 for h in hits if ((h.get("_source") or {}).get("name") or "").startswith("NDR")))
' 2>/dev/null || echo 0)"
    printf '  %-28s %s\n' "$kind:" "${n:-0} (NDR ·)"
  done
  return 0
}

# ── применение ───────────────────────────────────────────────────────────────

gather_fields() {
  detect_fields > "$PROG_FILE.fields" 2>/dev/null
  [ -s "$PROG_FILE.fields" ] || { err "поля событий не определены — данные logstash-* отсутствуют?"; return 1; }
  fields_json < "$PROG_FILE.fields" > "$PROG_FILE.fieldsjson"
  ok "поля определены: $(wc -l < "$PROG_FILE.fields" | tr -d ' ') ключей"
}

apply_alerting() {
  step "Alerting: мониторы по событиям Suricata"
  if ! es GET '/_plugins/_alerting/monitors?size=1' | grep -q '"hits"'; then
    warn "плагин alerting недоступен — пропускаю"; return 0
  fi
  alerting_specs_py "$(cat "$PROG_FILE.fieldsjson")" > "$PROG_FILE.alerting"
  apply_specs "_plugins/_alerting/monitors" "$PROG_FILE.alerting" "монитор"
}

apply_anomaly() {
  step "Anomaly Detection: ML-детекторы"
  if ! es GET '/_plugins/_anomaly_detection/detectors?size=1' | grep -q '"hits"'; then
    warn "плагин anomaly-detection недоступен — пропускаю"; return 0
  fi
  anomaly_specs_py "$(cat "$PROG_FILE.fieldsjson")" > "$PROG_FILE.anomaly"
  apply_specs "_plugins/_anomaly_detection/detectors" "$PROG_FILE.anomaly" "детектор AD"
  # запуск детекторов (если созданы/обновлены)
  if [ "$DRY" -ne 1 ]; then
    es GET '/_plugins/_anomaly_detection/detectors?size=50' | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
for h in ((d.get("hits") or {}).get("hits") or []):
    n=(h.get("_source") or {}).get("name","")
    if n.startswith("NDR"): print(h.get("_id",""))
' 2>/dev/null | while read -r id; do
      [ -n "$id" ] || continue
      st="$(es POST "/_plugins/_anomaly_detection/detectors/$id/_start" )"
      case "$st" in *'"invalid_detector_state"'*|*already*) ok "детектор уже запущен (id=$id)";; *) ok "детектор запущен (id=$id)";; esac
    done
    msg "  первые аномалии появятся через ~2 детекционных интервала (10–15 мин), см. OSD → Anomaly Detection → Detector results"
  fi
}

apply_security() {
  step "Security Analytics: детектор network"
  if ! es GET '/_plugins/_security_analytics/detectors' | grep -q '\[' ; then
    warn "плагин security-analytics недоступен — пропускаю"; return 0
  fi
  security_py "$(cat "$PROG_FILE.fieldsjson")" > "$PROG_FILE.security"
  # 1) маппинг EVE→ECS + 2) детектор (первая колонка — маркер mappings|detector)
  while IFS=$'\t' read -r kind body; do
    [ -n "${body:-}" ] || continue
    case "$kind" in
      mappings)
        if [ "$DRY" -eq 1 ]; then msg "  dry-run: маппинг полей network был бы создан"; continue; fi
        es POST '/_plugins/_security_analytics/mappings' "$body" >/dev/null 2>&1 \
          && ok "маппинг EVE→ECS (network) записан" || warn "маппинг не записан (версия плагина не поддерживает API — не критично)"
        ;;
      detector)
        if [ "$DRY" -eq 1 ]; then msg "  dry-run: детектор network был бы создан"; continue; fi
        existing="$(es GET '/_plugins/_security_analytics/detectors/_search?size=100')"
        id="$(printf '%s' "$existing" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
for h in ((d.get("hits") or {}).get("hits") or []):
    s=h.get("_source") or {}
    if (s.get("name") or "").startswith("NDR"): print(h.get("_id","")); break
' 2>/dev/null)"
        if [ -n "$id" ]; then
          es PUT "/_plugins/_security_analytics/detectors/$id" "$body" >/dev/null 2>&1 && ok "детектор SA обновлён (id=$id)" || warn "детектор SA не обновлён"
        else
          id="$(es POST '/_plugins/_security_analytics/detectors' "$body" | es_jq_get "str(d.get('_id',''))")"
          [ -n "$id" ] && ok "детектор SA создан (id=$id), встроенные Sigma-правила network подключены автоматически" || warn "детектор SA не создан"
        fi
        ;;
    esac
  done < "$PROG_FILE.security"
}

# ── main ─────────────────────────────────────────────────────────────────────
SUF=""; [ "$DRY" -eq 1 ] && SUF=" (dry-run)"
msg "$SELF — режим: $MODE$SUF"

case "$MODE" in
  status)
    detect_es || exit 1
    do_status
    ;;
  remove)
    [ "$YES" -eq 1 ] || [ -t 0 ] || { err "нужен --yes для неинтерактивного удаления"; exit 1; }
    if [ "$YES" -ne 1 ] && [ -t 0 ]; then
      printf 'Удалить ВСЕ объекты с префиксом «NDR ·» (мониторы/детекторы)? [y/N] '
      read -r a; case "$a" in y*|Y*) ;; *) msg "Отменено"; exit 0;; esac
    fi
    detect_es || exit 1
    remove_managed
    ;;
  *)
    # режимы применения
    detect_es || exit 1
    gather_fields || exit 1
    case "$MODE" in
      alerting)  apply_alerting ;;
      anomaly)   apply_anomaly ;;
      security)  apply_security ;;
      all)       apply_alerting; apply_anomaly; apply_security ;;
    esac
    step "Готово"
    msg "Проверить: OpenSearch Dashboards → Alerting / Anomaly Detection / Security Analytics."
    msg "Объекты создаются с префиксом «NDR ·» — их видно среди прочих, удаление: $SELF --remove-managed"
    ;;
esac
exit 0
