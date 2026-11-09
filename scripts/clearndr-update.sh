#!/usr/bin/env bash
# ============================================================================
# clearndr-update.sh — обновление установленного Clear NDR Community
# (docker-стек под управлением stamusctl) на новую версию с сохранением
# всех настроек, включая интеграции (mikrocata2selks / MikroTik и любые другие).
#
# Основано на официальной документации Stamus Networks (Clear NDR):
#   https://docs.clearndr.io/docs/start/common-operations   (upgrade-процедура)
#   https://docs.clearndr.io/docs/stamusctl/compose/update  (команда update)
#   https://github.com/StamusNetworks/stamusctl             (CLI)
#
# Процедура штатного обновления, которой следует скрипт:
#   stamusctl compose update [--version VER]   # новый шаблон + сохранение значений
#   stamusctl compose pull                     # свежие образы
#   stamusctl compose up -d                    # перезапуск стека
#
# Возможности (v3):
#   • Статус каждого долгого шага: «⏳ подпись (сек)» на ОДНОЙ строке терминала,
#     в неинтерактивном режиме — строки [WAIT] раз в минуту; итог «готово за Nс».
#   • Чистый вывод и лог: кадры прогресса docker (Downloading/Extracting/Waiting)
#     перезаписывают одну строку на экране и НЕ попадают в лог — лог содержит
#     только начало/завершение шагов, статусы и ошибки (без 80 МБ прогресса).
#   • Анализ совместимости данных ДО остановки стека: если компонент меняет
#     мажорную версию (OpenSearch 2.x → 3.x, PostgreSQL 16 → 17), скрипт СПРАШИВАЕТ:
#     сохранить данные / ручная конвертация (подсказки) / чистые данные
#     (для PostgreSQL — автоматическое пересоздание тома + восстановление из дампа).
#   • Сохранение всех настроек (3 уровня бэкапа):
#       1. pg_dumpall PostgreSQL ДО остановки (правила, наборы, SID, токены…)
#       2. каталог config/ ПОСЛЕ остановки (compose-файлы, TLS, значения stamusctl);
#          пользовательские файлы, исчезнувшие при обновлении шаблона,
#          восстанавливаются автоматически
#       3. docker volume db-data-<seed> (сырые файлы PostgreSQL)
#   • Интеграции: обнаружение mikrocata2selks (MikroTik), снапшот её файлов,
#     проверка/восстановление suricata.interfaces (tzsp0 и др.), пост-проверка
#     служб/интерфейсов; универсальный механизм сохранения кастомизаций.
#   • Health-checks (контейнеры, веб-интерфейс, REST API по токену), сбор
#     диагностики при сбое (fail-logs) и автооткат config/ с проверкой результата.
#
# Примеры:
#   sudo ./clearndr-update.sh                              # до последней версии
#   sudo ./clearndr-update.sh --version 1.2.0              # до конкретной версии
#   ./clearndr-update.sh --dry-run                         # план без изменений
#   sudo ./clearndr-update.sh --yes --update-cli           # + обновить stamusctl
#   sudo ./clearndr-update.sh --instance /opt/ClearNDR     # не из каталога инстанса
#   sudo ./clearndr-update.sh --opensearch-data wipe       # события OpenSearch очистить
#   sudo ./clearndr-update.sh --pg-strategy restore        # PG major: пересоздать и восстановить
#
# Коды выхода: 0 — успех/отмена без изменений; 1 — ошибка предпроверки;
# 2 — неудача обновления (после попытки отката).
# ============================================================================

set -Eeuo pipefail
umask 077   # бэкапы могут содержать секреты (токены) — только для владельца

# ----------------------------- настройки по умолчанию -----------------------
TARGET_VERSION=""            # "" => latest
INSTANCE_DIR=""              # "" => текущий каталог
CONFIG_DIR_OPT=""            # --config-dir (override)
BACKUP_DIR_OPT=""            # --backup-dir
UPDATE_CLI=0                 # --update-cli: обновить и сам stamusctl
SKIP_DB_DUMP=0               # --skip-db-dump
SKIP_VOLUME=0                # --skip-volume
FULL_CONFIG=0                # --full-config
HEALTH_URL="https://localhost/"
API_TOKEN="${CLEAR_NDR_TOKEN:-}"
HEALTH_TIMEOUT=300           # --health-timeout, секунд
ASSUME_YES=0                 # --yes
NO_ROLLBACK=0                # --no-rollback
DRY_RUN=0                    # --dry-run
OPENSEARCH_DATA="ask"        # ask|keep|wipe|guide
PG_STRATEGY="ask"            # ask|restore|cancel
NO_COLOR=0                   # --no-color
SKIP_MIKROCATA_CHECK=0       # --skip-mikrocata-check

STACK_SERVICES=(scirius db suricata nginx opensearch)   # критичные сервисы стека
COMPOSE_STOP_TIMEOUT=90
SURICATA_LOG_TAIL=40
HEARTBEAT=60                 # сек между [WAIT]-строками в неинтерактивном режиме

STAMUSCTL_BIN=""             # резолвится в preflight
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=""
LOG_FILE=""
STAMUSCTL_UPDATED=""
OLD_STACK_VERSION=""
NEW_STACK_VERSION=""
OLD_OS_TAG=""; TARGET_OS_TAG=""; NEW_OS_TAG=""
OLD_PG_TAG=""; TARGET_PG_TAG=""; NEW_PG_TAG=""
OLD_SURICATA_INTERFACES=""
DBUSER="selks"
WIPE_OS=0; OS_DECIDED=0
RESTORE_DB=0; PG_DECIDED=0
MIKROCATA=0

# ----------------------------- вывод и логирование --------------------------
IS_TTY=0; HAS_TTY=0
[ -t 1 ] && IS_TTY=1
{ [ -e /dev/tty ] && [ -w /dev/tty ]; } && HAS_TTY=1
FILTER_MODE="plain"
if [ "$IS_TTY" -eq 1 ] && [ "$HAS_TTY" -eq 1 ] && [ "$NO_COLOR" -eq 0 ]; then FILTER_MODE="tty"; fi

if [ "$IS_TTY" -eq 1 ] && [ "$NO_COLOR" -eq 0 ]; then
  C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
msg_info() { printf "${C_INFO}[INFO]${C_OFF} %s\n" "$*"; }
msg_ok()   { printf "${C_OK}[ OK ]${C_OFF} %s\n" "$*"; }
msg_warn() { printf "${C_WARN}[WARN]${C_OFF} %s\n" "$*"; }
msg_err()  { printf "${C_ERR}[FAIL]${C_OFF} %s\n" "$*" >&2; }
step()     { printf "\n${C_INFO}==>${C_OFF} %s\n" "$*"; }

LOG_OPENED=0
open_log() {   # вызывается после создания BACKUP_DIR
  [ "$LOG_OPENED" -eq 1 ] && return 0
  LOG_FILE="$1"
  [ "$DRY_RUN" -eq 1 ] && { msg_info "dry-run: лог не пишется (был бы $LOG_FILE)"; LOG_OPENED=1; return 0; }
  exec > >(tee -a "$LOG_FILE") 2>&1
  LOG_OPENED=1
  msg_info "Лог: $LOG_FILE"
}

# ----------------------------- статус долгих шагов --------------------------
# Тикер: на терминале обновляет ОДНУ строку «⏳ подпись (сек)»; в неинтерактивном
# режиме пишет в лог строку [WAIT] раз в HEARTBEAT секунд.
TICK_PID=""; TICK_START=0; TICK_LABEL=""

tick_start() {
  TICK_START=$SECONDS
  TICK_LABEL="$1"
  (
    while :; do
      sleep 3
      local el=$((SECONDS - TICK_START))
      if [ "$IS_TTY" -eq 1 ] && [ "$HAS_TTY" -eq 1 ]; then
        printf '\r\033[K  ⏳ %s… (%ds)' "$TICK_LABEL" "$el" > /dev/tty 2>/dev/null || true
      elif [ $((el % HEARTBEAT)) -eq 0 ]; then
        printf '[WAIT] %s… (%ds)\n' "$TICK_LABEL" "$el"
      fi
    done
  ) & TICK_PID=$!
}

tick_stop() {
  local rc="${1:-0}"
  if [ -n "$TICK_PID" ]; then
    kill "$TICK_PID" 2>/dev/null || true
    wait "$TICK_PID" 2>/dev/null || true
    TICK_PID=""
  fi
  local el=$((SECONDS - TICK_START))
  if [ "$IS_TTY" -eq 1 ] && [ "$HAS_TTY" -eq 1 ]; then
    printf '\r\033[K' > /dev/tty 2>/dev/null || true
  fi
  if [ "$rc" -eq 0 ]; then
    msg_ok "$TICK_LABEL — готово (за ${el}с)"
  else
    msg_err "$TICK_LABEL — ошибка (за ${el}с)"
  fi
}

