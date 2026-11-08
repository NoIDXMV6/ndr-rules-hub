#!/usr/bin/env bash
# ============================================================================
# clearndr-update.sh — обновление установленного Clear NDR Community
# (docker-стек под управлением stamusctl) на новую версию с сохранением
# всех настроек.
#
# Основано на официальной документации Stamus Networks (Clear NDR):
#   https://docs.clearndr.io/docs/start/common-operations   (upgrade-процедура)
#   https://docs.clearndr.io/docs/stamusctl/compose/update  (команда update)
#   https://github.com/StamusNetworks/stamusctl             (CLI, команды compose/config)
#
# Процедура штатного обновления, которой следует скрипт:
#   stamusctl compose update [--version VER]   # новый шаблон + сохранение пользовательских значений
#   stamusctl compose pull                     # свежие образы
#   stamusctl compose up -d                    # перезапуск стека
#
# Что сохраняется (3 уровня бэкапа):
#   1. pg_dumpall PostgreSQL (сервис db, POSTGRES_USER=selks) — ДО остановки стека.
#      Это «мозг» Clear NDR: источники правил, наборы (rulesets), включённые категории,
#      remap SID, пороги/подавления, пользователи и API-токены.
#   2. Каталог config/ инстанса — ПОСЛЕ остановки стека: compose-файлы, конфиги
#      Suricata/nginx/fluentd, TLS-сертификаты, значения stamusctl (config get).
#      По умолчанию исключаются большие данные (OpenSearch-индексы, pcap, логи) —
#      они не являются настройками; флаг --full-config включает всё.
#   3. Docker volume <project>_db-data (сырые файлы PostgreSQL) — по умолчанию
#      включён, флаг --skip-volume отключает.
#
# При неудаче после обновления скрипт автоматически откатывает config/ из архива
# и заново поднимает стек (данные БД при откате не трогаются; точечное
# восстановление из дампа описано в docs/clearndr-update.md).
#
# Примеры:
#   sudo ./clearndr-update.sh                              # до последней версии
#   sudo ./clearndr-update.sh --version 1.2.0              # до конкретной версии
#   ./clearndr-update.sh --dry-run                         # показать план без изменений
#   sudo ./clearndr-update.sh --yes --update-cli           # ещё и обновить stamusctl
#   sudo ./clearndr-update.sh --instance /opt/clearndr     # если запуск не из каталога инстанса
#
# Коды выхода: 0 — успех; 1 — ошибка предпроверки/отмена; 2 — неудача обновления
# (после попытки отката).
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

STACK_SERVICES=(scirius db suricata nginx)   # критичные сервисы стека
COMPOSE_STOP_TIMEOUT=90
SURICATA_LOG_TAIL=40

STAMUSCTL_BIN=""             # резолвится в preflight
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=""
LOG_FILE=""
STAMUSCTL_UPDATED=""
OLD_STACK_VERSION=""
NEW_STACK_VERSION=""

# ----------------------------- вывод и логирование --------------------------
C_INFO="\033[1;34m"; C_OK="\033[1;32m"; C_WARN="\033[1;33m"; C_ERR="\033[1;31m"; C_OFF="\033[0m"
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

