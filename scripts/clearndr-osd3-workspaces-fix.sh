#!/usr/bin/env bash
#=============================================================================
# clearndr-osd3-workspaces-fix.sh  (v2)
#
# Проблема: OpenSearch Dashboards 3.x показывает «Welcome to OpenSearch /
# My workspaces» и не видит дашборды/индекс-паттерны, залитые scirius
# (kibana_reset) напрямую в .kibana. Это известное поведение
# (opensearch-project/OpenSearch-Dashboards#10890): в OSD 3.x включён режим
# workspaces, объекты без привязки к workspace не отображаются.
#
# Фикс: workspace.enabled: false в opensearch_dashboards.yml.
#   - Основной путь: файл конфига примонтирован с хоста -> переписываем его
#     (тот же inode) и делаем docker restart контейнера. Без пересоздания.
#   - Запасной путь (если источник монтирования отсутствует на хосте):
#     пересоздание ТОЛЬКО контейнера dashboards из docker inspect (с откатом).
#
# OpenSearch (данные), fluentd, scirius не затрагиваются.
#
# Использование:
#   sudo bash clearndr-osd3-workspaces-fix.sh          # диагностика
#   sudo bash clearndr-osd3-workspaces-fix.sh --fix    # применить фикс
#=============================================================================
set -u

MODE="check"; [ "${1:-}" = "--fix" ] && MODE="fix"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/opt/ClearNDR/backups/osd-workspaces-fix-$TS"
YML_IN="/usr/share/opensearch-dashboards/config/opensearch_dashboards.yml"

ok(){ echo "[ OK ] $*"; }; warn(){ echo "[WARN] $*"; }; fail(){ echo "[FAIL] $*"; }; info(){ echo "[INFO] $*"; }
die(){ fail "$*"; exit 1; }

command -v docker >/dev/null || die "docker не найден"
command -v python3 >/dev/null || die "python3 не найден"

CONTAINER="${OSD_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -i 'opensearch-dashboards' | head -n1)}"
[ -n "$CONTAINER" ] || die "Контейнер opensearch-dashboards не найден"
OS="${OPENSEARCH_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -i 'opensearch' | grep -vi 'dashboards' | head -n1)}"

# --- helpers -----------------------------------------------------------------

# Читает текущий конфиг из контейнера (виден через bind-монтирование)
read_cfg(){ docker exec "$CONTAINER" cat "$YML_IN" 2>/dev/null || true; }

# Статус workspaces по конфигу (авторитетный источник)
ws_status(){
  local CFG; CFG="$(read_cfg)"
  if printf '%s\n' "$CFG" | grep -qE '^[[:space:]]*workspace\.enabled[[:space:]]*:[[:space:]]*true';  then echo on
  elif printf '%s\n' "$CFG" | grep -qE '^[[:space:]]*workspace\.enabled[[:space:]]*:[[:space:]]*false'; then echo off
  else echo unknown; fi
}

# Готовит новый конфиг: сохраняет содержимое, убирает workspace.enabled, добавляет false
make_new_yml(){ # $1 = текущее содержимое (может быть пустым)
  python3 - "$1" <<'PYMK'
import sys
cur = sys.argv[1] if len(sys.argv) > 1 else ""
out = [l for l in cur.splitlines() if not l.lstrip().startswith("workspace.")]
def has(p): return any(l.strip().startswith(p) for l in out)
if not out:
    out = ["server.host: 0.0.0.0", "opensearch.hosts: http://opensearch:9200"]
else:
    if not has("opensearch.hosts:"): out.append("opensearch.hosts: http://opensearch:9200")
    if not has("server.host:"):      out.append("server.host: 0.0.0.0")
out += ["", "# OSD 3.x: при включённых workspaces объекты, залитые kibana_reset (scirius)",
        "# напрямую в .kibana, не видны в UI — opensearch-project/OpenSearch-Dashboards#10890",
        "workspace.enabled: false"]
print("\n".join(out))
PYMK
}