# Фильтр вывода docker/stamusctl: кадры прогресса (Downloading/Extracting/Waiting/…)
# на терминале перезаписывают одну строку, а в лог НЕ попадают вовсе. Значимые
# события (Pulled/Pull complete/Created/Started/Healthy/ошибки/warnings) печатаются.
filter_prog() {
  awk -v MODE="$FILTER_MODE" '
    {
      line = $0
      if (line ~ /Downloading \[|Extracting [0-9]|Verifying Checksum|Pulling fs layers/) {
        if (MODE == "tty") { printf "\r\033[K%.100s", line > "/dev/tty"; pending = 1 }
        next
      }
      if (line ~ /(Waiting|Creating|Starting|Stopping|Removing) *$/) {
        if (MODE == "tty") { printf "\r\033[K%.100s", line > "/dev/tty"; pending = 1 }
        next
      }
      if (pending) { if (MODE == "tty") printf "\n" > "/dev/tty"; pending = 0 }
      print
    }
    END { if (pending && MODE == "tty") printf "\n" > "/dev/tty" }
  '
}

# Выполнить команду с тикером статуса и фильтрацией вывода. Возвращает код команды.
run_prog() {
  local label="$1"; shift
  local rc=0
  tick_start "$label"
  "$@" 2>&1 | filter_prog || rc="${PIPESTATUS[0]}"
  tick_stop "$rc"
  return "$rc"
}

# Выполнить мутирующую команду (с учётом --dry-run) под тикером.
mut_prog() {
  local label="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: $*"
    return 0
  fi
  run_prog "$label" "$@"
}

# ----------------------------- разбор аргументов ----------------------------
usage() {
  awk 'NR>1 && !/^#/ {exit} NR>1 {sub(/^# ?/, ""); print}' "$0"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)          TARGET_VERSION="${2:?--version: укажите версию}"; shift 2 ;;
      --instance)         INSTANCE_DIR="${2:?--instance: укажите каталог}"; shift 2 ;;
      --config-dir)       CONFIG_DIR_OPT="${2:?--config-dir: укажите каталог}"; shift 2 ;;
      --backup-dir)       BACKUP_DIR_OPT="${2:?--backup-dir: укажите каталог}"; shift 2 ;;
      --url)              HEALTH_URL="${2:?--url: укажите URL}"; shift 2 ;;
      --token)            API_TOKEN="${2:?--token: укажите токен}"; shift 2 ;;
      --health-timeout)   HEALTH_TIMEOUT="${2:?--health-timeout: укажите секунды}"; shift 2 ;;
      --update-cli)       UPDATE_CLI=1; shift ;;
      --skip-db-dump)     SKIP_DB_DUMP=1; shift ;;
      --skip-volume)      SKIP_VOLUME=1; shift ;;
      --full-config)      FULL_CONFIG=1; shift ;;
      --yes|-y)           ASSUME_YES=1; shift ;;
      --no-rollback)      NO_ROLLBACK=1; shift ;;
      --dry-run)          DRY_RUN=1; shift ;;
      --no-color)         NO_COLOR=1; shift ;;
      --opensearch-data)  OPENSEARCH_DATA="${2:?--opensearch-data: keep|wipe|guide|ask}"; shift 2 ;;
      --pg-strategy)      PG_STRATEGY="${2:?--pg-strategy: restore|cancel|ask}"; shift 2 ;;
      --skip-mikrocata-check) SKIP_MIKROCATA_CHECK=1; shift ;;
      --help|-h)          usage; exit 0 ;;
      *)                  msg_err "Неизвестный аргумент: $1"; echo; usage; exit 1 ;;
    esac
  done
}

# ----------------------------- префлайт -------------------------------------
need_cmd() {
  command -v "$1" >/dev/null 2>&1 && return 0
  msg_err "Не найдена утилита «$1» — установите её и повторите."
  return 1
}

resolve_stamusctl() {
  if [ -n "${STAMUSCTL_PATH:-}" ] && [ -x "$STAMUSCTL_PATH" ]; then
    STAMUSCTL_BIN="$STAMUSCTL_PATH"
  elif command -v stamusctl >/dev/null 2>&1; then
    STAMUSCTL_BIN="$(command -v stamusctl)"
  else
    msg_err "Не найден stamusctl — это основной инструмент управления Clear NDR."
    msg_err "Установить:"
    msg_err "  wget https://dl.clearndr.io/stamusctl-linux-amd64"
    msg_err "  chmod +x stamusctl-linux-amd64 && sudo mv stamusctl-linux-amd64 /usr/local/bin/stamusctl"
    msg_err "или запустите скрипт с переменной STAMUSCTL_PATH=/путь/к/stamusctl"
    return 1
  fi
  msg_ok "stamusctl: $STAMUSCTL_BIN ($("$STAMUSCTL_BIN" version 2>/dev/null | head -1 || echo 'версия не определена'))"
}

find_instance() {
  if [ -n "$CONFIG_DIR_OPT" ]; then
    CONFIG_DIR="$CONFIG_DIR_OPT"
    [ -n "$INSTANCE_DIR" ] || INSTANCE_DIR="$(dirname "$CONFIG_DIR_OPT")"
  else
    [ -n "$INSTANCE_DIR" ] || INSTANCE_DIR="$PWD"
    CONFIG_DIR="$INSTANCE_DIR/config"
  fi
  if [ ! -d "$CONFIG_DIR" ]; then
    msg_err "Каталог конфигурации инстанса не найден: $CONFIG_DIR"
    msg_err "Запустите скрипт из каталога инстанса (родитель config/) или укажите --instance / --config-dir."
    msg_err "Список инстансов на этом хосте: stamusctl config list"
    return 1
  fi
  msg_ok "Каталог конфигурации: $CONFIG_DIR"
}

# ----------------------------- помощники стека ------------------------------
stack() {  # любая команда stamusctl compose/config — из каталога инстанса
  ( cd "$INSTANCE_DIR" && "$STAMUSCTL_BIN" "$@" )
}

stack_running() {  # запущен ли контейнер scirius (центральный сервис стека)
  docker ps --format '{{.Names}}' 2>/dev/null | grep -q -- '-scirius'
}

# Имена контейнеров Clear NDR: "<base-name>-<service>-<seed>" (например
# "config-scirius-FNISvONwp2TtteCD"); seed — суффикс шаблона, он же в volumes.
detect_seed() {
  local ct
  ct="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E -- '-scirius-[A-Za-z0-9_]+$' | head -1 || true)"
  printf '%s' "${ct##*-scirius-}"
}

find_db_volume() {  # имя docker volume с данными PostgreSQL (db-data-<seed>)
  local seed cand
  seed="$(detect_seed)"
  if [ -n "$seed" ]; then
    local exact
    exact="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -Fx -- "db-data-$seed" || true)"
    if [ -n "$exact" ]; then echo "$exact"; return 0; fi
  fi
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    echo "$cand"
    return 0
  done < <(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E -- '^db-data-[A-Za-z0-9_]+$' || true)
  local only
  only="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E -- 'db-data' || true)"
  if [ "$(echo "$only" | grep -c .)" -eq 1 ]; then
    msg_warn "Volume стека по имени не найден, использую единственный db-data: $only"
    echo "$only"
    return 0
  fi
  return 1
}

find_opensearch_volume() {  # opensearch-data-<seed>
  local seed cand
  seed="$(detect_seed)"
  if [ -n "$seed" ]; then
    local exact
    exact="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -Fx -- "opensearch-data-$seed" || true)"
    if [ -n "$exact" ]; then echo "$exact"; return 0; fi
  fi
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    echo "$cand"
    return 0
  done < <(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E -- '^opensearch-data-[A-Za-z0-9_]+$' || true)
  return 1
}

disk_free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
dir_size_kb()   { du -sk "$1" 2>/dev/null | awk '{print $1}'; }

# Тег образа компонента из compose-файлов каталога конфигурации.
img_tag_from_config() {  # $1 каталог, $2 подстрока имени образа (opensearch|postgres)
  grep -rhoE "image:[[:space:]]*[\"']?[^\"'[:space:]]*$2:[0-9][^\"'[:space:]]*" "$1" 2>/dev/null \
    | awk '{print $2}' | tr -d "\"'" | head -1
}
major_of() { echo "${1##*:}" | cut -d. -f1; }

