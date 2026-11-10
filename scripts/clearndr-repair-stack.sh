#!/usr/bin/env bash
# ============================================================================
# clearndr-repair-stack.sh — автономное восстановление повреждённого config/
# инстанса Clear NDR (stamusctl), включая events-stack.
#
# Инцидент 09.11.2026: после сбойного обновления в каталоге инстанса пропал
# config/docker-compose.yaml, а ручное восстановление из шаблона 3.3.x упиралось
# в «refers to undefined network network» (в шаблонах stamusctl-templates 3.3.x
# секция networks не определена). Пустой OpenSearch Dashboards — отдельная
# проблема, для неё см. clearndr-events-restore.sh.
#
# ВАЖНО про запуск контейнеров: контейнеры с restart: unless-stopped поднимаются
# демоном docker ПРИ ПЕРЕЗАГРУЗКЕ ХОСТА БЕЗ compose-файла (он нужен только
# stamusctl/docker compose — для down/up/update). Поэтому «контейнеры работают»
# не означает, что config/ цел.
#
# ВАЖНО про stamusctl: -c/--config (по умолчанию «config») резолвится
# ОТНОСИТЕЛЬНО ТЕКУЩЕГО КАТАЛОГА. Инстанс events-stack — отдельный каталог:
#   cd /opt/ClearNDR/config/events-stack/opensearch_dashboards && stamusctl compose ps
# Запуск из другого каталога даёт «stat …/config/docker-compose.yaml:
# no such file or directory, Code: 14». Этот скрипт кладёт файлы на место —
# после него stamusctl снова работает из родительского каталога config/.
#
# Что делает скрипт:
#   1. Находит инстансы без compose-файла (скан /opt/ClearNDR либо --instance-dir);
#      каталог config/ может отсутствовать ЦЕЛИКОМ — скрипт создаст его
#      (контейнеры при этом продолжают работать: их поднимает docker-демон);
#   2. Восстанавливает недостающие файлы config/ без перезаписи существующих
#      из лучшего источника:
#        a) config.failed-*/config/           (сохранённые повреждённые конфиги)
#        b) архивы config-*.tar.gz            (с проверкой наличия compose-файла;
#            для вложенных инстансов, например events-stack/*, берётся ТОЛЬКО
#            поддерево этого инстанса, префикс «config/…» снимается — файлы
#            ложатся в <инстанс>/config/, а не внутрь вложенного каталога)
#        c) созданный вручную config/config/docker-compose.yaml — заодно
#           уводится в карантин config.quarantine-<метка времени>/
#        d) РЕКОНСТРУКЦИЯ из работающих контейнеров (events-stack): контейнеры
#           с restart: unless-stopped несут фактическую конфигурацию (образы,
#           env, монтирования, порты, healthcheck, сеть) — compose собирается
#           из docker inspect; конфиг-файлы под инстансом, отсутствующие на
#           хосте, восстанавливаются содержимым из контейнера
#   3. Секция networks (external на фактическую docker-сеть стека, найденную
#      по seed-суффиксу контейнеров) — фикс «Code: 15»; при реконструкции
#      секция формируется сразу;
#   4. Проверяет проект «docker compose config»;
#   5. По флагу поднимает стек и ждёт health-check opensearch с разбором
#      журнала при сбое.
#
# Существующие файлы НЕ перезаписываются.
#
# Примеры:
#   sudo ./clearndr-repair-stack.sh
#   sudo ./clearndr-repair-stack.sh --instance-dir /opt/ClearNDR/config/events-stack/opensearch_dashboards
#   sudo ./clearndr-repair-stack.sh --dry-run
#   sudo ./clearndr-repair-stack.sh --no-up
#
# Коды выхода: 0 — всё в порядке (или чинить нечего); 1 — остался неремонтируемый
# инстанс / ошибка.
# ============================================================================

set -Eeuo pipefail
umask 077

INSTANCE_DIR_OPT=""   # --instance-dir
SCAN_ROOT="/opt/ClearNDR"
DRY_RUN=0
NO_UP=0
ASSUME_YES=0
HEALTH_TIMEOUT=300
NO_COLOR=0

C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
if [ -t 1 ] && [ "${NO_COLOR}" -eq 0 ]; then
  C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
fi
msg_info() { printf "${C_INFO}[INFO]${C_OFF} %s\n" "$*"; }
msg_ok()   { printf "${C_OK}[ OK ]${C_OFF} %s\n" "$*"; }
msg_warn() { printf "${C_WARN}[WARN]${C_OFF} %s\n" "$*"; }
msg_err()  { printf "${C_ERR}[FAIL]${C_OFF} %s\n" "$*" >&2; }
step()     { printf "\n${C_INFO}==>${C_OFF} %s\n" "$*"; }

TS="$(date +%Y%m%d-%H%M%S)"
FAILED=0          # количество инстансов, которые починить не удалось
FIXED=0           # количество успешно починенных инстансов
EXPLICIT=0        # 1 — инстанс задан явно через --instance-dir

