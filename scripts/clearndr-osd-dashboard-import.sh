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
# перед записью скрипт определяет фактические имена полей по _field_caps
# (EVE raw или ECS-маппинг), находит/создаёт index-pattern logstash-* и
# вырезает визуализации по отсутствующим в кластере полям (с WARN).
#
# Использование:
#   clearndr-osd-dashboard-import.sh --list
#   clearndr-osd-dashboard-import.sh --pack traffic --pack alerts [--yes] [--dry-run]
#   clearndr-osd-dashboard-import.sh --pack all [--yes]
#   clearndr-osd-dashboard-import.sh --remove traffic | --remove all [--yes]
# Опции: --es-url URL (иначе автоопределение: https/http на 127.0.0.1,
# 172.17.0.1, host.docker.internal, затем docker exec), --seed SEED,
# --instance-dir DIR, --no-color.
# Коды выхода: 0 — успех, 1 — ошибка среды, 2 — не найден пакет.
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
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) err "Неизвестный аргумент: $1"; exit 1;;
  esac
  shift
done

TS="$(date +%Y%m%d-%H%M%S)"
PROG_FILE="/tmp/ndr-osd-import.progress"
BACKUP_ROOT="$INSTANCE_DIR/backups/osd-import-$TS"
BACKUP_DIR=""

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
detect_fields() { # «KEY<TAB>поле<TAB>тип»
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
have = {n: ",".join(sorted(s.keys())) for n, s in fc.items()}
for key, fields in cands.items():
    for f in fields:
        if f in have:
            print("%s\t%s\t%s" % (key, f, have[f]))
            break
PYFC
}

# ── index-pattern ────────────────────────────────────────────────────────────
resolve_index_pattern() { # печатает id В STDOUT (остальные сообщения — в stderr)
  local ts_field
  local -i quiet=0
  # все сообщения функции уходят в stderr, чтобы не загрязнять stdout-захват
  ts_field="$(awk -F'\t' '$1=="ts"{print $2; exit}' "$1")"
  ts_field="${ts_field:-timestamp}"
  local hit
  hit="$(es GET '/.kibana/_search?q=type:index-pattern&size=50')"
  ip="$(printf '%s' "$hit" | python3 -c '
import json,sys,re
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
for h in ((d.get("hits") or {}).get("hits") or []):
    s=h.get("_source") or {}
    ip=s.get("index-pattern") or {}
    t=str(ip.get("title",""))
    if re.match(r"^logstash", t): print(h.get("_id","").split(":",1)[-1] or h.get("_id","")); break
' 2>/dev/null)"
  if [ -n "${ip:-}" ]; then
    ok "index-pattern найден: $ip" >&2
    printf '%s' "$ip"; return 0
  fi
  ip="ndr-logstash-pattern"
  if [ "$DRY" -eq 1 ]; then
    msg "  dry-run: index-pattern «ndr-logstash-pattern» (logstash-*, time=$ts_field) был бы создан" >&2
    printf '%s' "$ip"; return 0
  fi
  resp="$(es POST "/.kibana/_doc/index-pattern:$ip" "$(python3 -c "
import json,sys
print(json.dumps({'index-pattern':{'title':'logstash-*','timeFieldName':sys.argv[1]}}))" "$ts_field")")"
  id="$(printf '%s' "$resp" | es_jq_get "str(d.get('_id','').split(':',1)[-1])")"
  if [ -n "$id" ]; then
    ok "index-pattern создан: $id (logstash-*, time=$ts_field)" >&2
    printf '%s' "$ip"; return 0
  fi
  err "не удалось создать index-pattern"; return 1
}

# ── рендер пакета: подстановка полей, вырезание отсутствующих визов ──────────
render_pack() { # $1=pack-file $2=index-pattern-id $3=fields-file; NDJSON на stdout
  python3 - "$1" "$2" "$3" <<'PYRENDER'
import json, sys, re
pack_path, ip_id, fields_file = sys.argv[1], sys.argv[2], sys.argv[3]
fields = {}
for line in open(fields_file, encoding="utf-8"):
    parts = line.rstrip("\n").split("\t")
    if len(parts) == 3:
        fields[parts[0]] = parts[1]
pack = json.load(open(pack_path, encoding="utf-8"))

def subst(s):
    s = s.replace("__IP__", ip_id)
    if s == "__TS__":
        return fields.get("ts", "timestamp")
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
    out.append(json.dumps({"index": doc}, ensure_ascii=False))
    out.append(json.dumps({"type": o["type"], "id": o["id"], "version": 1,
                           "attributes": attrs["attributes"],
                           "references": attrs.get("references", [])}, ensure_ascii=False))
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
  step "Определение полей событий"
  detect_fields > "$PROG_FILE.fields" || true
  local nf; nf="$(wc -l < "$PROG_FILE.fields" | tr -d ' ')"
  [ "$nf" -gt 0 ] || { err "поля не определены — есть ли данные logstash-*?"; return 1; }
  ok "определено полей: $nf"

  step "Index-pattern"
  local ip; ip="$(resolve_index_pattern "$PROG_FILE.fields")" || return 1

  local created=0 updated=0 failed=0 p
  for p in "${PACKS[@]}"; do
    local f="$PACKS_DIR/$p.json"
    [ -f "$f" ] || { err "файл пакета не найден: $f"; return 2; }
    step "Импорт пакета: $p"
    render_pack "$f" "$ip" "$PROG_FILE.fields" > "$PROG_FILE.bulk"
    local info; info="$(tail -1 "$PROG_FILE.bulk" 2>/dev/null)"
    # render_pack печатает метаданные в stderr — перечитаем их из stderr нельзя,
    # поэтому просто считаем строки NDJSON
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
    resp="$(es POST '/_bulk?refresh=false' "$(cat "$PROG_FILE.bulk")")"
    rc="$(printf '%s' "$resp" | es_jq_get "str(d.get('errors'))")"
    if [ "$rc" = "False" ]; then
      ok "пакет $p импортирован: $((lines / 2)) объектов"
      created=$((created + lines / 2))
    else
      local errs; errs="$(printf '%s' "$resp" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("ответ не разобран"); raise SystemExit
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
    msg "Откройте OpenSearch Dashboards → Dashboards — дашборды «NDR · …» появятся в списке."
  fi
  [ "$failed" -eq 0 ]
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
esac
