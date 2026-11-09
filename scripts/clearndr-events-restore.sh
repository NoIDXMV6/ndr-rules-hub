#!/usr/bin/env bash
# ============================================================================
# clearndr-events-restore.sh — диагностика и восстановление events-stack
# Clear NDR (OpenSearch + OpenSearch Dashboards + fluentd), когда OpenSearch
# Dashboards ПУСТ: нет источников данных (индекс-паттернов), нет дашбордов.
#
# Как устроен events-stack (шаблоны stamusctl-templates 3.3.x):
#   • fluentd читает /var/log/suricata/*.json (eve.json Suricata) и пишет события
#     в индексы logstash-<event_type>-<дата> (например logstash-alert-2026.11.09);
#   • OpenSearch хранит индексы в томе opensearch-data-<seed>, позиционные файлы
#     fluentd — в томе fluentd-pos-<seed>; seed — суффикс установки (вида
#     FNISvONwp2TtteCD), он же в именах контейнеров;
#   • OpenSearch Dashboards по умолчанию ПУСТ: индекс-паттерн logstash-*,
#     дашборды и визуализации создаёт Scirius (главный стек) — его встроенные
#     определения лежат в образе scirius в /opt/selks/kibana7-dashboards;
#   • пересоздать всё это можно командой внутри контейнера scirius:
#       docker exec -w /code <scirius> python manage.py kibana_reset
#     Она удаляет объекты с именами НЕ на «SN» (кастомные дашборды!) и заново
#     заливает штатные: индекс-паттерн logstash-* + дашборды + визуализации.
#
# Почему Dashboards бывает пуст:
#   1. Том opensearch-data-<seed> пересоздан (данные и .kibana исчезли) — часто
#      после сбойного обновления/пересоздания стека с НОВЫМ seed: тогда старый
#      том opensearch-data-<старый-seed> может ещё существовать с данными;
#   2. миграция .kibana на OpenSearch 3.x не отработала (паттерны пропали,
#      данные на месте);
#   3. fluentd не пишет (не читает eve.json / нет связи с opensearch) — данные
#      не появляются;
#   4. комбинация предыдущих.
# Скрипт определяет, какой из вариантов у вас, и по флагу --fix чинит.
#
# Примеры:
#   sudo ./clearndr-events-restore.sh                # только диагностика
#   sudo ./clearndr-events-restore.sh --fix          # диагностика + исправления
#   sudo ./clearndr-events-restore.sh --fix --yes    # без вопросов
#   sudo ./clearndr-events-restore.sh --instance-dir /opt/ClearNDR/config/events-stack/opensearch_dashboards
#
# Коды выхода: 0 — всё в порядке / восстановлено; 1 — проблемы остались
# (см. вывод диагностики).
# ============================================================================

set -Eeuo pipefail
umask 077

INSTANCE_DIR_OPT=""      # --instance-dir
DEFAULT_INSTANCE="/opt/ClearNDR/config/events-stack/opensearch_dashboards"
FIX=0
ASSUME_YES=0
SKIP_VOLUME_COPY=0
HEALTH_TIMEOUT=180
NO_COLOR=0
PROBE_WAIT=10            # сек между двумя замерами doc count (проверка притока)

C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
if [ -t 1 ] && [ "${NO_COLOR}" -eq 0 ]; then
  C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
fi
msg_info() { printf "${C_INFO}[INFO]${C_OFF} %s\n" "$*"; }
msg_ok()   { printf "${C_OK}[ OK ]${C_OFF} %s\n" "$*"; }
msg_warn() { printf "${C_WARN}[WARN]${C_OFF} %s\n" "$*"; }
msg_err()  { printf "${C_ERR}[FAIL]${C_OFF} %s\n" "$*" >&2; }
step()     { printf "\n${C_INFO}==>${C_OFF} %s\n" "$*"; }

USAGE_NAME="$(basename "$0")"
usage() { awk 'NR>1 && !/^#/ {exit} NR>1 {sub(/^# ?/, ""); print}' "$0"; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --instance-dir)     INSTANCE_DIR_OPT="${2:?--instance-dir: укажите каталог}"; shift 2 ;;
      --fix)              FIX=1; shift ;;
      --yes|-y)           ASSUME_YES=1; shift ;;
      --skip-volume-copy) SKIP_VOLUME_COPY=1; shift ;;
      --health-timeout)   HEALTH_TIMEOUT="${2:?--health-timeout: укажите секунды}"; shift 2 ;;
      --no-color)         NO_COLOR=1; C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""; shift ;;
      --help|-h)          usage; exit 0 ;;
      *)                  msg_err "Неизвестный аргумент: $1"; echo; usage; exit 1 ;;
    esac
  done
}