usage() { awk 'NR>1 && !/^#/ {exit} NR>1 {sub(/^# ?/, ""); print}' "$0"; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --instance-dir)  INSTANCE_DIR_OPT="${2:?--instance-dir: укажите каталог}"; shift 2 ;;
      --scan-root)     SCAN_ROOT="${2:?--scan-root: укажите каталог}"; shift 2 ;;
      --dry-run)       DRY_RUN=1; shift ;;
      --no-up)         NO_UP=1; shift ;;
      --yes|-y)        ASSUME_YES=1; shift ;;
      --health-timeout) HEALTH_TIMEOUT="${2:?--health-timeout: укажите секунды}"; shift 2 ;;
      --no-color)      NO_COLOR=1; C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""; shift ;;
      --help|-h)       usage; exit 0 ;;
      *)               msg_err "Неизвестный аргумент: $1"; echo; usage; exit 1 ;;
    esac
  done
}

# ----------------------------- docker-помощники ------------------------------
have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

compose_file_name() {  # $1 — config dir; печатает имя compose-файла (docker-compose.yaml|yml либо compose.yaml|yml — Compose Spec v2) либо rc=1
  local d="$1"
  if [ -f "$d/docker-compose.yaml" ]; then echo docker-compose.yaml
  elif [ -f "$d/docker-compose.yml" ]; then echo docker-compose.yml
  elif [ -f "$d/compose.yaml" ]; then echo compose.yaml
  elif [ -f "$d/compose.yml" ]; then echo compose.yml
  else return 1; fi
}

# seed-суффикс установки: имена контейнеров/томов вида <base>-<service>-<seed>
detect_seed() {
  local ct
  ct="$(docker ps -a --format '{{.Names}}' 2>/dev/null \
        | grep -E -- '-(scirius|db|suricata|nginx|opensearch|fluentd|osd|evebox|arkime|utils|rabbitmq|celery|cron|scout|ssl-keygen|setup-|suri-reloader|ownership|socat)-[A-Za-z0-9_]+$' \
        | head -1 || true)"
  printf '%s' "${ct##*-}"
}

# фактическая docker-сеть стека (для external-определения в compose)
detect_network_name() {
  local seed ct nets n
  seed="$(detect_seed)"
  if [ -n "$seed" ]; then
    ct="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -- "$seed" | head -1 || true)"
    if [ -n "$ct" ]; then
      nets="$(docker inspect "$ct" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || true)"
      [ -n "$nets" ] && { echo "$nets" | awk '{print $1}'; return 0; }
    fi
    n="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -- "$seed" | head -1 || true)"
    [ -n "$n" ] && { echo "$n"; return 0; }
  fi
  return 1
}

validate_compose_project() {  # $1 — config dir; 0 — валиден; 1 — печатает ошибку
  local d="$1" f err
  f="$(compose_file_name "$d")" || { echo "compose-файл отсутствует в $d"; return 1; }
  docker compose version >/dev/null 2>&1 || return 0
  if err="$(docker compose --project-directory "$d" -f "$d/$f" config -q 2>&1)"; then
    return 0
  fi
  echo "${err:-docker compose config завершился ошибкой}"
  return 1
}

append_network_definition() {  # $1 — config dir; $2 — логическое имя сети
  local d="$1" net="$2" f actual
  f="$(compose_file_name "$d")" || return 1
  actual="$(detect_network_name || true)"
  {
    echo ''
    echo '# Секция добавлена clearndr-repair-stack.sh: шаблон ссылается на сеть, не определяя её'
    echo 'networks:'
    echo "  $net:"
    if [ -n "${actual:-}" ]; then
      echo "    name: $actual"
      echo '    external: true'
    fi
  } >> "$d/$f"
  if [ -n "${actual:-}" ]; then
    msg_ok "В $f добавлена сеть «$net» → существующая docker-сеть «$actual» (external)"
  else
    msg_warn "В $f добавлена сеть «$net» (compose создаст сеть проекта — фактическую определить не удалось)"
  fi
  return 0
}

# Проверка с автопатчем неопределённых сетей. 0 — ок; 1 — не удалось.
ensure_compose_networks() {
  local d="$1" err net tries=0 appended=" "
  while true; do
    if err="$(validate_compose_project "$d")"; then return 0; fi
    net="$(printf '%s' "$err" | sed -n 's/.*refers to undefined network \([^:]*\).*/\1/p' | head -1 | xargs || true)"
    if [ -z "$net" ] || [ "$tries" -ge 3 ] || [[ "$appended" == *" $net "* ]]; then
      printf '%s' "$err"
      return 1
    fi
    if grep -Eq '^networks:' "$d/$(compose_file_name "$d")" 2>/dev/null; then
      printf 'сеть «%s» не определена, но секция networks: в файле уже есть — добавьте сеть в неё вручную\n' "$net"
      return 1
    fi
    tries=$((tries + 1)); appended="$appended$net "
    append_network_definition "$d" "$net" || { printf 'не удалось дописать секцию networks\n'; return 1; }
  done
}