# Ждёт health контейнера; 0 = healthy
wait_healthy(){
  local c="$1" i
  for i in $(seq 1 36); do
    sleep 5
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = "healthy" ] && return 0
  done
  return 1
}

# Путь на хосте, откуда примонтирован конфиг (пусто — если монтирования нет)
mount_src(){
  python3 - "$1" <<'PYMS'
import json,sys
d=json.load(open(sys.argv[1]))
for m in d[0].get("Mounts",[]):
    if m.get("Destination")=="/usr/share/opensearch-dashboards/config/opensearch_dashboards.yml":
        print(m.get("Source","")); break
PYMS
}

# --- диагностика -------------------------------------------------------------

info "Контейнер Dashboards: $CONTAINER (образ: $(docker inspect -f '{{.Config.Image}}' "$CONTAINER"))"
OSD_VER=$(docker exec "$CONTAINER" curl -s localhost:5601/api/stats 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("info",{}).get("version","?"))
except Exception: print("?")' 2>/dev/null || echo "?")
info "Версия OpenSearch Dashboards: $OSD_VER"

CONFIG_NOW="$(read_cfg)"
if [ -n "$CONFIG_NOW" ]; then
  info "Текущий opensearch_dashboards.yml (виден в контейнере):"
  echo "-----8<-----"; echo "$CONFIG_NOW"; echo "----->8-----"
else
  warn "Конфиг в контейнере не читается (точка монтирования — пустой каталог?)"
fi

case "$(ws_status)" in
  on)      fail "Workspaces ВКЛЮЧЕНЫ (workspace.enabled: true) — именно поэтому интерфейс «пустой» при живых данных";;
  off)     ok "Workspaces отключены (workspace.enabled: false)";;
  unknown) warn "workspace.enabled в конфиге не найден — в OSD 3.x по умолчанию ВКЛЮЧЕНЫ";;
esac

if [ "$MODE" = "check" ]; then
  echo
  info "Диагностика завершена. Для фикса: sudo bash $0 --fix"
  exit 0
fi

# --- фикс --------------------------------------------------------------------

echo
warn "Будет изменён конфиг Dashboards (workspace.enabled: false) и перезапущен ТОЛЬКО"
warn "контейнер $CONTAINER. OpenSearch (данные), fluentd, scirius не трогаются."
warn "Простой UI ~1-2 минуты."
printf 'Продолжить? [y/N] '; read -r A
case "$A" in y|Y|yes|да|Да) ;; *) info "Отменено"; exit 0;; esac

mkdir -p "$BACKUP_DIR"
docker inspect "$CONTAINER" > "$BACKUP_DIR/inspect.json"

SRC="$(mount_src "$BACKUP_DIR/inspect.json")"
NEW_YML="$BACKUP_DIR/opensearch_dashboards.new.yml"
make_new_yml "$CONFIG_NOW" > "$NEW_YML"
info "Новый конфиг подготовлен:"
echo "-----8<-----"; cat "$NEW_YML"; echo "----->8-----"

# ============ ПУТЬ 1: конфиг существует на хосте (bind живой) ================
if [ -n "$SRC" ] && [ -f "$SRC" ]; then
  info "Источник монтирования: $SRC — перезаписываю файл и перезапускаю контейнер"
  cp "$SRC" "$BACKUP_DIR/opensearch_dashboards.old.yml"
  cp "$NEW_YML" "$SRC"   # тот же inode — содержимое видно контейнеру

  docker restart "$CONTAINER" >/dev/null
  info "Контейнер перезапущен, жду health (до 180с)..."
  if wait_healthy "$CONTAINER"; then
    ok "Dashboards healthy"
  else
    fail "Контейнер не стал healthy за 180с — откатываю конфиг"
    docker logs --tail 40 "$CONTAINER" > "$BACKUP_DIR/failed-container.log" 2>&1 || true
    cp "$BACKUP_DIR/opensearch_dashboards.old.yml" "$SRC"
    docker restart "$CONTAINER" >/dev/null
    wait_healthy "$CONTAINER" && ok "Откат выполнен, старый конфиг восстановлен" \
      || warn "Откат выполнен, но healthcheck ещё зелёный не стал (проверьте: docker logs $CONTAINER)"
    die "Фикс не применился, конфиг возвращён. Логи: $BACKUP_DIR/failed-container.log"
  fi