# ----------------------------- состояние (заполняется диагностикой) ---------
SEED=""
CT_OPENSEARCH=""; CT_DASHBOARDS=""; CT_FLUENTD=""; CT_SCIRIUS=""
OS_HEALTH=""; OS_INDICES_TOTAL=""; OS_LOGSTASH_COUNT=""; OS_KIBANA_DOCS=""
OS_DISK=""
OSD_STATE=""; OSD_PATTERNS=""            # список titles индекс-паттернов
FLUENTD_RUNNING=0
SCIRIUS_RUNNING=0
VOLUME_ATTACHED=""
VOLUME_OTHERS=""                          # другие opensearch-data-*, через |
EVE_DIR=""; EVE_FRESH=""
PROBLEMS=0

have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

ct_running() { [ -n "$1" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -Fxq -- "$1"; }

find_container() {  # $1 — подстрока имени (opensearch|opensearch-dashboards|fluentd|scirius)
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E -- "-$1-[A-Za-z0-9_]+$" | head -1 || true
}

# HTTP внутри контейнера (curl есть в образах opensearch и dashboards — healthcheck)
api() {  # $1 — контейнер; $2 — путь; печатает ответ либо пусто
  docker exec "$1" curl -fsS --max-time 10 "$2" 2>/dev/null || true
}

json_str() {  # $1 — json; $2 — ключ верхнего уровня (грубый, без jq)
  printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

# ----------------------------- диагностика -----------------------------------
diagnose_instance() {
  local inst="$1" cfg="$inst/config" f

  step "Инстанс events-stack: $inst"

  # --- compose-файл (нужен stamusctl, но НЕ нужен для работы контейнеров) ---
  if f="$(ls "$cfg"/docker-compose.y*ml 2>/dev/null | head -1)"; then
    msg_ok "compose-файл: ${f#$inst/}"
  else
    msg_warn "compose-файла нет в config/ — контейнеры продолжат работать (restart: unless-stopped"
    msg_warn "поднимает их docker-демон при перезагрузке), но stamusctl compose down/up/update упадёт (Code: 14)."
    msg_warn "Чинит clearndr-repair-stack.sh --instance-dir $inst"
    PROBLEMS=$((PROBLEMS + 1))
  fi

  # --- контейнеры ---
  CT_OPENSEARCH="$(find_container opensearch | grep -v -- '-dashboards-' | head -1 || true)"
  CT_DASHBOARDS="$(find_container opensearch-dashboards)"
  CT_FLUENTD="$(find_container fluentd)"
  CT_SCIRIUS="$(find_container scirius)"
  seed_from_ct() { printf '%s' "${1##*-}"; }
  [ -z "$SEED" ] && [ -n "$CT_OPENSEARCH" ] && SEED="$(seed_from_ct "$CT_OPENSEARCH")"

  for pair in "opensearch:$CT_OPENSEARCH" "opensearch-dashboards:$CT_DASHBOARDS" "fluentd:$CT_FLUENTD" "scirius(главный стек):$CT_SCIRIUS"; do
    local label="${pair%%:*}" ct="${pair#*:}"
    if [ -z "$ct" ]; then
      msg_warn "Контейнер $label не найден"
    elif ct_running "$ct"; then
      local st; st="$(docker inspect "$ct" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
      msg_ok "Контейнер $label: $ct — работает ($st)"
    else
      msg_warn "Контейнер $label: $ct — НЕ запущен"
    fi
  done
  [ -n "$SEED" ] && msg_ok "Seed установки: $SEED"
  if [ -n "$CT_SCIRIUS" ]; then
    ct_running "$CT_SCIRIUS" && SCIRIUS_RUNNING=1
    local envseed; envseed="$(docker inspect "$CT_SCIRIUS" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^STAMUSCTL_SEED=//p' | head -1 || true)"
    [ -n "$envseed" ] && [ "$envseed" != "$SEED" ] && msg_warn "Seed scirius ($envseed) не совпадает с seed events-stack ($SEED) — стеки из разных выпусков!"
  fi
  FLUENTD_RUNNING=0; ct_running "$CT_FLUENTD" && FLUENTD_RUNNING=1

  # --- тома ---
  if [ -n "$SEED" ]; then
    VOLUME_ATTACHED="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -Fx -- "opensearch-data-$SEED" || true)"
    VOLUME_OTHERS="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E -- '^opensearch-data-' | grep -v -- "$SEED" | tr '\n' '|' | sed 's/|$//' || true)"
    [ -n "$VOLUME_ATTACHED" ] && msg_ok "Том данных events-stack: $VOLUME_ATTACHED"
    [ -n "$VOLUME_OTHERS" ] && msg_warn "Другие тома opensearch-data-*: $(echo "$VOLUME_OTHERS" | tr '|' ' ') — возможно, там данные прошлого выпуска"
  fi

  # --- opensearch API ---
  if ct_running "$CT_OPENSEARCH"; then
    local h; h="$(api "$CT_OPENSEARCH" 'http://localhost:9200/_cluster/health')"
    OS_HEALTH="$(json_str "$h" status)"
    OS_INDICES_TOTAL="$(json_str "$h" number_of_indices)"
    [ -n "$OS_HEALTH" ] \
      && msg_ok "OpenSearch cluster health: $OS_HEALTH (индексов: ${OS_INDICES_TOTAL:-?})" \
      || { msg_err "OpenSearch API недоступен внутри контейнера"; PROBLEMS=$((PROBLEMS + 1)); }
    OS_LOGSTASH_COUNT="$(api "$CT_OPENSEARCH" 'http://localhost:9200/_cat/indices/logstash-*?h=docs.count' | awk '{s+=$1} END {print s+0}')"
    OS_KIBANA_DOCS="$(api "$CT_OPENSEARCH" 'http://localhost:9200/.kibana/_count' | sed -n 's/.*"count":[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
    OS_DISK="$(api "$CT_OPENSEARCH" 'http://localhost:9200/_cat/allocation?h=disk.percent&format=json' | sed -n 's/.*"disk.percent"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$OS_DISK" ] && msg_ok "Диск узла opensearch: ${OS_DISK} занято"
    if [ "${OS_LOGSTASH_COUNT:-0}" -gt 0 ] 2>/dev/null; then
      msg_ok "События в индексах logstash-*: ${OS_LOGSTASH_COUNT} документов"
    else
      msg_warn "Индексов logstash-* нет или они пусты — событий от fluentd не поступает"
      PROBLEMS=$((PROBLEMS + 1))
    fi
    msg_info "Объектов в .kibana (сохранённые объекты Dashboards): ${OS_KIBANA_DOCS:-0}"
  else
    msg_err "opensearch не запущен — API-проверки пропущены"
    PROBLEMS=$((PROBLEMS + 1))
  fi

  # --- dashboards API ---
  if ct_running "$CT_DASHBOARDS"; then
    local st_json; st_json="$(api "$CT_DASHBOARDS" 'http://localhost:5601/api/status')"
    OSD_STATE="$(json_str "$st_json" state)"
    [ -z "$OSD_STATE" ] && OSD_STATE="$(json_str "$st_json" level)"
    msg_ok "OpenSearch Dashboards: ${OSD_STATE:-отвечает}"
    OSD_PATTERNS="$(api "$CT_DASHBOARDS" 'http://localhost:5601/api/saved_objects/_find?type=index-pattern&per_page=100' \
      | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ' | sed 's/ $//')"
    if [ -n "$OSD_PATTERNS" ]; then
      msg_ok "Индекс-паттерны Dashboards: $OSD_PATTERNS"
    else
      msg_err "Индекс-паттернов в Dashboards НЕТ — отсюда «пусто: нет источников данных, дашбордов»"
      PROBLEMS=$((PROBLEMS + 1))
    fi
  else
    msg_err "OpenSearch Dashboards не запущен (веб-интерфейс недоступен)"
    PROBLEMS=$((PROBLEMS + 1))
  fi

  # --- fluentd и eve.json ---
  if [ "$FLUENTD_RUNNING" -eq 1 ]; then
    EVE_DIR="$(docker inspect "$CT_FLUENTD" --format '{{range .Mounts}}{{if eq .Destination "/var/log/suricata"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
    if [ -n "$EVE_DIR" ] && [ -d "$EVE_DIR" ]; then
      local newest age
      newest="$(ls -1t "$EVE_DIR"/*.json 2>/dev/null | head -1 || true)"
      if [ -n "$newest" ]; then
        age=$(( $(date +%s) - $(stat -c %Y "$newest" 2>/dev/null || echo 0) ))
        EVE_FRESH="да (${age}с назад: $(basename "$newest"))"
        if [ "$age" -lt 600 ]; then
          msg_ok "Suricata eve.json обновляется: $EVE_FRESH"
        else
          msg_warn "Suricata eve.json не обновлялся ${age}с (${newest}) — проверьте главный стек (suricata)"
        fi
      else
        msg_warn "В $EVE_DIR нет *.json — Suricata не пишет события сюда"
        PROBLEMS=$((PROBLEMS + 1))
      fi
    else
      msg_warn "Не удалось определить каталог eve.json (монтирование fluentd)"
    fi
    local flog; flog="$(docker logs --tail 12 "$CT_FLUENTD" 2>&1 || true)"
    if printf '%s' "$flog" | grep -qiE 'error|refused|timeout|retry'; then
      msg_warn "В журнале fluentd есть ошибки (хвост):"
      printf '%s\n' "$flog" | tail -6 | sed 's/^/    /'
    fi
  else
    msg_err "fluentd не запущен — события не поступают"
    PROBLEMS=$((PROBLEMS + 1))
  fi
}

# ----------------------------- исправления -----------------------------------
confirm() {  # $1 — вопрос; rc 0 — да
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [y/N] ' "$1"
  local a; read -r a
  [ "$a" = "y" ] || [ "$a" = "Y" ] || [ "$a" = "yes" ]
}

fix_volume_data() {  # перенос данных из старого тома в прикреплённый
  [ "$SKIP_VOLUME_COPY" -eq 1 ] && { msg_info "--skip-volume-copy: перенос данных между томами отключён"; return 1; }
  [ -n "$VOLUME_OTHERS" ] || return 1
  [ -n "$VOLUME_ATTACHED" ] || return 1
  [ "${OS_LOGSTASH_COUNT:-0}" -gt 0 ] 2>/dev/null && return 1   # данные есть — перенос не нужен
  step "Восстановление данных: перенос из прошлого тома"
  local old
  for old in $(echo "$VOLUME_OTHERS" | tr '|' ' '); do
    local docs
    docs="$(docker run --rm -v "$old":/src:ro alpine sh -c 'du -sh /src 2>/dev/null | cut -f1' 2>/dev/null || true)"
    msg_info "Кандидат: $old (размер каталога: ${docs:-неизвестен})"
  done
  old="$(echo "$VOLUME_OTHERS" | tr '|' ' ' | awk '{print $1}')"
  msg_warn "Будет выполнено: остановка контейнеров events-stack, копирование $old → $VOLUME_ATTACHED (alpine cp -a), запуск обратно."
  msg_warn "Целевой том должен быть ПУСТ или его данные будут дописаны поверх."
  confirm "Перенести данные из $old в $VOLUME_ATTACHED?" || { msg_info "Пропущено пользователем"; return 1; }
  local cts=("$CT_OPENSEARCH" "$CT_DASHBOARDS" "$CT_FLUENTD") ct
  for ct in "${cts[@]}"; do [ -n "$ct" ] && ct_running "$ct" && docker stop "$ct" >/dev/null 2>&1 || true; done
  if docker run --rm -v "$old":/src:ro -v "$VOLUME_ATTACHED":/dst alpine sh -c 'cp -a /src/. /dst/ 2>/dev/null; exit 0'; then
    msg_ok "Данные скопированы"
  else
    msg_err "Копирование не удалось"
  fi
  for ct in "${cts[@]}"; do [ -n "$ct" ] && docker start "$ct" >/dev/null 2>&1 || true; done
  wait_opensearch
  return 0
}

fix_fluentd() {
  [ "$FLUENTD_RUNNING" -eq 1 ] && return 0
  step "Запуск fluentd"
  if [ -n "$CT_FLUENTD" ]; then
    confirm "Запустить контейнер $CT_FLUENTD?" || { msg_info "Пропущено пользователем"; return 1; }
    docker start "$CT_FLUENTD" >/dev/null 2>&1 && msg_ok "fluentd запущен" || msg_err "Не удалось запустить fluentd"
  else
    local cfg="${INSTANCE_DIR_OPT%/}/config"
    local f; f="$(ls "$cfg"/docker-compose.y*ml 2>/dev/null | head -1 || true)"
    if [ -n "$f" ]; then
      confirm "Создать сервис fluentd (docker compose up -d fluentd)?" || { msg_info "Пропущено"; return 1; }
      (cd "$cfg" && docker compose -f "$(basename "$f")" up -d fluentd 2>&1 | tail -5)
    else
      msg_err "compose-файла нет — сначала clearndr-repair-stack.sh"
      return 1
    fi
  fi
  return 0
}

fix_dashboards() {  # пересоздание индекс-паттерна + дашбордов
  step "Восстановление источников данных и дашбордов"
  if [ -n "$CT_SCIRIUS" ] && [ "$SCIRIUS_RUNNING" -eq 1 ]; then
    if ! docker exec "$CT_SCIRIUS" test -f /code/manage.py 2>/dev/null; then
      msg_err "В контейнере scirius нет /code/manage.py — обновите главный стек или сообщите в поддержку"
      return 1
    fi
    msg_warn "Команда kibana_reset УДАЛИТ в Dashboards кастомные объекты (все, кроме штатных Stamus «SN*»)"
    msg_warn "и заново создаст штатные: индекс-паттерн logstash-*, дашборды, визуализации. Данные (индексы) не трогаются."
    confirm "Выполнить в scirius: python manage.py kibana_reset?" || { msg_info "Пропущено пользователем"; return 1; }
    if docker exec -w /code "$CT_SCIRIUS" python manage.py kibana_reset 2>&1 | tail -5; then
      msg_ok "kibana_reset выполнен"
      return 0
    fi
    msg_warn "python не сработал — пробую python3"
    if docker exec -w /code "$CT_SCIRIUS" python3 manage.py kibana_reset 2>&1 | tail -5; then
      msg_ok "kibana_reset выполнен (python3)"
      return 0
    fi
    msg_err "kibana_reset не удался — смотрите вывод выше"
    return 1
  elif [ -n "$CT_SCIRIUS" ]; then
    msg_warn "Контейнер scirius есть, но не запущен — запустите главный стек и повторите --fix."
    msg_warn "Альтернатива вручную: docker start $CT_SCIRIUS && docker exec -w /code $CT_SCIRIUS python manage.py kibana_reset"
    return 1
  else
    msg_warn "Контейнер scirius не найден — создам только индекс-паттерн logstash-* через API (без дашбордов Stamus)."
    if [ -n "$CT_DASHBOARDS" ] && ct_running "$CT_DASHBOARDS"; then
      confirm "Создать индекс-паттерн logstash-* через API Dashboards?" || { msg_info "Пропущено"; return 1; }
      if docker exec "$CT_DASHBOARDS" curl -fsS --max-time 15 -X POST \
          -H 'osd-xsrf: true' -H 'Content-Type: application/json' \
          -d '{"attributes":{"title":"logstash-*","timeFieldName":"@timestamp"}}' \
          'http://localhost:5601/api/saved_objects/index-pattern/logstash-*' >/dev/null 2>&1; then
        msg_ok "Индекс-паттерн logstash-* создан (дашборды появятся после запуска scirius и повторного --fix)"
        return 0
      fi
      msg_err "Не удалось создать индекс-паттерн через API"
    fi
    return 1
  fi
}

wait_opensearch() {
  local waited=0 st
  [ -n "$CT_OPENSEARCH" ] || return 0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    st="$(docker inspect "$CT_OPENSEARCH" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    [ "$st" = "healthy" ] || [ "$st" = "running" ] && { msg_ok "opensearch снова в строю ($st, за ${waited}с)"; return 0; }
    sleep 5; waited=$((waited + 5))
  done
  msg_warn "opensearch не сообщил healthy за ${HEALTH_TIMEOUT}с"
  return 0
}

# ----------------------------- проверка результата ---------------------------
verify_result() {
  step "Проверка результата"
  if ct_running "$CT_DASHBOARDS"; then
    OSD_PATTERNS="$(api "$CT_DASHBOARDS" 'http://localhost:5601/api/saved_objects/_find?type=index-pattern&per_page=100' \
      | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ' | sed 's/ $//')"
    if printf '%s' "$OSD_PATTERNS" | grep -q 'logstash'; then
      msg_ok "Индекс-паттерн logstash-* в Dashboards: ЕСТЬ → источники данных появятся в интерфейсе"
    else
      msg_err "Индекс-паттерн logstash-* так и не появился"
      PROBLEMS=$((PROBLEMS + 1))
    fi
  fi
  if ct_running "$CT_OPENSEARCH"; then
    OS_LOGSTASH_COUNT="$(api "$CT_OPENSEARCH" 'http://localhost:9200/_cat/indices/logstash-*?h=docs.count' | awk '{s+=$1} END {print s+0}')"
    local c2
    sleep "$PROBE_WAIT"
    c2="$(api "$CT_OPENSEARCH" 'http://localhost:9200/_cat/indices/logstash-*?h=docs.count' | awk '{s+=$1} END {print s+0}')"
    if [ "${OS_LOGSTASH_COUNT:-0}" -gt 0 ]; then
      if [ "$c2" -gt "$OS_LOGSTASH_COUNT" ]; then
        msg_ok "События поступают: ${OS_LOGSTASH_COUNT} → ${c2} документов за ${PROBE_WAIT}с"
      else
        msg_ok "События на месте: ${OS_LOGSTASH_COUNT} документов (приток за ${PROBE_WAIT}с: +$((c2 - OS_LOGSTASH_COUNT)))"
      fi
    else
      msg_warn "Индексы logstash-* пусты — fluentd не пишет (см. журналы: docker logs --tail 50 ${CT_FLUENTD:-fluentd})"
      PROBLEMS=$((PROBLEMS + 1))
    fi
  fi
}

main() {
  parse_args "$@"
  local inst="${INSTANCE_DIR_OPT:-$DEFAULT_INSTANCE}"
  [ "$(basename "$inst")" = "config" ] && inst="$(dirname "$inst")"

  step "clearndr-events-restore.sh (fix=$FIX)"
  if ! have_docker; then
    msg_err "docker недоступен — скрипт должен запускаться на хосте Clear NDR (root)"
    exit 1
  fi
  [ -d "$inst" ] || { msg_err "Каталог инстанса не найден: $inst (укажите --instance-dir)"; exit 1; }

  diagnose_instance "$inst"
  local diag_problems="$PROBLEMS"
  if [ "$FIX" -eq 1 ]; then
    PROBLEMS=0   # итог — состояние ПОСЛЕ исправлений; диагностика учтена выше
    # 1) данные из прошлого тома (если прикреплённый пуст, а старый есть)
    fix_volume_data || true
    # 2) fluentd
    if [ "$FLUENTD_RUNNING" -eq 0 ]; then fix_fluentd || true; fi
    # 3) индекс-паттерны и дашборды
    if [ -z "$OSD_PATTERNS" ] || ! printf '%s' "$OSD_PATTERNS" | grep -q 'logstash'; then
      fix_dashboards || true
    else
      msg_ok "Индекс-паттерн logstash-* уже есть — kibana_reset не требуется"
    fi
    ct_running "$CT_OPENSEARCH" || wait_opensearch
    verify_result
  else
    step "Рекомендации"
    if [ -z "$OSD_PATTERNS" ]; then
      msg_info "Запустите с --fix: скрипт выполнит kibana_reset в scirius (штатные дашборды + индекс-паттерн logstash-*),"
      msg_info "при пустом томе данных предложит перенос из старого тома opensearch-data-*, запустит fluentd."
    fi
    if [ -n "$VOLUME_OTHERS" ]; then
      msg_info "Проверьте старые тома на данные: docker run --rm -v <том>:/src:ro alpine du -sh /src"
    fi
  fi

  step "Итог"
  if [ "$FIX" -eq 1 ] && [ "$PROBLEMS" -eq 0 ] && [ "$diag_problems" -gt 0 ]; then
    msg_ok "Проблем при диагностике: $diag_problems — все устранены"
  fi
  if [ "$PROBLEMS" -gt 0 ]; then
    msg_err "Осталось проблем: $PROBLEMS — см. [FAIL]/[WARN] выше"
    exit 1
  fi
  msg_ok "Проблем не обнаружено / всё восстановлено"
  exit 0
}

main "$@"