# ----------------------------- шаги процедуры -------------------------------
preflight() {
  step "Проверка окружения"
  need_cmd docker; need_cmd curl; need_cmd tar; need_cmd gzip; need_cmd sha256sum; need_cmd date
  resolve_stamusctl
  find_instance
  docker ps >/dev/null 2>&1 || { msg_err "Docker недоступен (docker ps) — нужен запущенный Docker Engine."; exit 1; }
  msg_ok "Docker Engine доступен"

  # хост-предусловия OpenSearch (bootstrap-проверки внутри контейнера)
  local mm
  mm="$(sysctl -n vm.max_map_count 2>/dev/null || echo 0)"
  if [ "${mm:-0}" -lt 262144 ]; then
    msg_err "vm.max_map_count = ${mm:-0}, а OpenSearch требует >= 262144 — контейнер opensearch не стартует."
    msg_err "Исправить и сделать постоянным:"
    msg_err "  sudo sysctl -w vm.max_map_count=262144"
    msg_err "  echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-clearndr.conf"
    exit 1
  fi
  msg_ok "vm.max_map_count = $mm (>= 262144)"

  local avail_mb droot dfree
  avail_mb="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ "$avail_mb" -gt 0 ] && [ "$avail_mb" -lt 3072 ]; then
    msg_warn "Доступно памяти ${avail_mb} МБ — OpenSearch по шаблону просит heap 2 ГБ, при нехватке контейнер будет OOM-kill."
    msg_warn "Если обновление упадёт на opensearch: stamusctl config set opensearch.memory=1g && stamusctl compose up -d"
  fi
  droot="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  dfree="$(disk_free_kb "$droot")"
  if [ "${dfree:-0}" -lt $((5 * 1024 * 1024)) ]; then
    msg_err "Мало места на docker-хранилище ($droot): свободно $((dfree/1024)) МБ, нужно >= 5 ГБ (новые образы + работа OpenSearch)."
    exit 1
  fi
  msg_ok "Docker root $droot: свободно $((dfree/1024)) МБ"

  # текущая версия конфигурации/шаблона
  OLD_STACK_VERSION="$(stack config version 2>/dev/null | grep -Eo '[0-9]+(\.[0-9]+){2}[^[:space:]]*' | tail -1 || true)"
  [ -n "$OLD_STACK_VERSION" ] || OLD_STACK_VERSION="неизвестна"
  msg_ok "Текущая версия стека (config version): $OLD_STACK_VERSION"

  # теги образов текущего стека (для анализа совместимости)
  OLD_OS_TAG="$(img_tag_from_config "$CONFIG_DIR" opensearch || true)"
  OLD_PG_TAG="$(img_tag_from_config "$CONFIG_DIR" postgres || true)"
  [ -n "$OLD_OS_TAG" ] && msg_ok "OpenSearch сейчас: $OLD_OS_TAG"
  [ -n "$OLD_PG_TAG" ] && msg_ok "PostgreSQL сейчас: $OLD_PG_TAG"

  # значение suricata.interfaces — критично для интеграций (mikrocata2selks/tzsp0 и др.)
  OLD_SURICATA_INTERFACES="$(stack config get suricata.interfaces 2>/dev/null | tail -1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '"' | xargs || true)"
  [ -n "${OLD_SURICATA_INTERFACES:-}" ] && msg_ok "suricata.interfaces: $OLD_SURICATA_INTERFACES"

  # интеграция mikrocata2selks (MikroTik)
  detect_mikrocata

  # целевая версия
  if [ -z "$TARGET_VERSION" ]; then
    local latest
    latest="$(curl -fsSL --max-time 20 https://api.github.com/repos/StamusNetworks/stamusctl-templates/releases/latest 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
    if [ -n "$latest" ]; then
      TARGET_VERSION="$latest"
      msg_ok "Целевая версия: $TARGET_VERSION (последний релиз шаблона Clear NDR)"
    else
      TARGET_VERSION="latest"
      msg_warn "Не удалось определить последний релиз шаблона (GitHub недоступен?) — будет запрошена версия «latest»."
    fi
  else
    msg_ok "Целевая версия: $TARGET_VERSION"
  fi

  fetch_target_tags
}

# Теги образов целевой версии шаблона (ДО обновления — чтобы задать вопрос
# о данных без простоя). Тихо пропускается, если GitHub недоступен.
fetch_target_tags() {
  local ver="$TARGET_VERSION"; [ -z "$ver" ] || [ "$ver" = "latest" ] && ver="main"
  local base="https://raw.githubusercontent.com/StamusNetworks/stamusctl-templates/$ver/data/clearndr"
  TARGET_OS_TAG="$(curl -fsSL --max-time 20 "$base/events-stack/events-stack.compose.yaml" 2>/dev/null \
    | sed -n 's/.*image:[[:space:]]*opensearchproject\/opensearch:\([0-9][^[:space:]]*\).*/\1/p' | head -1 || true)"
  TARGET_PG_TAG="$(curl -fsSL --max-time 20 "$base/db/db.compose.yaml" 2>/dev/null \
    | sed -n 's/.*image:[[:space:]]*postgres:\([0-9][^[:space:]]*\).*/\1/p' | head -1 || true)"
  [ -n "${TARGET_OS_TAG:-}" ] && msg_ok "OpenSearch в целевом шаблоне: $TARGET_OS_TAG"
  [ -n "${TARGET_PG_TAG:-}" ] && msg_ok "PostgreSQL в целевом шаблоне: $TARGET_PG_TAG"
  return 0
}

# ----------------------------- интеграция mikrocata2selks -------------------
detect_mikrocata() {
  local hits=0
  compgen -G '/usr/local/bin/mikrocata*.py' >/dev/null 2>&1 && hits=1
  systemctl list-unit-files --no-legend 2>/dev/null | grep -q '^mikrocata' && hits=1
  compgen -G '/etc/systemd/network/tzsp*.netdev' >/dev/null 2>&1 && hits=1
  MIKROCATA=$hits
  if [ "$MIKROCATA" -eq 1 ]; then
    msg_ok "Обнаружена интеграция MikroTik (mikrocata2selks): mikrocata*.py / службы systemd / интерфейсы tzsp*"
  fi
  return 0
}

snapshot_mikrocata() {  # снапшот хост-файлов интеграции (docker-обновление их не трогает)
  [ "$MIKROCATA" -eq 1 ] || return 0
  [ "$DRY_RUN" -eq 1 ] && { msg_info "dry-run: снапшот интеграции MikroTik был бы записан в $BACKUP_DIR"; return 0; }
  step "Снапшот интеграции MikroTik (mikrocata2selks)"
  local out="$BACKUP_DIR/integration-mikrocata-$TS.tar.gz"
  local files=() rel=() f
  for f in /usr/local/bin/mikrocata*.py; do [ -e "$f" ] && files+=("$f"); done
  for f in /etc/systemd/system/mikrocata*.service; do [ -e "$f" ] && files+=("$f"); done
  [ -e "/etc/systemd/system/TZSPreplay@.service" ] && files+=("/etc/systemd/system/TZSPreplay@.service")
  for f in /etc/systemd/network/tzsp*.netdev /etc/systemd/network/tzsp*.network; do [ -e "$f" ] && files+=("$f"); done
  systemctl list-unit-files --no-legend 2>/dev/null | grep -E 'mikrocata|TZSP' \
    > "$BACKUP_DIR/integration-mikrocata-units-$TS.txt" || true
  if [ "${#files[@]}" -eq 0 ]; then
    msg_warn "Файлы интеграции не найдены — снапшот пропущен (список служб сохранён)"
    return 0
  fi
  for f in "${files[@]}"; do rel+=("${f#/}"); done
  if run_prog "Архив файлов интеграции MikroTik" tar czf "$out" -C / "${rel[@]}"; then
    chmod 600 "$out"
    msg_ok "Снапшот интеграции: $out ($(du -h "$out" | awk '{print $1}'))"
  else
    msg_warn "Не удалось заархивировать файлы интеграции (не критично — docker-обновление их не меняет)"
  fi
}

# suricata.interfaces — значение stamusctl, которое должен сохранять compose update;
# для mikrocata2selks это интерфейсы tzsp*. Проверяем и чиним ДО запуска стека.
verify_suricata_interfaces() {
  [ -n "${OLD_SURICATA_INTERFACES:-}" ] || return 0
  local now
  now="$(stack config get suricata.interfaces 2>/dev/null | tail -1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '"' | xargs || true)"
  if [ "${now:-}" = "$OLD_SURICATA_INTERFACES" ]; then
    msg_ok "suricata.interfaces сохранены после обновления: $now"
    return 0
  fi
  msg_warn "suricata.interfaces изменились: «$OLD_SURICATA_INTERFACES» → «${now:-пусто}» — восстанавливаю…"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: stamusctl config set suricata.interfaces=$OLD_SURICATA_INTERFACES"
    return 0
  fi
  if run_prog "Восстановление suricata.interfaces" stack config set "suricata.interfaces=$OLD_SURICATA_INTERFACES"; then
    msg_ok "suricata.interfaces восстановлены: $OLD_SURICATA_INTERFACES"
  else
    msg_err "Не удалось восстановить suricata.interfaces — задайте вручную: stamusctl config set suricata.interfaces=$OLD_SURICATA_INTERFACES"
    return 1
  fi
}