# Выполнить мутирующую команду (с учётом --dry-run).
mut() {
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: $*"
    return 0
  fi
  "$@"
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
    # стандартная раскладка: <instance>/config
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

# project name docker compose (для поиска volume): берём из имени контейнера
# вида "<project>-scirius-1"; иначе — имя каталога инстанса.
detect_project() {
  local name
  name="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -- '-scirius' | head -1 || true)"
  if [ -z "$name" ]; then
    name="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -- '-scirius' | head -1 || true)"
  fi
  if [ -n "$name" ]; then
    printf '%s' "${name%-scirius-1}"
    return 0
  fi
  printf '%s' "$(basename "$INSTANCE_DIR")"
}

find_db_volume() {  # имя docker volume с данными PostgreSQL стека
  local project cand
  project="$(detect_project)"
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    echo "$cand"
    return 0
  done < <(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E "(^|[-_])${project}[-_]db-data$" || true)
  # fallback: единственный db-data на хосте
  local only
  only="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep 'db-data$' || true)"
  if [ "$(echo "$only" | grep -c .)" -eq 1 ]; then
    msg_warn "Volume стека по имени проекта не найден, использую единственный db-data: $only"
    echo "$only"
    return 0
  fi
  return 1
}

disk_free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
dir_size_kb()   { du -sk "$1" 2>/dev/null | awk '{print $1}'; }

# ----------------------------- шаги процедуры -------------------------------
preflight() {
  step "Проверка окружения"
  need_cmd docker; need_cmd curl; need_cmd tar; need_cmd gzip; need_cmd sha256sum; need_cmd date
  resolve_stamusctl
  find_instance
  docker ps >/dev/null 2>&1 || { msg_err "Docker недоступен (docker ps) — нужен запущенный Docker Engine."; exit 1; }
  msg_ok "Docker Engine доступен"

  # текущая версия конфигурации/шаблона
  OLD_STACK_VERSION="$(stack config version 2>/dev/null | tail -1 | awk '{print $NF}' || true)"
  [ -n "$OLD_STACK_VERSION" ] || OLD_STACK_VERSION="неизвестна"
  msg_ok "Текущая версия стека (config version): $OLD_STACK_VERSION"

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
}

snapshot() {  # снимок состояния до изменений — попадает в манифест
  step "Снимок текущего состояния"
  MANIFEST="$BACKUP_DIR/manifest-$TS.txt"
  local tmp; tmp="$(mktemp)"
  {
    echo "=== Clear NDR update manifest — $TS ==="
    echo "instance:      $INSTANCE_DIR"
    echo "config dir:    $CONFIG_DIR"
    echo "old version:   $OLD_STACK_VERSION"
    echo "target:        $TARGET_VERSION"
    echo; echo "--- stamusctl version ---";        stack version 2>/dev/null || true
    echo; echo "--- stamusctl config version ---"; stack config version 2>/dev/null || true
    echo; echo "--- stamusctl config get ---";     stack config get 2>/dev/null || true
    echo; echo "--- docker ps (стек) ---"; docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | grep -E -- "-(scirius|db|suricata|nginx|opensearch|fluentd|osd|evebox|arkime|utils)" || echo "(стек не запущен)"
    echo; echo "--- docker images ---"; stack compose images 2>/dev/null || true
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
  # в dry-run каталог бэкапа ещё не создан — проверяем по родителю
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
  local dbcid dbuser out
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
  dbuser="$(docker exec "$dbcid" env 2>/dev/null | sed -n 's/^POSTGRES_USER=//p' | head -1)"
  dbuser="${dbuser:-selks}"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: docker exec <db> pg_dumpall -U $dbuser | gzip > $out"
    return 0
  fi
  if docker exec "$dbcid" pg_dumpall -U "$dbuser" 2>"$BACKUP_DIR/db-dump-$TS.err" | gzip > "$out"; then
    chmod 600 "$out"
    local rows; rows="$(zcat "$out" | grep -c 'CREATE TABLE' || true)"
    msg_ok "Дамп БД: $out ($(du -h "$out" | awk '{print $1}'), таблиц: ${rows:-0}, пользователь: $dbuser)"
    if [ -s "$BACKUP_DIR/db-dump-$TS.err" ]; then
      msg_warn "Замечания pg_dumpall: $BACKUP_DIR/db-dump-$TS.err"
    fi
  else
    msg_err "Не удалось снять дамп БД — подробности: $BACKUP_DIR/db-dump-$TS.err"
    msg_err "Продолжение опасно: главный носитель настроек не сохранён."
    exit 1
  fi
}

confirm_plan() {
  step "План обновления"
  cat <<EOF
  Инстанс:          $INSTANCE_DIR
  Версия стека:     $OLD_STACK_VERSION  ->  $TARGET_VERSION
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
  step "Остановка стека (graceful, таймаут ${COMPOSE_STOP_TIMEOUT}с)"
  if ! stack_running; then
    msg_warn "Стек сейчас не запущен — остановка не требуется."
    return 0
  fi
  mut stack compose down --timeout "$COMPOSE_STOP_TIMEOUT" || {
    msg_warn "compose down вернул ошибку — пробую ещё раз без таймаута"
    mut stack compose down || true
  }
  msg_ok "Стек остановлен"
}

backup_config() {  # уровень 2: каталог config/
  step "Бэкап 2/3: каталог config/"
  local out="$BACKUP_DIR/config-$TS.tar.gz"
  local cfg_base cfg_name
  cfg_base="$(dirname "$CONFIG_DIR")"
  cfg_name="$(basename "$CONFIG_DIR")"
  local ex=()
  if [ "$FULL_CONFIG" -eq 0 ]; then
    # большие данные, не являющиеся настройками (индексы событий, pcap, логи)
    ex=(--exclude="$cfg_name/events-stack/data" --exclude="$cfg_name/*/data" \
        --exclude="$cfg_name/*/pcap*" --exclude="$cfg_name/*/*.log" --exclude="$cfg_name/*/*.log.*" \
        --exclude="$cfg_name/*/*.pcap")
    msg_info "Исключены данные событий/pcap/логи (не настройки). Полный снимок: --full-config"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: tar czf $out ${ex[*]} -C $cfg_base $cfg_name"
  else
    tar czf "$out" "${ex[@]}" -C "$cfg_base" "$cfg_name" \
      || { msg_err "Не удалось заархивировать $CONFIG_DIR"; exit 1; }
    chmod 600 "$out"
    [ -s "$out" ] || { msg_err "Архив config/ пуст — продолжение опасно."; exit 1; }
    msg_ok "Архив config/: $out ($(du -h "$out" | awk '{print $1}'))"
  fi
}

backup_volume() {  # уровень 3: docker volume с данными БД
  [ "$SKIP_VOLUME" -eq 1 ] && { msg_warn "Бэкап volume пропущен (--skip-volume)"; return 0; }
  step "Бэкап 3/3: docker volume с данными PostgreSQL"
  local vol out
  vol="$(find_db_volume)" || { msg_warn "Volume db-data не найден — пропускаю (настройки сохранены в дампе и config/)"; return 0; }
  out="$BACKUP_DIR/volume-$vol-$TS.tar.gz"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: docker run --rm -v $vol:/src:ro -v $BACKUP_DIR:/dst alpine tar czf /dst/$(basename "$out") -C /src ."
  else
    docker run --rm -v "$vol":/src:ro -v "$BACKUP_DIR":/dst alpine tar czf "/dst/$(basename "$out")" -C /src . \
      || { msg_err "Не удалось снять копию volume $vol"; exit 1; }
    [ -s "$out" ] || { msg_err "Копия volume не создана ($out)"; exit 1; }
    chmod 600 "$out"
    msg_ok "Volume $vol: $out ($(du -h "$out" | awk '{print $1}'))"
  fi
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
  mut curl -fSL --max-time 300 -o "$dl" "$url" || { msg_warn "Не удалось скачать $url — оставляю текущий stamusctl."; rm -f "$dl"; return 0; }
  mut chmod +x "$dl"
  if [ "$DRY_RUN" -eq 0 ]; then
    if mv "$dl" "$(dirname "$STAMUSCTL_BIN")/stamusctl" 2>/dev/null; then
      STAMUSCTL_UPDATED="да ($(dirname "$STAMUSCTL_BIN")/stamusctl)"
      msg_ok "stamusctl обновлён: $("$STAMUSCTL_BIN" version 2>/dev/null | head -1)"
    else
      msg_warn "Не удалось заменить системный stamusctl (нужны права). Бинарник лежит здесь: $dl"
      msg_warn "Установите вручную: sudo mv $dl /usr/local/bin/stamusctl"
      STAMUSCTL_UPDATED="вручную: $dl"
    fi
  else
    msg_info "dry-run: замена $(command -v stamusctl) на $dl"
  fi
}

update_stack() {
  step "Обновление стека: stamusctl compose update --version $TARGET_VERSION"
  # compose update может спрашивать значения конфигурации (Enter = принять
  # текущие/дефолтные). В неинтерактивном режиме подаём пустые строки.
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: stamusctl compose update --version $TARGET_VERSION"
  elif [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
    local rc_stamus=0
    yes '' | stack compose update --version "$TARGET_VERSION" || rc_stamus="${PIPESTATUS[1]:-1}"
    # оцениваем только статус самого stamusctl (yes умирает по SIGPIPE)
    if [ "$rc_stamus" -ne 0 ]; then
      msg_err "stamusctl compose update завершился ошибкой (код $rc_stamus)."
      return 1
    fi
  else
    stack compose update --version "$TARGET_VERSION" \
      || { msg_err "stamusctl compose update завершился ошибкой."; return 1; }
  fi
  msg_ok "Конфигурация обновлена, пользовательские значения сохранены stamusctl"

  step "Загрузка новых образов (stamusctl compose pull)"
  mut stack compose pull || msg_warn "compose pull завершился с предупреждениями — продолжаю"
  NEW_STACK_VERSION="$(stack config version 2>/dev/null | tail -1 | awk '{print $NF}' || echo '?')"

  step "Запуск стека (stamusctl compose up -d)"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: stamusctl compose up -d"
  else
    stack compose up -d || { msg_err "compose up -d завершился ошибкой."; return 1; }
  fi
  msg_ok "Стек запускается…"
  return 0
}

wait_healthy() {
  step "Проверки здоровья (лимит ${HEALTH_TIMEOUT}с)"
  local elapsed=0 interval=5 ok http=000
  if [ "$DRY_RUN" -eq 1 ]; then
    msg_info "dry-run: ожидание готовности сервисов ${STACK_SERVICES[*]} и ответа $HEALTH_URL"
    return 0
  fi
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    ok=1
    local s status names
    names="$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null || true)"
    for s in "${STACK_SERVICES[@]}"; do
      status="$(echo "$names" | grep -E -- "-${s}(-1)?( |$)" | head -1 | awk '{print $2}')"
      [ "$status" = "Up" ] || ok=0
    done
    http="$(curl -k -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || echo 000)"
    if [ "$ok" -eq 1 ] && { [ "$http" = "200" ] || [ "$http" = "302" ] || [ "$http" = "301" ]; }; then
      msg_ok "Все сервисы ${STACK_SERVICES[*]} запущены; веб-интерфейс $HEALTH_URL отвечает (HTTP $http)"
      check_api_token || return 1
      show_recent_errors
      return 0
    fi
    sleep "$interval"; elapsed=$((elapsed + interval))
  done
  msg_err "Стек не вышел на рабочий режим за ${HEALTH_TIMEOUT}с (сервисы: см. выше; HTTP $HEALTH_URL → $http)."
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
  return 0   # не считаем это фатальным для отката
}

show_recent_errors() {
  local scirius_ct
  scirius_ct="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -- '-scirius' | head -1 || true)"
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
  cat <<EOF
  Что дальше:
    1. Откройте веб-интерфейс ($HEALTH_URL) и проверьте Sources/Rulesets.
    2. Проверьте, что набор правил применяется: Suricata -> Update.
    3. Храните каталог $BACKUP_DIR до полной проверки (дампы содержат секреты — права 600).
    4. После успешной проверки старые образы можно освободить: docker image prune -f
EOF
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
    stack compose up -d || true
    msg_ok "Стек поднят в прежней конфигурации ($OLD_STACK_VERSION)"
    cat <<EOF
  Важно: данные PostgreSQL (volume) НЕ откатывались. Если UI/правила работают некорректно,
  восстановите БД из дампа:
    stamusctl compose up -d db
    zcat $BACKUP_DIR/db-dump-$TS.sql.gz | docker exec -i \$(stamusctl compose ps -q db) psql -U ${dbuser:-selks} -d postgres
    stamusctl compose restart
EOF
    return 2
  else
    msg_err "Не удалось распаковать архив config/ — восстановите вручную из $cfg_archive"
    return 2
  fi
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
  confirm_plan
  stop_stack
  backup_config
  backup_volume
  update_cli
  if update_stack && wait_healthy; then
    finalize_backups
    report
    exit 0
  else
    finalize_backups
    rollback "обновление не прошло проверки здоровья" || exit_code=$?
    msg_err "Обновление НЕ завершено. Подробности: ${LOG_FILE:-stdout}; бэкапы: $BACKUP_DIR"
    exit 2
  fi
}

main "$@"