# config-файлы, на которые ссылается compose (configs: file: …) — должны существовать
missing_referenced_files() {  # $1 — config dir; печатает относительные пути
  local d="$1" f line ref
  f="$(compose_file_name "$d")" || return 0
  while IFS= read -r line; do
    ref="$(printf '%s' "$line" | sed -n 's/.*file:[[:space:]]*\([^[:space:]#]*\).*/\1/p')"
    [ -n "$ref" ] || continue
    case "$ref" in /*) continue ;; esac
    [ -e "$d/$ref" ] || printf '%s\n' "$ref"
  done < <(grep -E 'file:' "$d/$f" 2>/dev/null || true)
  return 0
}

# ----------------------------- источники восстановления ----------------------
# a) config.failed-*/config/   b) архивы config-*.tar.gz   c) ручной config/config
find_good_config_source() {  # $1 — instance dir; $2 — config dir; печатает источник
  local inst="$1" cfg="$2" cand f
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    for f in docker-compose.yaml docker-compose.yml compose.yaml compose.yml; do
      [ -f "$cand/config/$f" ] && { echo "$cand/config/$f"; return 0; }
    done
  done < <(ls -1dt "$inst"/config.failed-*/ 2>/dev/null || true)
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    if [ -s "$cand" ] && [ -n "$(archive_member_for "$inst" "$cand")" ]; then
      echo "$cand"; return 0
    fi
  done < <(ls -1t "$inst"/backups/config-*.tar.gz \
             "$inst"/../backups/config-*.tar.gz \
             "$inst"/../../backups/config-*.tar.gz \
             "$inst"/../../../backups/config-*.tar.gz 2>/dev/null \
           | awk '!seen[$0]++' || true)
  # созданный вручную файл НЕ В ТОМ каталоге (config/config/…)
  for f in docker-compose.yaml docker-compose.yml compose.yaml compose.yml; do
    [ -f "$cfg/config/$f" ] && { echo "$cfg/config/$f"; return 0; }
  done
  return 1
}

# Источник конкретных недостающих файлов (compose в источнике не обязателен):
# a) config.failed-*/config/, б) архивы config-*.tar.gz, в) ручной config/config
find_source_for_files() {  # $1 — instance dir; $2 — config dir; $3 — недостающие пути (\n-разделённые)
  local inst="$1" cfg="$2" miss="$3" cand f found
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    found=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if [ -e "$cand/config/$f" ]; then found=1; break; fi
    done <<< "$miss"
    [ "$found" -eq 1 ] && { echo "$cand/config"; return 0; }
  done < <(ls -1dt "$inst"/config.failed-*/ 2>/dev/null || true)
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if tar tzf "$cand" 2>/dev/null | grep -qF -- "$f"; then echo "$cand"; return 0; fi
    done <<< "$miss"
  done < <(ls -1t "$inst"/backups/config-*.tar.gz \
             "$inst"/../backups/config-*.tar.gz \
             "$inst"/../../backups/config-*.tar.gz \
             "$inst"/../../../backups/config-*.tar.gz 2>/dev/null \
           | awk '!seen[$0]++' || true)
  if [ -d "$cfg/config" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && [ -e "$cfg/config/$f" ] && { echo "$cfg/config"; return 0; }
    done <<< "$miss"
  fi
  return 1
}

quarantine_manual_dir() {  # $1 — instance dir; $2 — config dir (содержит config/); печатает каталог карантина
  local inst="$1" cfg="$2" dest="$inst/config.quarantine-$TS"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: $cfg/config был бы перемещён в $dest"
    echo "$dest"
    return 0
  fi
  mkdir -p "$dest"
  mv "$cfg/config" "$dest/" 2>/dev/null || { echo "$dest"; return 1; }
  msg_warn "Ручной каталог config/config перемещён в карантин: $dest" >&2
  echo "$dest"
  return 0
}

restore_missing_from_archive() {  # $1 — instance dir; $2 — архив; rc: 0 — был compose
  local inst="$1" arch="$2" f restored=0 had_compose=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      */docker-compose.yaml|*/docker-compose.yml|*/compose.yaml|*/compose.yml) had_compose=1 ;;
    esac
  done < <(tar tzf "$arch" 2>/dev/null || true)
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: из $arch были бы восстановлены недостающие файлы (no-clobber)"
    [ "$had_compose" -eq 1 ] && return 0 || return 1
  fi
  tar xzf "$arch" -C "$inst" --skip-old-files 2>/dev/null || true
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    msg_ok "Восстановлен отсутствующий файл: $f"
    restored=$((restored + 1))
  done < <(tar tzf "$arch" 2>/dev/null | grep -v '/$' || true)
  [ "$restored" -eq 0 ] && msg_warn "Из архива нечего было добавить (все файлы уже на месте)"
  return 0
}

# Поддерево инстанса внутри архива config-*.tar.gz. Архив делается так:
#   tar czf config-<ts>.tar.gz -C <корень установки> config
# поэтому файлы инстанса <inst> лежат в архиве под «<relpath(inst)>/config/…»:
#   главный инстанс /opt/ClearNDR/config  → «config/…»
#   events-stack    /opt/ClearNDR/config/events-stack/opensearch_dashboards
#                                         → «config/events-stack/opensearch_dashboards/config/…»
# Корень установки может быть неизвестен (--instance-dir без --scan-root) —
# поэтому кандидаты перебираются, а архив сам подтверждает нужный (grep листинга).
archive_member_for() {  # $1 — instance dir; $2 — архив; печатает member либо rc 1
  local inst="${1%/}" arch="$2" root="${SCAN_ROOT%/}" cand p suffix
  # 1) инстанс под известным корнем (SCAN_ROOT или /opt/ClearNDR)
  p="${inst#"$root"}"
  if [ "$p" = "$inst" ]; then p="${inst#/opt/ClearNDR}"; fi
  if [ -n "$p" ] && [ "$p" != "$inst" ]; then
    p="${p#/}"
    if [ "$(basename "$inst")" = "config" ]; then cand="$p"; else cand="$p/config"; fi
    if tar tzf "$arch" 2>/dev/null | grep -qE "^${cand}/(docker-)?compose\.(yaml|yml)$"; then
      echo "$cand"; return 0
    fi
  fi
  # 2) эвристика: поддерево от первого каталога «config» в пути инстанса
  suffix="$(printf '%s' "$inst" | grep -oE '/config[^/]*/.*' | head -1 || true)"
  if [ -n "$suffix" ]; then
    suffix="${suffix#/}"
    if [ "$(basename "$inst")" = "config" ]; then cand="$suffix"; else cand="$suffix/config"; fi
    if tar tzf "$arch" 2>/dev/null | grep -qE "^${cand}/(docker-)?compose\.(yaml|yml)$"; then
      echo "$cand"; return 0
    fi
  fi
  # 3) плоский архив всего config/ — ТОЛЬКО для самого корня установки
  if [ "$inst" = "$root" ] || [ "$inst" = "/opt/ClearNDR" ]; then
    if tar tzf "$arch" 2>/dev/null | grep -qE "^config/(docker-)?compose\.(yaml|yml)$"; then
      echo "config"; return 0
    fi
  fi
  return 1
}