postcheck_mikrocata() {  # после обновления: службы, интерфейсы, suricata
  [ "$MIKROCATA" -eq 1 ] || return 0
  [ "$SKIP_MIKROCATA_CHECK" -eq 1 ] && { msg_info "проверка интеграции пропущена (--skip-mikrocata-check)"; return 0; }
  step "Проверка интеграции MikroTik (mikrocata2selks)"
  local bad=0 svc st ifn suri_ct tzsp_hits
  while read -r svc _; do
    [ -n "$svc" ] || continue
    st="$(systemctl is-active "$svc" 2>/dev/null || true)"
    if [ "$st" = "active" ]; then
      msg_ok "служба $svc: active"
    else
      msg_warn "служба $svc: ${st:-не найдена} — docker-обновление её не трогало; проверьте: systemctl status $svc"
      bad=1
    fi
  done < <(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '/^mikrocata/ {print $1}')
  local f
  for f in /etc/systemd/network/tzsp*.netdev; do
    [ -e "$f" ] || continue
    ifn="$(basename "$f" .netdev)"
    if ip link show "$ifn" >/dev/null 2>&1; then
      msg_ok "интерфейс $ifn: существует"
    else
      msg_warn "интерфейс $ifn: ОТСУТСТВУЕТ (systemd-networkd?) — проверьте: networkctl status $ifn"
      bad=1
    fi
  done
  suri_ct="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- '-suricata-[A-Za-z0-9_]+ ' | head -1 | awk '{print $1}' || true)"
  if [ -n "$suri_ct" ]; then
    tzsp_hits="$(docker logs --tail 100 "$suri_ct" 2>&1 | grep -ci tzsp || true)"
    if [ "${tzsp_hits:-0}" -gt 0 ]; then
      msg_ok "suricata работает с интерфейсами tzsp (упоминаний в журнале: $tzsp_hits)"
    else
      msg_warn "в журнале suricata нет упоминаний tzsp — если MikroTik-трафик пропал, проверьте: tcpdump -i tzsp0 и journalctl -u mikrocataTZSP0.service"
    fi
  fi
  if [ "$bad" -eq 0 ]; then
    msg_ok "Интеграция MikroTik: служба(ы)/интерфейсы на месте, suricata запущен"
  else
    msg_warn "Есть замечания по интеграции (выше). Docker-обновление Clear NDR файлы mikrocata не меняет."
  fi
  return 0
}

# ----------------------------- снимок состояния -----------------------------
snapshot() {
  step "Снимок текущего состояния"
  MANIFEST="$BACKUP_DIR/manifest-$TS.txt"
  local tmp; tmp="$(mktemp)"
  {
    echo "=== Clear NDR update manifest — $TS ==="
    echo "instance:      $INSTANCE_DIR"
    echo "config dir:    $CONFIG_DIR"
    echo "old version:   $OLD_STACK_VERSION"
    echo "target:        $TARGET_VERSION"
    echo "old opensearch: $OLD_OS_TAG"
    echo "old postgres:   $OLD_PG_TAG"
    echo "suricata.interfaces: $OLD_SURICATA_INTERFACES"
    echo "mikrocata2selks: $MIKROCATA"
    echo; echo "--- stamusctl version ---";        stack version 2>/dev/null || true
    echo; echo "--- stamusctl config version ---"; stack config version 2>/dev/null || true
    echo; echo "--- stamusctl config get ---";     stack config get 2>/dev/null || true
    echo; echo "--- docker ps (стек) ---"; docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | grep -E -- "-(scirius|db|suricata|nginx|opensearch|fluentd|osd|evebox|arkime|utils|rabbitmq|celery|cron|scout|ssl-keygen|setup-|suri-reloader|ownership-)" || echo "(стек не запущен)"
    echo; echo "--- docker images ---"; stack compose images 2>/dev/null || true
    echo; echo "--- docker volumes ---"; docker volume ls 2>/dev/null | grep -E -- '(opensearch-data|db-data|fluentd-pos|scirius-|arkime-|nginx-ssl|setup-ism|suricata-run)' || true
  } > "$tmp" 2>/dev/null || true
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: манифест был бы записан в $MANIFEST"
    rm -f "$tmp"
  else
    mv "$tmp" "$MANIFEST" && chmod 600 "$MANIFEST"
    msg_ok "Манифест состояния сохранён: $MANIFEST"
  fi
}

check_disk() {
  local need_kb free_kb check_path="$BACKUP_DIR"
  [ -e "$check_path" ] || check_path="$(dirname "$check_path")"
  need_kb=$(( $(dir_size_kb "$CONFIG_DIR") * 2 + 2 * 1024 * 1024 ))   # config×2 + 2 ГБ
  free_kb="$(disk_free_kb "$check_path")"
  if [ "${free_kb:-0}" -lt "$need_kb" ]; then
    msg_err "Мало места в $BACKUP_DIR: свободно $((free_kb/1024)) МБ, нужно ≥ $((need_kb/1024)) МБ."
    exit 1
  fi
  msg_ok "Достаточно места в $BACKUP_DIR (свободно $((free_kb/1024)) МБ)"
}

db_dump() {  # уровень 1: дамп PostgreSQL, пока стек жив
  [ "$SKIP_DB_DUMP" -eq 1 ] && { msg_warn "Дамп БД пропущен (--skip-db-dump)"; return 0; }
  step "Бэкап 1/3: дамп PostgreSQL (настройки правил, пользователи, токены)"
  local dbcid out
  out="$BACKUP_DIR/db-dump-$TS.sql.gz"
  dbcid="$(stack compose ps -q db 2>/dev/null | head -1 || true)"
  if [ -z "$dbcid" ]; then
    dbcid="$(docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null | grep -- '-db' | head -1 | awk '{print $1}' || true)"
  fi
  if [ -z "$dbcid" ]; then
    if stack_running; then
      msg_err "Стек запущен, но контейнер БД (db) не найден — дамп невозможен."
      exit 1
    fi
    msg_warn "Стек не запущен — дамп БД пропущен (настройки правил можно будет проверить в UI)."
    return 0
  fi
  DBUSER="$(docker exec "$dbcid" env 2>/dev/null | sed -n 's/^POSTGRES_USER=//p' | head -1)"
  DBUSER="${DBUSER:-selks}"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: docker exec <db> pg_dumpall -U $DBUSER | gzip > $out"
    return 0
  fi
  tick_start "Дамп PostgreSQL (pg_dumpall -U $DBUSER)"
  local drc=0
  docker exec "$dbcid" pg_dumpall -U "$DBUSER" 2>"$BACKUP_DIR/db-dump-$TS.err" | gzip > "$out" || drc="${PIPESTATUS[0]}"
  tick_stop "$drc"
  if [ "$drc" -eq 0 ]; then
    chmod 600 "$out"
    local rows; rows="$(zcat "$out" | grep -c 'CREATE TABLE' || true)"
    msg_ok "Дамп БД: $out ($(du -h "$out" | awk '{print $1}'), таблиц: ${rows:-0}, пользователь: $DBUSER)"
    if [ -s "$BACKUP_DIR/db-dump-$TS.err" ]; then
      msg_warn "Замечания pg_dumpall: $BACKUP_DIR/db-dump-$TS.err"
    fi
  else
    msg_err "Не удалось снять дамп БД — подробности: $BACKUP_DIR/db-dump-$TS.err"
    msg_err "Продолжение опасно: главный носитель настроек не сохранён."
    exit 1
  fi
}

# ----------------------------- решение по данным ----------------------------
print_os_convert_guide() {
  cat <<'EOF'
  Ручная конвертация данных OpenSearch между мажорными версиями (шаги):
    1. Снапшот со старой версии: настроить repository FS (path.repo в opensearch.yml +
       том для снапшотов), затем PUT _snapshot/backup и создать снапшот индексов.
    2. Поднять стек с новой версией, RESTORE снапшота и переиндексировать (reindex)
       индексы, созданные старой версией (OpenSearch 3.x не читает индексы < 2.0.0).
    3. Альтернатива: промежуточный шаблон с OpenSearch 2.x → дождаться зелёного
       кластера → переиндексация → обновление до 3.x.
    Документация: OpenSearch «Snapshot and restore», «Upgrade to OpenSearch 3.x».
  Обновление прервано БЕЗ изменений: стек продолжает работать в прежней версии.
EOF
}

# Решение о данных — ДО остановки стека (отмена/гид = нулевой простой).
decide_data_strategy() {
  step "Анализ совместимости данных (старая версия → целевой шаблон)"
  local old_m new_m

  # --- OpenSearch ---
  if [ -n "$OLD_OS_TAG" ] && [ -n "${TARGET_OS_TAG:-}" ]; then
    old_m="$(major_of "$OLD_OS_TAG")"; new_m="$(major_of "$TARGET_OS_TAG")"
    if [ "$old_m" != "$new_m" ]; then
      msg_warn "OpenSearch меняет мажорную версию: $OLD_OS_TAG → $TARGET_OS_TAG"
      msg_warn "Индексы событий старой версии могут быть несовместимы (3.x не читает индексы, созданные < 2.0.0)."
      case "$OPENSEARCH_DATA" in
        ask)
          if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
            cat <<'EOF'
  Что делать с данными событий OpenSearch?
    1) сохранить данные и продолжить (при несовместимости — автооткат, журналы в fail-logs)
    2) показать шаги ручной конвертации (снапшот/переиндексация) и прервать обновление
    3) обновиться с чистыми данными событий (том сохраняется в tar; настройки правил в PostgreSQL НЕ трогаются)