# ============ ПУТЬ 2: источника монтирования нет — пересоздание ==============
else
  [ -n "$SRC" ] && warn "Источник монтирования — каталог/отсутствует: $SRC (см. $BACKUP_DIR/inspect.json)" \
                || warn "Конфиг не примонтирован с хоста — контейнер использует образ по умолчанию"
  warn "Путь 2: пересоздание контейнера $CONTAINER из docker inspect (с автопрокатом)"

  # Если источник был каталогом — разберём его, чтобы примонтировать файл
  BIND="$NEW_YML:$YML_IN"
  if [ -n "$SRC" ] && [ -d "$SRC" ]; then
    rmdir "$SRC" 2>/dev/null || { mv "$SRC" "$SRC.old-$TS"; warn "Каталог $SRC перенесён в $SRC.old-$TS"; }
    mkdir -p "$(dirname "$SRC")" && cp "$NEW_YML" "$SRC" && BIND="$SRC:$YML_IN" && info "Конфиг записан: $SRC"
  fi

  ARGFILE="$BACKUP_DIR/run.args"
  python3 - "$BACKUP_DIR/inspect.json" "$BIND" > "$ARGFILE" <<'PYARGS'
import json,sys
d=json.load(open(sys.argv[1]))[0]
extra=[b for b in sys.argv[2:] if b]
c=d.get("Config",{}); h=d.get("HostConfig",{}); n=d.get("NetworkSettings",{})
out=[]; A=out.append
name=d.get("Name","").lstrip("/")
if not name: raise SystemExit("BUG: пустое имя контейнера в inspect.json")
A("--name"); A(name)
rp=(h.get("RestartPolicy") or {}).get("Name","")
if rp: A("--restart"); A(rp)
for net_name,nc in (n.get("Networks") or {}).items():
    A("--network"); A(net_name)
    for al in (nc.get("Aliases") or []):
        if al: A("--network-alias"); A(al)
    break
for pname,b in (n.get("Ports") or {}).items():
    for e in (b or []):
        if e.get("HostPort"):
            pref=(e.get("HostIp") or "").strip()
            pref=pref+":" if pref else ""
            A("--publish"); A(pref+e["HostPort"]+":"+pname)
hc=c.get("Healthcheck") or {}; t=hc.get("Test") or []
if len(t)>=2 and t[0]=="CMD-SHELL":
    A("--health-cmd"); A(t[1])
    if hc.get("Interval"):    A("--health-interval");     A("%gs"%(hc["Interval"]/1e9))
    if hc.get("Timeout"):     A("--health-timeout");      A("%gs"%(hc["Timeout"]/1e9))
    if hc.get("Retries"):     A("--health-retries");      A(str(hc["Retries"]))
    if hc.get("StartPeriod"): A("--health-start-period"); A("%gs"%(hc["StartPeriod"]/1e9))
for e in (c.get("Env") or []): A("--env"); A(e)
for k,v in (c.get("Labels") or {}).items(): A("--label"); A(k+"="+v)
if c.get("User"): A("--user"); A(c["User"])
if c.get("WorkingDir"): A("--workdir"); A(c["WorkingDir"])
for eh in (h.get("ExtraHosts") or []): A("--add-host"); A(eh)
for m in (d.get("Mounts") or []):
    if m.get("Destination")=="/usr/share/opensearch-dashboards/config/opensearch_dashboards.yml":
        continue
    if m.get("Type")=="volume":
        A("--volume"); A(m.get("Name","")+":"+m.get("Destination",""))
    elif m.get("Source"):
        A("--volume"); A(m["Source"]+":"+m.get("Destination","")+(":ro" if m.get("RW") is False else ""))