restore_instance_from_archive() {  # $1 — instance dir; $2 — архив; rc 0 — извлечено
  local inst="$1" arch="$2" member
  member="$(archive_member_for "$inst" "$arch")" || {
    msg_warn "Архив $(basename "$arch") не содержит поддерево этого инстанса — пропущен"
    return 1
  }
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: из $(basename "$arch") были бы извлечены файлы ${member}/ → ${inst}/config/ (no-clobber)"
    return 0
  fi
  if [ "$member" = "config" ]; then
    tar xzf "$arch" -C "$inst" --skip-old-files "$member" 2>/dev/null || true
  else
    # снимаем префикс инстанса (config/events-stack/<имя>/), оставляя config/…
    local strip="${member%/}"; strip="${strip%/*}"
    tar xzf "$arch" -C "$inst" --skip-old-files --transform "s|^${strip}/||" "$member" 2>/dev/null || true
  fi
  msg_ok "Из $(basename "$arch") восстановлены недостающие файлы (${member}/ → config/, no-clobber)"
  return 0
}

restore_missing_from_dir() {  # $1 — config dir; $2 — каталог-источник
  local cfg="$1" src="$2" f restored=0
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: из $src были бы восстановлены недостающие файлы (no-clobber)"
    return 0
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -e "$cfg/$f" ] && [ -e "$src/$f" ]; then
      mkdir -p "$cfg/$(dirname "$f")"
      cp -a "$src/$f" "$cfg/$f"
      msg_ok "Восстановлен отсутствующий файл: $f"
      restored=$((restored + 1))
    fi
  done < <(cd "$src" && find . -type f | sed 's|^\./||' || true)
  [ "$restored" -eq 0 ] && msg_warn "Из источника нечего было добавить (все файлы уже на месте)"
  return 0
}

# ----------------------------- реконструкция из контейнеров ------------------
have_python3() { command -v python3 >/dev/null 2>&1; }

is_events_instance() {  # $1 — instance dir
  [ "$(basename "$(dirname "$1")")" = "events-stack" ]
}

# Службы events-stack (допустимы для реконструкции из контейнеров)
EVENTS_SERVICES=" opensearch opensearch-dashboards fluentd socat socat-readpcap "
# Известные службы для разбора имён <base>-<svc>-<seed> (длинные раньше коротких)
ALL_SERVICES="opensearch-dashboards socat-readpcap celery-worker celery-beat celery-flower suri-reloader opensearch fluentd socat scirius rabbitmq suricata nginx grafana victoriametrics utils cron scout evebox arkime otel ai-chat db"

# Печатает строки «service name base» для контейнеров events-stack инстанса
instance_containers() {  # $1 — seed
  local seed="$1" name short svc base
  docker ps -a --format '{{.Names}}' 2>/dev/null | while read -r name; do
    case "$name" in *-"$seed") ;; *) continue ;; esac
    short="${name%-"$seed"}"
    svc=""
    for cand in $ALL_SERVICES; do
      if [ "${short%-"$cand"}" != "$short" ]; then svc="$cand"; base="${short%-"$cand"}"; break; fi
    done
    [ -n "$svc" ] || continue
    case "$EVENTS_SERVICES" in *" $svc "*) ;; *) continue ;; esac
    printf '%s %s %s\n' "$svc" "$name" "${base:-}"
  done
}