EOF
            local ans
            read -r -p "Выберите 1/2/3 [1]: " ans || ans="1"; ans="${ans:-1}"
            case "$ans" in
              2) print_os_convert_guide; exit 0 ;;
              3) WIPE_OS=1; msg_ok "Решение: обновиться с чистыми данными событий" ;;
              *) msg_ok "Решение: сохранить данные (автооткат при несовместимости)" ;;
            esac
          else
            msg_warn "Неинтерактивный режим: данные сохраняются по умолчанию (для очистки: --opensearch-data wipe)"
          fi ;;
        wipe)  WIPE_OS=1; msg_ok "Решение (--opensearch-data wipe): чистые данные событий, том в tar" ;;
        guide) print_os_convert_guide; exit 0 ;;
        keep)  msg_ok "Решение (--opensearch-data keep): сохранить данные" ;;
        *) msg_err "--opensearch-data: допустимо keep|wipe|guide|ask"; exit 1 ;;
      esac
      OS_DECIDED=1
    else
      msg_ok "OpenSearch: $OLD_OS_TAG → $TARGET_OS_TAG — мажорная версия не меняется, данные совместимы"
    fi
  else
    msg_warn "Версии OpenSearch определить не удалось (шаблон недоступен?) — решение будет принято после compose update"
  fi

  # --- PostgreSQL ---
  if [ -n "$OLD_PG_TAG" ] && [ -n "${TARGET_PG_TAG:-}" ]; then
    old_m="$(major_of "$OLD_PG_TAG")"; new_m="$(major_of "$TARGET_PG_TAG")"
    if [ "$old_m" != "$new_m" ]; then
      msg_warn "PostgreSQL меняет мажорную версию: $OLD_PG_TAG → $TARGET_PG_TAG"
      msg_warn "Старый том БД несовместим с новой версией — требуется пересоздание + восстановление из дампа."
      case "$PG_STRATEGY" in
        ask)
          if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
            cat <<'EOF'
  Что делать с данными PostgreSQL (настройки правил, пользователи, токены)?
    1) автоматически: пересоздать том и восстановить всё из дампа (рекомендуется; дамп уже снят)
    2) отменить обновление
EOF
            local ans
            read -r -p "Выберите 1/2 [1]: " ans || ans="1"; ans="${ans:-1}"
            case "$ans" in
              2) msg_info "Обновление отменено пользователем (несовместимость PostgreSQL). Стек не тронут."; exit 0 ;;
              *) RESTORE_DB=1; msg_ok "Решение: пересоздать том БД и восстановить из дампа" ;;
            esac
          else
            msg_warn "Неинтерактивный режим: том БД будет пересоздан и восстановлен из дампа (единственный рабочий путь при смене мажорной версии)"
            RESTORE_DB=1
          fi ;;
        restore) RESTORE_DB=1; msg_ok "Решение (--pg-strategy restore): пересоздать том и восстановить дамп" ;;
        cancel)  msg_info "Обновление отменено (--pg-strategy cancel). Стек не тронут."; exit 0 ;;
        *) msg_err "--pg-strategy: допустимо restore|cancel|ask"; exit 1 ;;
      esac
      PG_DECIDED=1
    else
      msg_ok "PostgreSQL: $OLD_PG_TAG → $TARGET_PG_TAG — мажорная версия не меняется, том совместим"
    fi
  fi
  return 0
}

# Повторная проверка ПО ФАКТИЧЕСКОЙ новой конфигурации (если целевые теги
# не удалось получить до обновления). Отмена здесь = восстановление config/.
recheck_strategy_after_update() {
  NEW_OS_TAG="$(img_tag_from_config "$CONFIG_DIR" opensearch || true)"
  NEW_PG_TAG="$(img_tag_from_config "$CONFIG_DIR" postgres || true)"
  local old_m new_m
  if [ "$OS_DECIDED" -eq 0 ] && [ -n "$OLD_OS_TAG" ] && [ -n "${NEW_OS_TAG:-}" ]; then
    old_m="$(major_of "$OLD_OS_TAG")"; new_m="$(major_of "$NEW_OS_TAG")"
    if [ "$old_m" != "$new_m" ]; then
      msg_warn "Подтверждено по новой конфигурации: OpenSearch $OLD_OS_TAG → $NEW_OS_TAG (мажорная версия)"
      case "$OPENSEARCH_DATA" in
        wipe) WIPE_OS=1 ;;
        guide) print_os_convert_guide; cancel_and_restore ;;
        *)
          if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
            local ans
            read -r -p "OpenSearch $old_m → $new_m: 1) сохранить данные  2) чистые данные событий  3) отменить обновление [1]: " ans || ans="1"; ans="${ans:-1}"
            case "$ans" in
              2) WIPE_OS=1 ;;
              3) cancel_and_restore ;;
              *) msg_ok "данные сохраняются" ;;
            esac
          else
            msg_warn "Неинтерактивный режим: данные сохраняются (автооткат при несовместимости)"
          fi ;;
      esac
      OS_DECIDED=1
    fi
  fi
  if [ "$PG_DECIDED" -eq 0 ] && [ -n "$OLD_PG_TAG" ] && [ -n "${NEW_PG_TAG:-}" ]; then
    old_m="$(major_of "$OLD_PG_TAG")"; new_m="$(major_of "$NEW_PG_TAG")"
    if [ "$old_m" != "$new_m" ]; then
      msg_warn "Подтверждено по новой конфигурации: PostgreSQL $OLD_PG_TAG → $NEW_PG_TAG (мажорная версия)"
      case "$PG_STRATEGY" in
        restore) RESTORE_DB=1 ;;
        cancel)  cancel_and_restore ;;
        *)
          if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
            local ans
            read -r -p "PostgreSQL $old_m → $new_m: 1) пересоздать том и восстановить дамп  2) отменить [1]: " ans || ans="1"; ans="${ans:-1}"
            case "$ans" in
              2) cancel_and_restore ;;
              *) RESTORE_DB=1 ;;
            esac
          else
            RESTORE_DB=1
          fi ;;
      esac
      PG_DECIDED=1
    fi
  fi
  return 0
}

cancel_and_restore() {
  msg_info "Отмена обновления — восстанавливаю прежнюю конфигурацию…"
  local cfg_archive="$BACKUP_DIR/config-$TS.tar.gz"
  if [ -s "$cfg_archive" ]; then
    stack compose down || true
    rm -rf "$CONFIG_DIR"
    tar xzf "$cfg_archive" -C "$INSTANCE_DIR"
    run_prog "Запуск прежнего стека" stack compose up -d || true
    msg_ok "Обновление отменено, прежняя конфигурация восстановлена и запущена"
  else
    msg_err "Архив config/ не найден ($cfg_archive) — восстановите вручную"
  fi
  exit 0
}

confirm_plan() {
  step "План обновления"
  cat <<EOF
  Инстанс:          $INSTANCE_DIR
  Версия стека:     $OLD_STACK_VERSION  ->  $TARGET_VERSION
  OpenSearch:       ${OLD_OS_TAG:-?} -> ${TARGET_OS_TAG:-?}   (данные: $( [ "$WIPE_OS" -eq 1 ] && echo "ОЧИСТИТЬ (события, том в tar)" || echo "сохранить" ))
  PostgreSQL:       ${OLD_PG_TAG:-?} -> ${TARGET_PG_TAG:-?}   (БД: $( [ "$RESTORE_DB" -eq 1 ] && echo "пересоздать + восстановить из дампа" || echo "сохранить (том)" ))
  Интеграция:       $( [ "$MIKROCATA" -eq 1 ] && echo "MikroTik/mikrocata2selks — снапшот + проверка" || echo "mikrocata2selks не обнаружена" )
  suricata.interfaces: ${OLD_SURICATA_INTERFACES:-—} (будут проверены/восстановлены)
  Бэкапы ->         $BACKUP_DIR  (pg-дамп: $([ $SKIP_DB_DUMP -eq 1 ] && echo НЕТ || echo ДА); config/: ДА; volume: $([ $SKIP_VOLUME -eq 1 ] && echo НЕТ || echo ДА))
  Обновление CLI:   $([ $UPDATE_CLI -eq 1 ] && echo "да (stamusctl)" || echo "нет")
  Проверки после:   контейнеры ${STACK_SERVICES[*]} + $HEALTH_URL $([ -n "$API_TOKEN" ] && echo "+ REST API по токену")
  Даунтайм:         да — стек будет остановлен на время обновления (обычно 2-10 минут)
EOF
  [ "$DRY_RUN" -eq 1 ] && { msg_ok "dry-run: изменений не будет"; return 0; }
  if [ "$ASSUME_YES" -eq 0 ]; then
    if [ ! -t 0 ]; then
      msg_err "Нет интерактивного терминала: подтвердите запуск флагом --yes."
      exit 1
    fi
    local ans
    read -r -p "Продолжить обновление с остановкой стека? [да/нет] " ans || ans="нет"
    case "$ans" in
      да|Д|д|y|Y|yes) ;;
      *) msg_info "Отменено пользователем."; exit 0 ;;
    esac
  else
    msg_info "Флаг --yes: подтверждение пропущено"
  fi
}