for b in extra: A("--volume"); A(b)
A(c.get("Image",""))
if any(x=="" for x in out): raise SystemExit("BUG: пустой аргумент в списке")
print("\n".join(out))
PYARGS
  [ $? -eq 0 ] || die "Не удалось собрать аргументы запуска (см. выше)"

  mapfile -t RUN_ARGS < "$ARGFILE"
  BAK="${CONTAINER}-bak-$TS"
  docker stop -t 30 "$CONTAINER" >/dev/null && docker rename "$CONTAINER" "$BAK"
  if ! docker create "${RUN_ARGS[@]}" > "$BACKUP_DIR/new.cid" 2> "$BACKUP_DIR/create.err"; then
    fail "docker create:"; cat "$BACKUP_DIR/create.err"
    docker rename "$BAK" "$CONTAINER"; docker start "$CONTAINER" >/dev/null
    die "Откат: старый контейнер снова работает"
  fi
  NEWC=$(cat "$BACKUP_DIR/new.cid")
  if ! docker start "$NEWC" >/dev/null 2> "$BACKUP_DIR/start.err"; then
    fail "docker start:"; cat "$BACKUP_DIR/start.err"
    docker rm -f "$NEWC" 2>/dev/null; docker rename "$BAK" "$CONTAINER"; docker start "$CONTAINER" >/dev/null
    die "Откат выполнен"
  fi
  info "Новый контейнер запущен, жду health (до 180с)..."
  if ! wait_healthy "$CONTAINER"; then
    docker logs --tail 40 "$CONTAINER" > "$BACKUP_DIR/new-container.log" 2>&1 || true
    fail "Не healthy за 180с — откат. Логи: $BACKUP_DIR/new-container.log"
    docker rm -f "$CONTAINER" 2>/dev/null; docker rename "$BAK" "$CONTAINER"; docker start "$CONTAINER" >/dev/null
    die "Откат выполнен"
  fi
  ok "Dashboards healthy"
fi

# --- проверка результата ------------------------------------------------------

case "$(ws_status)" in
  off) ok "Workspaces отключены (workspace.enabled: false)" ;;
  on)  fail "workspace.enabled всё ещё true — конфиг не применился" ;;
  *)   warn "workspace.enabled не найден в конфиге" ;;
esac

if [ -n "$OS" ]; then
  IP=$(docker exec "$OS" curl -s 'localhost:9200/.kibana/_search?size=1&_source=false' \
        -H 'Content-Type: application/json' -d '{"query":{"term":{"type":"index-pattern"}}}' 2>/dev/null \
      | python3 -c 'import json,sys
try:
    h=json.load(sys.stdin)["hits"]["hits"]; print(h[0]["_id"].split(":",1)[-1] if h else "")
except Exception: print("")' 2>/dev/null || true)
  if [ -n "$IP" ]; then
    docker exec "$CONTAINER" curl -s -X POST localhost:5601/api/opensearch-dashboards/settings \
      -H 'osd-xsrf: true' -H 'Content-Type: application/json' \
      -d "{\"changes\":{\"defaultIndex\":\"$IP\"}}" >/dev/null \
      && ok "Индекс-паттерн по умолчанию (defaultIndex): $IP"
  else
    warn "Индекс-паттерн в .kibana не найден — запустите clearndr-events-restore.sh --fix"
  fi
fi

DB=$(docker exec "$CONTAINER" curl -s 'localhost:5601/api/saved_objects/_find?type=dashboard&per_page=1' 2>/dev/null \
     | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("total",0))
except Exception: print("?")' 2>/dev/null || echo "?")
case "$DB" in ?|0) warn "Дашбордов через API: $DB";; *) ok "Дашбордов доступно через API: $DB";; esac

echo
ok "Готово. Откройте Dashboards и сделайте жёсткое обновление страницы (Ctrl+F5)."
info "Теперь должна открыться классическая главная; в Discover — индекс-паттерн logstash-*."
[ -n "${BAK:-}" ] && info "Бэкап старого контейнера: $BAK (можно удалить: docker rm $BAK)"
info "Резервные файлы: $BACKUP_DIR"