# Собирает compose YAML из собранных docker inspect (см. manifest.json в $1)
render_compose_from_inspects() {  # $1 — tmpdir; печатает YAML
  cat >"$1/render.py" <<'PYRENDER'
import json, os, sys

def yq(v):
    return "'" + str(v).replace("'", "''") + "'"

def ns_to_s(ns):
    return "%gs" % (ns / 1e9) if ns else None

tmpd = sys.argv[1]
man = json.load(open(os.path.join(tmpd, "manifest.json")))
services = []
for row in man["services"]:
    ins = json.load(open(os.path.join(tmpd, row["file"])))
    if isinstance(ins, list):
        ins = ins[0]
    services.append({"service": row["service"], "name": row["name"], "inspect": ins})
if not services:
    sys.exit(3)

DEPS = {
    "opensearch-dashboards": {"opensearch": "service_healthy"},
    "scirius": {"db": "service_healthy", "opensearch": "service_healthy",
                "opensearch-dashboards": "service_healthy"},
    "suri-reloader": {"scirius": "service_healthy", "suricata": "service_healthy"},
    "celery-worker": {"rabbitmq": "service_healthy"},
    "celery-beat": {"rabbitmq": "service_healthy"},
    "nginx": {"scirius": "service_healthy"},
}
present = {s["service"] for s in services}
binds = []
L = []
L.append("# Автоматически реконструировано clearndr-repair-stack.sh из работающих контейнеров (%s)." % man.get("ts", ""))
L.append("# Эталонные шаблоны: https://github.com/StamusNetworks/stamusctl-templates (data/clearndr)")
L.append("")
L.append("services:")
for s in services:
    ins = s["inspect"]; c = ins.get("Config", {}); h = ins.get("HostConfig", {}); n = ins.get("NetworkSettings", {})
    svc = s["service"]
    L.append("    %s:" % svc)
    L.append("        container_name: %s" % yq(s["name"]))
    if c.get("Image"):
        L.append("        image: %s" % yq(c["Image"]))
    rp = (h.get("RestartPolicy") or {}).get("Name", "")
    if rp and rp != "no":
        L.append("        restart: %s" % yq(rp))
    if c.get("User"):
        L.append("        user: %s" % yq(c["User"]))
    if c.get("WorkingDir"):
        L.append("        working_dir: %s" % yq(c["WorkingDir"]))
    ep = c.get("Entrypoint") or []
    if ep:
        L.append("        entrypoint: [%s]" % ", ".join(yq(x) for x in ep))
    cmd = c.get("Cmd") or []
    if cmd:
        L.append("        command: [%s]" % ", ".join(yq(x) for x in cmd))
    env = [e for e in (c.get("Env") or []) if not e.startswith("HOSTNAME=")]
    if env:
        L.append("        environment:")
        for e in env:
            L.append("            - %s" % yq(e))
    ports = []
    for pname, bl in (n.get("Ports") or {}).items():
        for b in (bl or []):
            ip = (b.get("HostIp") or "").strip(); hp = b.get("HostPort") or ""
            if hp:
                ports.append((ip + ":" if ip else "") + hp + ":" + pname)
    if ports:
        L.append("        ports:")
        for p in ports:
            L.append("            - %s" % yq(p))
    vols = []
    for m in (ins.get("Mounts") or []):
        dst = m.get("Destination", "")
        if m.get("Type") == "volume":
            if m.get("Name"):
                vols.append(m["Name"] + ":" + dst)
        elif m.get("Source"):
            vols.append(m["Source"] + ":" + dst + ("" if m.get("RW", True) else ":ro"))
            binds.append({"name": s["name"], "src": m["Source"], "dst": dst})
    if vols:
        L.append("        volumes:")
        for v in vols:
            L.append("            - %s" % yq(v))
    nets = n.get("Networks") or {}
    aliases = []
    if nets:
        first = list(nets.values())[0] or {}
        aliases = [a for a in (first.get("Aliases") or []) if a]
    if not aliases:
        aliases = [svc]
    L.append("        networks:")
    L.append("            network:")
    L.append("                aliases:")
    for a in aliases:
        L.append("                    - %s" % yq(a))
    hc = c.get("Healthcheck") or {}; t = hc.get("Test") or []
    if t:
        L.append("        healthcheck:")
        if len(t) >= 2 and t[0] == "CMD-SHELL":
            L.append("            test: [%s, %s]" % (yq("CMD-SHELL"), yq(t[1])))
        else:
            L.append("            test: [%s]" % ", ".join(yq(x) for x in t))
    if hc.get("Interval"):
        L.append("            interval: %s" % yq(ns_to_s(hc["Interval"])))
    if hc.get("Timeout"):
        L.append("            timeout: %s" % yq(ns_to_s(hc["Timeout"])))
    if hc.get("Retries"):
        L.append("            retries: %d" % hc["Retries"])
    if hc.get("StartPeriod"):
        L.append("            start_period: %s" % yq(ns_to_s(hc["StartPeriod"])))
    labels = c.get("Labels") or {}
    if labels:
        L.append("        labels:")
        for k in sorted(labels):
            L.append("            %s: %s" % (yq(k), yq(labels[k])))
    deps = DEPS.get(svc) or {}
    dd = [d for d in deps if d in present]
    if dd:
        L.append("        depends_on:")
        for d in dd:
            dep_ok = False
            for s2 in services:
                if s2["service"] == d:
                    dep_ok = bool((s2["inspect"].get("Config", {}).get("Healthcheck") or {}).get("Test"))
            cond = deps[d] if dep_ok else "service_started"
            L.append("            %s:" % d)
            L.append("                condition: %s" % yq(cond))
    L.append("")
net_name = ""
if services:
    nets = (services[0]["inspect"].get("NetworkSettings", {}) or {}).get("Networks") or {}
    if nets:
        net_name = list(nets.keys())[0]
L.append("networks:")
L.append("    network:")
if net_name:
    L.append("        name: %s" % yq(net_name))
    L.append("        external: true")
with open(os.path.join(tmpd, "binds.json"), "w") as f:
    json.dump(binds, f)
print("\n".join(L))
PYRENDER
  python3 "$1/render.py" "$1"
}