stop_stack() {
  if ! stack_running; then
    msg_warn "Стек сейчас не запущен — остановка не требуется."
    return 0
  fi
  mut_prog "Остановка стека (graceful, таймаут ${COMPOSE_STOP_TIMEOUT}с)" stack compose down --timeout "$COMPOSE_STOP_TIMEOUT" || {
    msg_warn "compose down вернул ошибку — пробую ещё раз без таймаута"
    mut_prog "Повторная остановка стека" stack compose down || true
  }
}

backup_config() {  # уровень 2: каталог config/
  step "Бэкап 2/3: каталог config/"
  local out="$BACKUP_DIR/config-$TS.tar.gz"
  local cfg_base cfg_name
  cfg_base="$(dirname "$CONFIG_DIR")"
  cfg_name="$(basename "$CONFIG_DIR")"
  local ex=()
  if [ "$FULL_CONFIG" -eq 0 ]; then
    ex=(--exclude="$cfg_name/events-stack/data" --exclude="$cfg_name/*/data" \
        --exclude="$cfg_name/*/pcap*" --exclude="$cfg_name/*/*.log" --exclude="$cfg_name/*/*.log.*" \
        --exclude="$cfg_name/*/*.pcap")
    msg_info "Исключены данные событий/pcap/логи (не настройки). Полный снимок: --full-config"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: tar czf $out ${ex[*]} -C $cfg_base $cfg_name"
    return 0
  fi
  tick_start "Архивация config/ ($(du -h "$CONFIG_DIR" 2>/dev/null | awk '{print $1}'))"
  local rc=0
  tar czf "$out" "${ex[@]}" -C "$cfg_base" "$cfg_name" || rc=$?
  tick_stop "$rc"
  if [ "$rc" -ne 0 ]; then
    msg_err "Не удалось заархивировать $CONFIG_DIR"; exit 1
  fi
  chmod 600 "$out"
  [ -s "$out" ] || { msg_err "Архив config/ пуст — продолжение опасно."; exit 1; }
  msg_ok "Архив config/: $out ($(du -h "$out" | awk '{print $1}'))"
}

backup_volume() {  # уровень 3: docker volume с данными БД
  [ "$SKIP_VOLUME" -eq 1 ] && { msg_warn "Бэкап volume пропущен (--skip-volume)"; return 0; }
  step "Бэкап 3/3: docker volume с данными PostgreSQL"
  local vol out
  vol="$(find_db_volume)" || { msg_warn "Volume db-data не найден — пропускаю (настройки сохранены в дампе и config/)"; return 0; }
  out="$BACKUP_DIR/volume-$vol-$TS.tar.gz"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: docker run --rm -v $vol:/src:ro -v $BACKUP_DIR:/dst alpine tar czf /dst/$(basename "$out") -C /src ."
    return 0
  fi
  if ! run_prog "Копия volume $vol" docker run --rm -v "$vol":/src:ro -v "$BACKUP_DIR":/dst alpine tar czf "/dst/$(basename "$out")" -C /src .; then
    msg_err "Не удалось снять копию volume $vol"; exit 1
  fi
  [ -s "$out" ] || { msg_err "Копия volume не создана ($out)"; exit 1; }
  chmod 600 "$out"
  msg_ok "Volume $vol: $out ($(du -h "$out" | awk '{print $1}'))"
}

update_cli() {
  [ "$UPDATE_CLI" -eq 1 ] || return 0
  step "Обновление stamusctl (CLI)"
  local arch url dl
  case "$(uname -m)" in
    x86_64)  arch="amd64" ;;
    aarch64) arch="arm64" ;;
    *) msg_warn "Архитектура $(uname -m) не поддерживается скриптом — обновите stamusctl вручную."; return 0 ;;
  esac
  url="https://dl.clearndr.io/stamusctl-linux-${arch}"
  dl="$BACKUP_DIR/stamusctl-linux-${arch}.$TS"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: curl -fSL -o $dl $url"
  else
    if ! run_prog "Загрузка stamusctl" curl -fsSL --max-time 300 -o "$dl" "$url"; then
      msg_warn "Не удалось скачать $url — оставляю текущий stamusctl."; rm -f "$dl"; return 0
    fi
  fi
  chmod +x "$dl" 2>/dev/null || true
  if [ "$DRY_RUN" -eq 0 ]; then
    if mv "$dl" "$(dirname "$STAMUSCTL_BIN")/stamusctl" 2>/dev/null; then
      STAMUSCTL_UPDATED="да ($(dirname "$STAMUSCTL_BIN")/stamusctl)"
      msg_ok "stamusctl обновлён: $("$STAMUSCTL_BIN" version 2>/dev/null | head -1)"
    else
      msg_warn "Не удалось заменить системный stamusctl (нужны права). Бинарник лежит здесь: $dl"
      msg_warn "Установите вручную: sudo mv $dl /usr/local/bin/stamusctl"
      STAMUSCTL_UPDATED="вручную: $dl"
    fi
  fi
}

do_compose_update() {  # stamusctl может спрашивать значения — подаём Enter (пустые строки)
  local rc=0
  yes '' | stack compose update --version "$TARGET_VERSION" || rc="${PIPESTATUS[1]}"
  return "$rc"
}

update_stack() {
  step "Обновление конфигурации: stamusctl compose update --version $TARGET_VERSION"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: stamusctl compose update --version $TARGET_VERSION"
  else
    if ! run_prog "Обновление конфигурации (пользовательские значения сохраняются)" do_compose_update; then
      msg_err "stamusctl compose update завершился ошибкой."
      return 1
    fi
  fi
  msg_ok "Конфигурация обновлена, значения сохранены stamusctl"

  step "Загрузка новых образов"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: stamusctl compose pull"
  else
    run_prog "Загрузка образов (это может занять несколько минут)" stack compose pull \
      || msg_warn "compose pull завершился с предупреждениями — продолжаю"
  fi
  NEW_STACK_VERSION="$(stack config version 2>/dev/null | grep -Eo '[0-9]+(\.[0-9]+){2}[^[:space:]]*' | tail -1 || echo '?')"
  return 0
}

# Чистка данных OpenSearch (по решению пользователя): том в tar, затем удаление.
wipe_opensearch_data() {
  [ "$WIPE_OS" -eq 1 ] || return 0
  step "Очистка данных событий OpenSearch (том сохраняется в tar)"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: копия и удаление volume $(find_opensearch_volume || echo 'opensearch-data-<seed>')"
    return 0
  fi
  local vol
  vol="$(find_opensearch_volume)" || { msg_warn "Volume opensearch-data не найден — чистить нечего"; return 0; }
  local out="$BACKUP_DIR/opensearch-data-$TS.tar.gz"
  local free_kb need_kb
  need_kb=$(($(dir_size_kb_docker "$vol") + 1024 * 1024))
  free_kb="$(disk_free_kb "$BACKUP_DIR")"
  if [ "${free_kb:-0}" -lt "$need_kb" ]; then
    msg_warn "Недостаточно места для копии volume $vol (~$((need_kb/1024/1024)) ГБ) — очистка БЕЗ копии."
    msg_warn "Продолжить очистку без резервной копии событий? История событий будет потеряна безвозвратно."
    if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
      local ans; read -r -p "Продолжить без копии? [нет/да] " ans || ans="нет"
      case "$ans" in да|Д|д|y|Y|yes) ;; *) msg_info "Очистка отменена — данные сохраняются."; WIPE_OS=0; return 0 ;; esac
    else
      msg_warn "--yes: продолжаю без копии (задайте --opensearch-data keep, чтобы сохранить данные)"
    fi
  else
    if ! run_prog "Копия volume $vol" docker run --rm -v "$vol":/src:ro -v "$BACKUP_DIR":/dst alpine tar czf "/dst/$(basename "$out")" -C /src .; then
      msg_warn "Копия volume не удалась — очистка отменена, данные сохраняются."
      WIPE_OS=0; return 0
    fi
    chmod 600 "$out"
    [ -s "$out" ] || { msg_warn "Копия volume пуста — очистка отменена."; WIPE_OS=0; return 0; }
    msg_ok "Копия событий: $out ($(du -h "$out" | awk '{print $1}'))"
  fi
  if run_prog "Удаление тома $vol" docker volume rm "$vol"; then
    msg_ok "Том $vol удалён — OpenSearch создаст свежие индексы (настройки правил в PostgreSQL НЕ затронуты)"
  else
    msg_err "Не удалось удалить том $vol — проверьте, что контейнеры opensearch остановлены."
    return 1
  fi
}

dir_size_kb_docker() {  # примерный размер volume через контейнер alpine
  docker run --rm -v "$1":/src:ro alpine sh -c 'du -sk /src 2>/dev/null' 2>/dev/null | awk '{print $1}' || echo 0
}