# Восстанавливает содержимое bind-файлов под инстансом из контейнера
ensure_instance_bind_files() {  # $1 — tmpdir; $2 — instance dir
  local tmpd="$1" inst="${2%/}" name src dst
  [ -f "$tmpd/binds.json" ] || return 0
  while IFS=$'\t' read -r name src dst; do
    [ -n "${name:-}" ] || continue
    case "$src" in "$inst"/*|"$inst") ;; *) continue ;; esac
    [ -e "$src" ] && continue
    mkdir -p "$(dirname "$src")" || continue
    if docker exec "$name" cat "$dst" > "$src" 2>/dev/null && [ -s "$src" ]; then
      msg_ok "Файл конфигурации восстановлен из контейнера: $src"
    else
      rm -f "$src"
      msg_warn "Не удалось восстановить содержимое $src из $name — создайте файл вручную"
    fi
  done < <(python3 -c '
import json,sys
for b in json.load(open(sys.argv[1])):
    print("%s\t%s\t%s" % (b["name"], b["src"], b["dst"]))
' "$tmpd/binds.json" 2>/dev/null)
  return 0
}

# Источник (d): сборка compose из docker inspect контейнеров events-stack
reconstruct_compose_from_containers() {  # $1 — config dir; $2 — instance dir
  local cfg="$1" inst="$2" seed name first_base out tmpd r i sep rc
  local -a rows rows2
  have_python3 || { msg_warn "python3 недоступен — реконструкция compose невозможна"; return 1; }
  if ! have_docker; then msg_warn "docker недоступен — реконструкция compose невозможна"; return 1; fi
  if [ -f "$cfg/docker-compose.yaml" ] || [ -f "$cfg/docker-compose.yml" ] || [ -f "$cfg/compose.yaml" ] || [ -f "$cfg/compose.yml" ]; then return 0; fi
  if ! is_events_instance "$inst"; then
    msg_warn "Реконструкция из контейнеров поддержана только для events-stack инстансов (этот: $inst)"
    return 1
  fi
  seed="$(detect_seed)"
  [ -n "$seed" ] || { msg_warn "Не удалось определить seed — реконструкция невозможна"; return 1; }
  mapfile -t rows < <(instance_containers "$seed")
  [ "${#rows[@]}" -gt 0 ] || { msg_warn "Контейнеры events-stack не найдены (seed=$seed) — реконструкция невозможна"; return 1; }
  first_base="$(printf '%s' "${rows[0]}" | awk '{print $3}')"
  rows2=()
  for r in "${rows[@]}"; do
    [ "$(printf '%s' "$r" | awk '{print $3}')" = "$first_base" ] && rows2+=("$r")
  done
  rows=("${rows2[@]}")
  tmpd="$(mktemp -d)"
  i=0; sep=""
  printf '{"ts":"%s","services":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmpd/manifest.json"
  for r in "${rows[@]}"; do
    name="$(printf '%s' "$r" | awk '{print $2}')"
    if ! docker inspect "$name" > "$tmpd/insp-$i.json" 2>/dev/null; then continue; fi
    printf '%s{"service":"%s","name":"%s","file":"insp-%d.json"}' "$sep" "${r%% *}" "$name" "$i" >> "$tmpd/manifest.json"
    sep=","; i=$((i + 1))
  done
  printf ']}\n' >> "$tmpd/manifest.json"
  out="$(render_compose_from_inspects "$tmpd")" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    rm -rf "$tmpd"
    msg_warn "Реконструкция compose не удалась (rc=$rc)"
    return 1
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    local svcs
    svcs="$(printf '%s\n' "$out" | grep -E '^    [A-Za-z0-9_-]+:$' | sed 's/[ :]//g' | tr '\n' ' ')"
    msg_info "dry-run: compose был бы реконструирован из контейнеров: $svcs"
    rm -rf "$tmpd"
    return 0
  fi
  printf '%s\n' "$out" > "$cfg/docker-compose.yaml"
  msg_ok "compose-файл реконструирован из работающих контейнеров: config/docker-compose.yaml"
  ensure_instance_bind_files "$tmpd" "$inst"
  rm -rf "$tmpd"
  return 0
}

# ----------------------------- подъём и health -------------------------------
wait_opensearch_health() {  # $1 — config dir; rc 0 — healthy
  local cfg="$1" f seed ct waited=0 st
  f="$(compose_file_name "$cfg")" || return 1
  seed="$(sed -n 's/.*container_name:[[:space:]]*[^ ]*-\([A-Za-z0-9_]\{8,\}\)[[:space:]]*$/\1/p' "$cfg/$f" | head -1 || true)"
  [ -n "$seed" ] || seed="$(detect_seed)"
  [ -n "$seed" ] || return 1
  ct="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- "-opensearch-[A-Za-z0-9_]+$" | grep -- "$seed" | head -1 || true)"
  [ -n "$ct" ] || return 1
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    st="$(docker inspect "$ct" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' 2>/dev/null || true)"
    case "$st" in
      healthy)  msg_ok "opensearch ($ct) healthy (за ${waited}с)"; return 0 ;;
      unhealthy)
        msg_err "opensearch ($ct) unhealthy — журнал контейнера (хвост):"
        docker logs --tail 40 "$ct" 2>&1 | tail -25 || true
        msg_warn "Частые причины: vm.max_map_count < 262144 (sysctl -w vm.max_map_count=262144),"
        msg_warn "нехватка памяти/диска (df -h, free -m), переполненный том opensearch-data. Затем: docker restart $ct"
        return 1 ;;
    esac
    sleep 5; waited=$((waited + 5))
  done
  msg_warn "opensearch не сообщил health за ${HEALTH_TIMEOUT}с (продолжаю)"
  return 0
}

bring_stack_up() {  # $1 — config dir
  local cfg="$1" f
  f="$(compose_file_name "$cfg")" || return 1
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: стек был бы поднят (docker compose up -d в $cfg)"
    return 0
  fi
  if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ]; then
    printf 'Поднять стек сейчас? [Y/n] '
    read -r ans
    case "$ans" in n*|N*) msg_info "Пропущено пользователем"; return 0 ;; esac
  fi
  step "Подъём стека (docker compose up -d)"
  if docker compose --project-directory "$cfg" -f "$cfg/$f" up -d 2>&1 | tail -15; then
    wait_opensearch_health "$cfg" || return 1
  else
    msg_err "docker compose up завершился ошибкой"
    return 1
  fi
  return 0
}

# ----------------------------- ремонт одного инстанса ------------------------
repair_instance() {  # $1 — instance dir; $2 — config dir
  local inst="$1" cfg="$2" f src msg
  step "Инстанс: $inst"
  if [ ! -d "$cfg" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      msg_info "dry-run: каталог config/ отсутствует ЦЕЛИКОМ — $cfg был бы создан"
    elif mkdir -p "$cfg"; then
      msg_warn "Каталог config/ отсутствовал ЦЕЛИКОМ — создан: $cfg"
    else
      msg_err "Не удалось создать $cfg"
      FAILED=$((FAILED + 1)); return 1
    fi
  fi
  if f="$(compose_file_name "$cfg")"; then
    msg_ok "compose-файл на месте: config/$f"
  else
    msg_warn "compose-файл ОТСУТСТВУЕТ в $cfg — stamusctl compose down/up/update упадёт (Code: 14)"
    if src="$(find_good_config_source "$inst" "$cfg")"; then
      msg_info "Источник восстановления: $src"
      case "$src" in
        *.tar.gz)
          restore_instance_from_archive "$inst" "$src" || true
          ;;
        *)
          local srcdir; srcdir="$(dirname "$src")"
          if [ "$srcdir" = "$cfg/config" ]; then
            # ручной файл из config/config — сначала карантин всего каталога,
            # затем восстановление уже ИЗ КАТАЛОГА КАРАНТИНА (исходник переехал)
            local qdir
            qdir="$(quarantine_manual_dir "$inst" "$cfg" || true)"
            # mv кладёт каталог ВНУТРЬ карантина: $qdir/config/<файл>
            if [ -n "$qdir" ] && [ -d "$qdir/config" ]; then qdir="$qdir/config"; fi
            if [ "$DRY_RUN" -ne 1 ]; then
              f="$(basename "$src")"
              mkdir -p "$cfg"
              if [ -n "$qdir" ] && [ -f "$qdir/$f" ]; then
                cp -a "$qdir/$f" "$cfg/$f"
              elif [ -f "$src" ]; then
                cp -a "$src" "$cfg/$f"
              fi
              msg_ok "compose-файл размещён: config/$f (из ручной копии)"
            fi
            [ -n "$qdir" ] && restore_missing_from_dir "$cfg" "$qdir" || true
          else
            restore_missing_from_dir "$cfg" "$srcdir" || true
          fi
          ;;
      esac
    else
      msg_info "Локальных источников нет (config.failed-*/, архивы, ручной config) — пробую реконструкцию compose из работающих контейнеров"
      if ! reconstruct_compose_from_containers "$cfg" "$inst"; then
        msg_err "Источник не найден: нет config.failed-*/, архивов config-*.tar.gz и ручного config/config/."
        msg_err "Восстановите каталог config/ из резервной копии вручную и повторите."
        FAILED=$((FAILED + 1))
        return 1
      fi
    fi
    if f="$(compose_file_name "$cfg")"; then
      msg_ok "compose-файл восстановлен: config/$f"
    elif [ "$DRY_RUN" -eq 1 ]; then
      msg_info "dry-run: compose-файл был бы восстановлен в $cfg"
    elif reconstruct_compose_from_containers "$cfg" "$inst"; then
      f="$(compose_file_name "$cfg")" && msg_ok "compose-файл восстановлен: config/$f (реконструкция)"
    else
      msg_err "Восстановление не удалось — compose-файла по-прежнему нет"
      FAILED=$((FAILED + 1))
      return 1
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: дальше были бы — проверка файлов compose (configs:), валидация «docker compose config», автопатч сетей, подъём стека"
    FIXED=$((FIXED + 1))
    return 0
  fi

  # недостающие файлы, на которые ссылается compose (configs: file: …)
  local miss
  miss="$(missing_referenced_files "$cfg" | grep . || true)"
  if [ -n "$miss" ]; then
    msg_warn "compose ссылается на отсутствующие файлы:"
    printf '%s\n' "$miss" | sed 's/^/    - /'
    if src="$(find_source_for_files "$inst" "$cfg" "$miss")"; then
      msg_info "Источник восстановления файлов: $src"
      case "$src" in
        *.tar.gz) restore_instance_from_archive "$inst" "$src" || true ;;
        *)        restore_missing_from_dir "$cfg" "$src" || true ;;
      esac
      miss="$(missing_referenced_files "$cfg" | grep . || true)"
      [ -z "$miss" ] && msg_ok "Все упомянутые файлы на месте" || { msg_err "Файлы всё ещё отсутствуют: $miss"; FAILED=$((FAILED + 1)); return 1; }
    else
      msg_err "Источник для файлов не найден — создайте их вручную"
      FAILED=$((FAILED + 1))
      return 1
    fi
  fi

  # валидация + автопатч сетей
  if msg="$(ensure_compose_networks "$cfg")"; then
    msg_ok "Проект compose валиден (docker compose config)"
  else
    msg_err "Проект compose НЕ валиден: $msg"
    FAILED=$((FAILED + 1))
    return 1
  fi

  if [ "$NO_UP" -eq 1 ]; then
    msg_info "--no-up: стек не поднимается"
  else
    bring_stack_up "$cfg" || FAILED=$((FAILED + 1))
  fi
  FIXED=$((FIXED + 1))
  return 0
}

# ----------------------------- поиск инстансов -------------------------------
# Кандидат — каталог config/, который действительно является конфигурацией
# инстанса (есть compose/подкаталоги сервисов/бэкапы у родителя).
collect_config_dirs() {
  local root="$1" d
  while IFS= read -r d; do
    # фильтр мусора: каталоги данных, вложенные каталоги контейнеров и т.п.
    case "$d" in
      */containers-data/*|*/backups/*|*/config.failed-*/*|*/config.quarantine-*/*|*/data/*) continue ;;
    esac
    echo "$d"
  done < <(find "$root" -maxdepth 4 -type d -name config 2>/dev/null | sort)
}

is_instance_config() {  # $1 — config dir; rc 0 — да
  local cfg="$1" inst f
  inst="$(dirname "$cfg")"
  # инстанс events-stack — считается инстансом, даже если config/ утрачен целиком
  [ "$(basename "$(dirname "$inst")")" = "events-stack" ] && return 0
  compose_file_name "$cfg" >/dev/null 2>&1 && return 0
  [ -d "$cfg/config" ] && return 0                       # ручной config/config
  ls -d "$inst"/config.failed-*/ >/dev/null 2>&1 && return 0
  compgen -G "$inst/backups/config-*.tar.gz" >/dev/null 2>&1 && return 0
  compgen -G "$cfg/*.yaml" >/dev/null 2>&1 && return 0
  compgen -G "$cfg/*.yml" >/dev/null 2>&1 && return 0
  for f in scirius db suricata nginx opensearch opensearch_dashboards fluentd templates; do
    [ -d "$cfg/$f" ] && return 0
  done
  return 1
}