# Восстановление пользовательских файлов config/, исчезнувших при обновлении шаблона
# (универсальный механизм сохранения кастомизаций — свои файлы, правки, bind-цели).
restore_custom_files() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  local arch="$BACKUP_DIR/config-$TS.tar.gz"
  [ -s "$arch" ] || return 0
  local old_files f restored=0
  old_files="$(tar tzf "$arch" 2>/dev/null | grep -v '/$' | sed 's|^config/||' || true)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -e "$CONFIG_DIR/$f" ]; then
      if tar xzf "$arch" -C "$INSTANCE_DIR" "config/$f" 2>/dev/null; then
        msg_warn "Восстановлен пользовательский файл, отсутствующий в новой конфигурации: config/$f"
        restored=$((restored + 1))
      fi
    fi
  done <<< "$old_files"
  if [ "$restored" -gt 0 ]; then
    msg_ok "Восстановлено пользовательских файлов: $restored (проверьте их актуальность в новой версии)"
  else
    msg_ok "Пользовательские файлы config/ сохранены новой конфигурацией"
  fi
  return 0
}

wait_db_ready() {
  local el=0 id
  while [ "$el" -lt 90 ]; do
    id="$(stack compose ps -q db 2>/dev/null | head -1 || true)"
    if [ -n "$id" ] && docker exec "$id" pg_isready -U "$DBUSER" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3; el=$((el + 3))
  done
  return 1
}

# Пересоздание тома PostgreSQL + восстановление дампа (путь при смене major PG).
restore_pg_from_dump() {
  [ "$RESTORE_DB" -eq 1 ] || return 0
  step "Пересоздание тома PostgreSQL и восстановление настроек из дампа"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: удаление volume db-data, compose up -d db, psql < db-dump-$TS.sql.gz"
    return 0
  fi
  local vol
  vol="$(find_db_volume)" || { msg_err "Volume БД не найден — восстановление невозможно."; return 1; }
  if ! run_prog "Удаление тома БД $vol" docker volume rm "$vol"; then
    msg_err "Не удалось удалить том $vol (контейнер db должен быть остановлен)."; return 1
  fi
  if ! run_prog "Запуск службы db (новый том)" stack compose up -d db; then
    msg_err "Не удалось запустить службу db."; return 1
  fi
  if ! run_prog "Ожидание готовности PostgreSQL" wait_db_ready; then
    msg_err "PostgreSQL не стал готов за 90с — подробности: docker logs <db-контейнер>"; return 1
  fi
  local dbcid
  dbcid="$(stack compose ps -q db 2>/dev/null | head -1 || true)"
  local dump="$BACKUP_DIR/db-dump-$TS.sql.gz"
  if [ ! -s "$dump" ]; then
    msg_err "Дамп $dump отсутствует — восстановление невозможно (том БД уже пересоздан!)."
    msg_err "Настройки можно внести вручную либо откатить том: см. backups/volume-…-$TS.tar.gz"
    return 1
  fi
  if run_prog "Восстановление дампа PostgreSQL" bash -c "zcat '$dump' | docker exec -i '$dbcid' psql -U '$DBUSER' -d postgres"; then
    msg_ok "Настройки восстановлены в новый PostgreSQL ($NEW_PG_TAG)"
  else
    msg_err "Ошибка восстановления дампа — смотрите лог; дамп сохранён: $dump"
    return 1
  fi
  return 0
}

start_stack() {
  recheck_strategy_after_update
  verify_suricata_interfaces
  wipe_opensearch_data || return 1
  restore_custom_files
  restore_pg_from_dump || return 1
  step "Запуск стека"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: stamusctl compose up -d"
    return 0
  fi
  if ! run_prog "Запуск стека (compose up -d)" stack compose up -d; then
    msg_err "compose up -d завершился ошибкой."
    return 1
  fi
  msg_ok "Стек запускается…"
  return 0
}

# ----------------------------- проверки здоровья ----------------------------
clear_wait_line() {
  if [ "$IS_TTY" -eq 1 ] && [ "$HAS_TTY" -eq 1 ]; then
    printf '\r\033[K' > /dev/tty 2>/dev/null || true
  fi
}

render_wait_line() {  # $1 elapsed, $2 pending services, $3 http code
  local el="$1" p="$2" h="$3"
  if [ "$IS_TTY" -eq 1 ] && [ "$HAS_TTY" -eq 1 ]; then
    printf '\r\033[K  ⏳ ожидание стека (%ds): не готовы: %s; web: %s' \
      "$el" "${p:-—}" "$h" > /dev/tty 2>/dev/null || true
  elif [ "$el" -gt 0 ] && [ $((el % HEARTBEAT)) -eq 0 ]; then
    msg_info "ожидание стека (${el}с): не готовы: ${p:-—}; HTTP $h"
  fi
}

wait_healthy() {
  step "Проверки здоровья (лимит ${HEALTH_TIMEOUT}с)"
  local elapsed=0 interval=5 ok http=000 pending=""
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: ожидание готовности сервисов ${STACK_SERVICES[*]} и ответа $HEALTH_URL"
    return 0
  fi
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    ok=1; pending=""
    local s status names
    names="$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null || true)"
    for s in "${STACK_SERVICES[@]}"; do
      # имена контейнеров Clear NDR: "<base>-<service>-<seed>", строка: "<имя> Up …"
      status="$(echo "$names" | grep -E -- "-${s}-[A-Za-z0-9_]+ " | head -1 | awk '{print $2}')"
      if [ "$status" = "Up" ]; then :; else ok=0; pending+="${s} "; fi
    done
    http="$(curl -k -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || echo 000)"
    if [ "$ok" -eq 1 ] && { [ "$http" = "200" ] || [ "$http" = "302" ] || [ "$http" = "301" ]; }; then
      clear_wait_line
      msg_ok "Все сервисы ${STACK_SERVICES[*]} запущены; веб-интерфейс $HEALTH_URL отвечает (HTTP $http)"
      check_api_token || return 1
      show_recent_errors
      return 0
    fi
    render_wait_line "$elapsed" "$pending" "$http"
    sleep "$interval"; elapsed=$((elapsed + interval))
  done
  clear_wait_line
  msg_err "Стек не вышел на рабочий режим за ${HEALTH_TIMEOUT}с (не готовы: ${pending:-?}; HTTP $HEALTH_URL → $http)."
  return 1
}

check_api_token() {
  [ -n "$API_TOKEN" ] || { msg_info "Токен не задан — проверка REST API пропущена (можно: --token / env CLEAR_NDR_TOKEN)"; return 0; }
  local code body
  body="$(curl -k -s --max-time 15 -w '\n%{http_code}' "$HEALTH_URL/rest/rules/source/" -H "Authorization: Token $API_TOKEN" 2>/dev/null || true)"
  code="$(echo "$body" | tail -1)"
  if [ "$code" = "200" ]; then
    local count
    count="$(echo "$body" | head -n -1 | sed -n 's/.*"count"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
    msg_ok "REST API отвечает 200; источников правил в базе: ${count:-0} — настройки правил на месте"
    return 0
  fi
  msg_warn "REST API вернул HTTP ${code:-?} (ожидалось 200). Токен мог измениться либо UI ещё поднимается — проверьте вручную."
  return 0
}

show_recent_errors() {
  local scirius_ct
  scirius_ct="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E -- '-scirius-[A-Za-z0-9_]+ ' | head -1 | awk '{print $1}' || true)"
  [ -n "$scirius_ct" ] || return 0
  local errs
  errs="$(docker logs --tail "$SURICATA_LOG_TAIL" "$scirius_ct" 2>&1 | grep -iE 'traceback|error|critical|fatal' | grep -viE '0 errors|error-?s?[: ]*0|without error' | tail -5 || true)"
  if [ -n "$errs" ]; then
    msg_warn "Последние записи с «error» в журнале scirius (может быть шумом):"
    echo "$errs" | sed 's/^/    /'
  else
    msg_ok "Журнал scirius без ошибок"
  fi
}

report() {
  step "Итог"
  msg_ok "Обновление Clear NDR завершено: $OLD_STACK_VERSION -> ${NEW_STACK_VERSION:-$TARGET_VERSION}"
  msg_ok "Бэкапы (настройки) лежат в: $BACKUP_DIR"
  [ -n "$STAMUSCTL_UPDATED" ] && msg_ok "CLI stamusctl: обновлён ($STAMUSCTL_UPDATED)"
  [ "$MIKROCATA" -eq 1 ] && msg_ok "Интеграция MikroTik (mikrocata2selks): проверена (см. выше)"
  cat <<EOF
  Что дальше:
    1. Откройте веб-интерфейс ($HEALTH_URL) и проверьте Sources/Rulesets.
    2. Проверьте, что набор правил применяется: Suricata -> Update.
    3. Если интеграция MikroTik: проверьте поступление трафика (tcpdump -i tzsp0) и журнал mikrocata (journalctl -u mikrocataTZSP0.service).
    4. Храните каталог $BACKUP_DIR до полной проверки (дампы содержат секреты — права 600).
    5. После успешной проверки старые образы можно освободить: docker image prune -f
EOF
}

# ----------------------------- диагностика сбоя -----------------------------
# Сохраняет статус и журналы контейнеров ДО отката (compose down удаляет логи).
capture_failure_diagnostics() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  step "Диагностика сбоя: сохранение состояния и журналов контейнеров"
  local diag_dir="$BACKUP_DIR/fail-logs-$TS"
  mkdir -p "$diag_dir"
  {
    docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null \
      | grep -E -- '-(scirius|db|suricata|nginx|opensearch|fluentd|osd|evebox|arkime|rabbitmq|suri-reloader|socat|utils|celery|cron|scout|ssl-keygen|setup-|ownership)-[A-Za-z0-9_]+[[:space:]]'
  } > "$diag_dir/summary.txt" 2>/dev/null || true
  while IFS=$'\t' read -r name status image; do
    [ -n "$name" ] || continue
    docker logs --tail 150 "$name" > "$diag_dir/$name.log" 2>&1 || true
    if echo "$status" | grep -q 'health'; then
      docker inspect --format '{{json .State.Health}}' "$name" > "$diag_dir/$name.health.json" 2>/dev/null || true
    fi
  done < "$diag_dir/summary.txt"
  if [ -s "$diag_dir/summary.txt" ]; then
    msg_info "Состояние контейнеров стека:"
    sed 's/^/    /' "$diag_dir/summary.txt" || true
  fi
  local os_log hint=""
  os_log="$(ls "$diag_dir"/*opensearch*.log 2>/dev/null | grep -v dashboards | head -1 || true)"
  if [ -n "$os_log" ] && [ -s "$os_log" ]; then
    if grep -q 'minimum compatible version\|was created with version' "$os_log"; then
      hint="OpenSearch не принял данные: в volume есть индексы, созданные версией < 2.0.0 (старые данные событий).
    Варианты: (а) повторить обновление с --opensearch-data wipe — история событий будет потеряна,
    настройки правил в PostgreSQL сохраняются; (б) промежуточное обновление на шаблон с OpenSearch 2.x + переиндексация."
    elif grep -q 'max_map_count' "$os_log"; then
      hint="На хосте vm.max_map_count < 262144. Исправить: sudo sysctl -w vm.max_map_count=262144;
    echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-clearndr.conf — затем stamusctl compose up -d"
    elif grep -qiE 'OutOfMemory|Cannot allocate memory' "$os_log" || docker ps -a --format '{{.Status}}' 2>/dev/null | grep -q '137'; then
      hint="OpenSearch убит по памяти (OOM). Уменьшить heap: stamusctl config set opensearch.memory=1g, затем stamusctl compose up -d"
    elif grep -qiE 'flood-stage|disk usage exceeded|disk watermark' "$os_log"; then
      hint="Не хватает места на диске (disk watermark). Освободите место и повторите stamusctl compose up -d"
    elif grep -qiE 'failed to obtain node lock|NodeLock' "$os_log"; then
      hint="Данные opensearch заняты другим контейнером/процессом. Проверьте docker ps -a на дубли opensearch"
    else
      hint="Причина по журналу opensearch не опознана — смотрите полный журнал в $diag_dir"
    fi
    msg_warn "Вероятная причина:
    $hint"
  fi
  msg_ok "Диагностика сохранена: $diag_dir"
}

rollback() {
  local cause="$1"
  step "ОТКАТ: $cause"
  [ "$NO_ROLLBACK" -eq 1 ] && { msg_warn "Откат отключён (--no-rollback) — выход."; return 2; }
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: откат — restore config/ из $BACKUP_DIR/config-$TS.tar.gz, затем compose up -d"
    return 2
  fi
  local cfg_archive="$BACKUP_DIR/config-$TS.tar.gz"
  [ -s "$cfg_archive" ] || { msg_err "Архив config/ для отката не найден: $cfg_archive"; return 2; }
  stack compose down || true
  local broken="$INSTANCE_DIR/config.failed-$TS"
  mv "$CONFIG_DIR" "$broken" && msg_info "Текущий (сломанный) config/ перемещён в $broken"
  if tar xzf "$cfg_archive" -C "$INSTANCE_DIR"; then
    msg_ok "config/ восстановлен из архива"
    if run_prog "Запуск прежнего стека" stack compose up -d; then
      msg_ok "Команда запуска выполнена"
    else
      msg_warn "compose up завершился ошибкой (см. ниже/в логе)"
    fi
    # проверяем, что прежний стек действительно поднялся (а не печатаем ОК вслепую)
    local rb_wait=0 rb_all_up=0 s rb_st
    while [ "$rb_wait" -lt 120 ]; do
      rb_all_up=1
      for s in "${STACK_SERVICES[@]}"; do
        rb_st="$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null \
          | grep -E -- "-${s}-[A-Za-z0-9_]+ " | head -1 | awk '{print $2}')"
        [ "$rb_st" = "Up" ] || rb_all_up=0
      done
      [ "$rb_all_up" -eq 1 ] && break
      sleep 10; rb_wait=$((rb_wait + 10))
    done
    if [ "$rb_all_up" -eq 1 ]; then
      msg_ok "Стек поднят в прежней конфигурации ($OLD_STACK_VERSION): сервисы ${STACK_SERVICES[*]} — Up"
    else
      msg_warn "Стек поднят в прежней конфигурации ($OLD_STACK_VERSION), но не все сервисы Up за ${rb_wait}с."
      capture_failure_diagnostics
      print_emergency_recovery
    fi
    cat <<EOF
  Важно: данные PostgreSQL (volume) НЕ откатывались. Если UI/правила работают некорректно,
  восстановите БД из дампа:
    stamusctl compose up -d db
    zcat $BACKUP_DIR/db-dump-$TS.sql.gz | docker exec -i \$(stamusctl compose ps -q db) psql -U $DBUSER -d postgres
    stamusctl compose restart
EOF
    return 2
  else
    msg_err "Не удалось распаковать архив config/ — восстановите вручную из $cfg_archive"
    return 2
  fi
}

print_emergency_recovery() {
  cat <<'EOF'
  ЭКСТРЕННОЕ ВОССТАНОВЛЕНИЕ: opensearch не поднимается даже в прежней конфигурации.
  Частые причины и шаги (подробно: docs/clearndr-update.md, §8.1):
    1) Точная причина: docker logs --tail 100 <имя-контейнера-opensearch>
    2) Место на диске: df -h /var/lib/docker; освободить: docker image prune -f
    3) vm.max_map_count: sysctl vm.max_map_count  (нужно >= 262144)
    4) Несовместимые данные событий (OpenSearch менял мажорную версию):
       docker volume ls | grep opensearch-data
       docker run --rm -v <том>:/src:ro -v /opt/ClearNDR/backups:/dst alpine tar czf /dst/os-events-backup.tar.gz -C /src .
       docker volume rm <том>
       stamusctl compose up -d
       (история событий теряется; настройки правил в PostgreSQL НЕ теряются)
EOF
}

finalize_backups() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  local dir="$BACKUP_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$dir" && find . -maxdepth 1 -type f \( -name "*-$TS.tar.gz" -o -name "db-dump-$TS.sql.gz" \) -exec sha256sum {} \; > "SHA256SUMS-$TS.txt" ) || true
    chmod 600 "$dir/SHA256SUMS-$TS.txt" 2>/dev/null || true
    msg_ok "Контрольные суммы: $dir/SHA256SUMS-$TS.txt"
  fi
}

# ----------------------------- главная --------------------------------------
main() {
  local exit_code=0
  parse_args "$@"
  printf "Обновление Clear NDR Community — %s\n" "$(date '+%Y-%m-%d %H:%M:%S')"

  preflight

  if [ -n "$BACKUP_DIR_OPT" ]; then
    BACKUP_DIR="$BACKUP_DIR_OPT"
  else
    BACKUP_DIR="$INSTANCE_DIR/backups"
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR" || { msg_err "Не создать каталог бэкапов: $BACKUP_DIR"; exit 1; }
  fi
  open_log "$BACKUP_DIR/update-$TS.log"
  check_disk
  snapshot
  db_dump            # пока стек жив
  decide_data_strategy   # ДО остановки: вопросы о данных, отмена = нулевой простой
  confirm_plan
  stop_stack
  backup_config
  backup_volume
  snapshot_mikrocata
  update_cli
  if update_stack && start_stack && wait_healthy; then
    finalize_backups
    postcheck_mikrocata
    report
    exit 0
  else
    finalize_backups
    capture_failure_diagnostics   # ДО отката: compose down удалит контейнеры и их журналы
    rollback "обновление не прошло проверки здоровья" || exit_code=$?
    msg_err "Обновление НЕ завершено. Подробности: ${LOG_FILE:-stdout}; бэкапы: $BACKUP_DIR"
    msg_err "Журналы контейнеров на момент сбоя: $BACKUP_DIR/fail-logs-$TS/; сломанный config/: $INSTANCE_DIR/config.failed-$TS"
    exit 2
  fi
}

main "$@"