main() {
  parse_args "$@"
  step "clearndr-repair-stack.sh (dry-run=$DRY_RUN, scan-root=$SCAN_ROOT)"
  if ! have_docker; then
    msg_warn "docker недоступен — будет выполнена только проверка/восстановление файлов"
  fi

  local -a cfgs=()
  if [ -n "$INSTANCE_DIR_OPT" ]; then
    local cfg="$INSTANCE_DIR_OPT"
    [ -d "$cfg" ] || { msg_err "Каталог не найден: $cfg"; exit 1; }
    # допускается указание как самого config/, так и родительского каталога
    [ "$(basename "$cfg")" = "config" ] || cfg="$cfg/config"
    if [ ! -d "$cfg" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        msg_info "dry-run: подкаталог config/ отсутствует — $cfg был бы создан"
      else
        mkdir -p "$cfg" || { msg_err "Не удалось создать $cfg"; exit 1; }
        msg_warn "Подкаталог config/ отсутствовал ЦЕЛИКОМ — создан: $cfg (файлы восстановит следующий шаг)"
      fi
    fi
    EXPLICIT=1
    cfgs+=("$cfg")
  else
    mapfile -t cfgs < <(collect_config_dirs "$SCAN_ROOT")
    # events-stack: инстансы под ним ищем отдельно — их config/ тоже мог исчезнуть
    local es_root="$SCAN_ROOT/config/events-stack" d
    if [ -d "$es_root" ]; then
      while IFS= read -r d; do
        local dup=0 k
        for k in "${cfgs[@]}"; do [ "$k" = "$d/config" ] && { dup=1; break; }; done
        [ "$dup" -eq 0 ] && cfgs+=("$d/config")
      done < <(find "$es_root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    fi
  fi

  [ "${#cfgs[@]}" -gt 0 ] || { msg_err "Каталоги config/ не найдены (scan-root=$SCAN_ROOT)"; exit 1; }

  local cfg rc_any=0 f msg
  for cfg in "${cfgs[@]}"; do
    [ "$EXPLICIT" -eq 1 ] || is_instance_config "$cfg" || continue
    local inst; inst="$(dirname "$cfg")"
    if f="$(compose_file_name "$cfg")" && msg="$(validate_compose_project "$cfg")"; then
      msg_ok "Инстанс цел: $cfg (config/$f валиден) — проверю файлы, на которые ссылается compose"
    fi
    repair_instance "$inst" "$cfg" || rc_any=1
  done

  step "Итог"
  if [ "$FAILED" -gt 0 ]; then
    msg_err "Починено инстансов: $FIXED; НЕ удалось починить: $FAILED"
    exit 1
  fi
  msg_ok "Готово (починено инстансов: $FIXED)"
  exit 0
}

main "$@"
