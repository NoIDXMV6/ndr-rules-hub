#!/usr/bin/env bash
# ============================================================================
# test-clearndr-update-mock.sh — мок-стенд для scripts/clearndr-update.sh (v3).
# Сценарии:
#   1) unit-паттерны имён контейнеров (<base>-<svc>-<seed>);
#   2) preflight: vm.max_map_count < 262144 -> отказ;
#   3) полный цикл: смена мажорных версий opensearch/postgres (неинтерактивные
#      дефолты: keep + restore PG из дампа), восстановление пользовательского
#      файла config/, восстановление suricata.interfaces, чистый вывод (без
#      кадров прогресса docker), интеграция MikroTik (mikrocata2selks);
#   4) сбой compose up: диагностика fail-logs + причина + автооткат;
#   5) --no-rollback;
#   6) --opensearch-data wipe: копия volume в tar + удаление тома;
#   7) --opensearch-data guide: подсказки по конвертации, стек не тронут.
# Моки: docker, stamusctl, sysctl, curl, systemctl, ip (подставляются через PATH).
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/clearndr-update.sh"
WORK="$HERE/.tmp-mock-$$"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check_rc() { [ "$1" = "$2" ] && ok "$3 (rc=$1)" || bad "$3 (ожидался rc=$2, получен $1)"; }
contains() { echo "$1" | grep -qF -- "$2" && ok "$3" || bad "$3 (не найдено: $2)"; }
not_contains() { echo "$1" | grep -qF -- "$2" && bad "$3 (найдено лишнее: $2)" || ok "$3"; }

SEED="FNISvONwp2TtteCD"

setup_mocks() {
  mkdir -p "$WORK/bin" "$WORK/instance/config" "$WORK/backups" "$WORK/logs"
  cat > "$WORK/instance/config/docker-compose.yml" <<EOF
services:
  opensearch:
    image: opensearchproject/opensearch:2.5.0
  db:
    image: postgres:16
EOF
  echo "custom mikrotik setting" > "$WORK/instance/config/custom-mikrotik.conf"
  echo "tzsp0" > "$WORK/bin/interfaces-value"
  echo "$WORK/bin/state" > "$WORK/bin/state-path"
  echo ok > "$WORK/bin/state"
  echo "" > "$WORK/bin/logs-dir"

  # ---- мок docker ----
  cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
MOCKBIN="$(dirname "$(command -v docker)")"
STATE_PATH="$(cat "$MOCKBIN/state-path" 2>/dev/null || echo "")"
STATE="$(cat "$STATE_PATH" 2>/dev/null || echo ok)"
SEED="$(cat "$MOCKBIN/seed")"
is_a=0; for a in "$@"; do [ "$a" = "-a" ] && is_a=1; done
case "$1 $2" in
  "ps "*)
    # точность реального docker: --format '{{.Names}}' печатает ТОЛЬКО имена
    onlyn=0; for a in "$@"; do [ "$a" = "{{.Names}}" ] && onlyn=1; done
    if [ $is_a -eq 1 ] && [ $onlyn -eq 1 ]; then
      if [ "$STATE" = fail ]; then
        printf 'config-opensearch-%s\nconfig-scirius-%s\n' "$SEED" "$SEED"
      else
        for s in opensearch scirius db suricata nginx; do printf 'config-%s-%s\n' "$s" "$SEED"; done
      fi
      exit 0
    fi
    if [ $is_a -eq 1 ]; then
      if [ "$STATE" = fail ]; then
        printf 'config-opensearch-%s\tExited (1) 3 minutes ago\topensearchproject/opensearch:3.3.1\n' "$SEED"
        printf 'config-scirius-%s\tCreated\tscirius:latest\n' "$SEED"
      else
        for s in opensearch scirius db suricata nginx; do
          printf 'config-%s-%s\tUp 2 minutes (healthy)\t%s:latest\n' "$s" "$SEED" "$s"
        done
      fi
    else
      if [ "$STATE" = fail ]; then :; else
        for s in opensearch scirius db suricata nginx; do
          printf 'config-%s-%s Up 2 minutes (healthy)\n' "$s" "$SEED"
        done
      fi
    fi ;;
  "volume ls") printf 'db-data-%s\nopensearch-data-%s\nfluentd-pos-%s\n' "$SEED" "$SEED" "$SEED" ;;
  "volume rm") echo "$3" >> "$MOCKBIN/volume-rm.log"; exit 0 ;;
  "info "*) echo "/tmp" ;;
  "network ls") echo "config_network" ;;
  "compose version") echo "Docker Compose version v2.29.0" ;;
  "compose "*)
    # имитация проверки проекта: v4-скрипт зовёт docker compose config -q
    VAL="$(cat "$MOCKBIN/compose-validate" 2>/dev/null || echo off)"
    if [ "$VAL" != on ]; then exit 0; fi
    prev=""; cf=""
    for a in "$@"; do [ "$prev" = "-f" ] && cf="$a"; prev="$a"; done
    if [ ! -f "$cf" ]; then echo "stat ${cf:-unknown}: no such file or directory"; exit 14; fi
    if ! grep -q '^networks:' "$cf"; then
      echo 'service "opensearch" refers to undefined network network: invalid compose project'; exit 15
    fi
    exit 0 ;;
  "logs "*) LOGS_DIR="$(cat "$MOCKBIN/logs-dir" 2>/dev/null || echo "")"; CT="$4"; [ -n "$LOGS_DIR" ] && [ -f "$LOGS_DIR/$CT.log" ] && cat "$LOGS_DIR/$CT.log" || echo "(no logs)" ;;
  "inspect "*)
    case "$*" in
      *State.Health.Status*) echo healthy ;;
      *NetworkSettings.Networks*) echo "config_network " ;;
      *) echo '{"Status":"unhealthy","FailingStreak":5,"Log":[{"ExitCode":1,"Output":"curl: (7) Failed to connect"}]}' ;;
    esac ;;
  "exec "*)
    case "$*" in
      *pg_dumpall*) echo "CREATE TABLE rules_source;"; echo "CREATE TABLE rules_ruleset;" ;;
      *pg_isready*) echo "accepting connections" ;;
      *psql*)       echo "RESTORE DUMP OK" ;;
      *)            echo "POSTGRES_USER=selks" ;;
    esac ;;
  "run "*)
    # имитация tar-бэкапа volume: -v <host>:/dst ... tar czf /dst/<file> -C /src .
    prev=""; dsthost=""; fname=""
    for a in "$@"; do
      [ "$prev" = "-v" ] && case "$a" in *:/dst) dsthost="${a%:/dst}" ;; esac
      case "$a" in /dst/*.tar.gz) fname="${a#/dst/}" ;; esac
      prev="$a"
    done
    if [ -n "$dsthost" ] && [ -n "$fname" ]; then
      { echo "# mock volume backup $(date +%s)"; } > "$dsthost/$fname"
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
EOF

  # ---- мок stamusctl ----
  cat > "$WORK/bin/stamusctl" <<'EOF'
#!/usr/bin/env bash
MOCKBIN="$(dirname "$(command -v stamusctl)")"
STATE="$(cat "$MOCKBIN/state" 2>/dev/null || echo ok)"
SEED="$(cat "$MOCKBIN/seed" 2>/dev/null || echo "")"
SUB="$1"; shift || true
case "$SUB" in
  version) echo "stamusctl version 1.0.0 (build test)" ;;
  config)
    case "${1:-}" in
      version) echo "instance config, template version: 1.2.3" ;;
      get)
        if [ "${2:-}" = "suricata.interfaces" ]; then
          echo "suricata.interfaces: $(cat "$MOCKBIN/interfaces-value" 2>/dev/null || echo "")"
        else
          echo "opensearch.memory: 2g"
          echo "suricata.interfaces: $(cat "$MOCKBIN/interfaces-value" 2>/dev/null || echo "")"
        fi ;;
      set)
        for a in "$@"; do
          case "$a" in suricata.interfaces=*) printf '%s' "${a#*=}" > "$MOCKBIN/interfaces-value" ;; esac
        done ;;
      *) exit 0 ;;
    esac ;;
  compose)
    case "${1:-}" in
      ps)      echo "fake-db-container-id" ;;
      images)  echo "opensearch 2.5.0" ;;
      pull)
        # имитация кадров прогресса docker compose (поток мусора + полезные строки)
        i=0
        while [ $i -lt 15 ]; do
          printf 'abcdef123456 Downloading [====>       ]  %dMB/100MB\n' $i
          printf 'fedcba654321 Extracting %d s\n' $i
          i=$((i+1))
        done
        printf 'abcdef123456 Pull complete\n'
        printf 'opensearch Pulled\n' ;;
      update)
        head -c 4096 > /dev/null 2>&1 || true   # читает stdin как реальный stamusctl
        CFG="$PWD/config"
        BEHAV="$(cat "$MOCKBIN/update-behavior" 2>/dev/null || echo custom)"
        case "$BEHAV" in
          lose-compose)
            rm -f "$CFG/docker-compose.yml" "$CFG/docker-compose.yaml" ;;   # шаблон потерял compose-файл (инцидент 09.11)
          lose-networks)
            if [ -f "$CFG/docker-compose.yml" ]; then
              grep -v '^networks:' "$CFG/docker-compose.yml" | grep -v '^  network:' > "$CFG/.tmp" \
                && mv "$CFG/.tmp" "$CFG/docker-compose.yml"   # шаблон 3.3.x: сеть не определена
            fi
            sed -i 's/opensearch:2.5.0/opensearch:3.3.1/; s/postgres:16/postgres:17/' "$CFG/docker-compose.yml" 2>/dev/null || true ;;
          *)
            [ -f "$CFG/docker-compose.yml" ] && sed -i 's/opensearch:2.5.0/opensearch:3.3.1/; s/postgres:16/postgres:17/' "$CFG/docker-compose.yml" ;;
        esac
        rm -f "$CFG/custom-mikrotik.conf"        # шаблон "потерял" пользовательский файл
        echo eth0 > "$MOCKBIN/interfaces-value"  # и "потерял" suricata.interfaces
        echo "template updated" ;;
      down)
        DB="$(cat "$MOCKBIN/down-behavior" 2>/dev/null || echo ok)"
        if [ "$DB" = lose-compose ]; then rm -f "$PWD/config/docker-compose.yml" "$PWD/config/docker-compose.yaml"; fi
        echo "stack down"; echo ok > "$MOCKBIN/state" ;;   # после down — имитация успешного отката
      up)
        if [ "$STATE" = fail ]; then
          printf 'Network clearndr  Creating\n'
          printf 'Container config-opensearch-%s  Waiting\n' "$SEED"
          printf 'Container config-opensearch-%s  Error\n' "$SEED"
          echo "dependency failed to start: container config-opensearch-$SEED is unhealthy" >&2
          exit 1
        fi
        printf 'Container config-db-%s  Started\n' "$SEED"
        printf 'Container config-rabbitmq-%s  Healthy\n' "$SEED"
        echo "stack started" ;;
      *)       exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
EOF

  cat > "$WORK/bin/sysctl" <<'EOF'
#!/usr/bin/env bash
MOCKBIN="$(dirname "$(command -v sysctl)")"
VAL="$(cat "$MOCKBIN/max-map-count" 2>/dev/null || echo 262144)"
[ "$1" = "-n" ] && echo "$VAL" && exit 0
exit 0
EOF

  cat > "$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    *events-stack.compose.yaml*) echo 'image: opensearchproject/opensearch:3.3.1'; exit 0 ;;
    *db.compose.yaml*)           echo 'image: postgres:17'; exit 0 ;;
    *api.github.com*)            echo '{"tag_name": "v9.9.9"}'; exit 0 ;;
    *http_code*)                 if echo "$@" | grep -q 'rest/rules'; then printf '{"count": 5}\n200\n'; else echo "200"; fi; exit 0 ;;
  esac
done
echo '{"count": 5}'; exit 0
EOF

  cat > "$WORK/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *list-unit-files*) printf 'mikrocataTZSP0.service enabled enabled\nTZSPreplay@.service enabled enabled\n' ;;
  *is-active*)       echo active ;;
  *)                 exit 0 ;;
esac
EOF

  cat > "$WORK/bin/ip" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  chmod +x "$WORK/bin/docker" "$WORK/bin/stamusctl" "$WORK/bin/sysctl" "$WORK/bin/curl" "$WORK/bin/systemctl" "$WORK/bin/ip"
  echo "$SEED" > "$WORK/bin/seed"
  echo off > "$WORK/bin/compose-validate"
  echo custom > "$WORK/bin/update-behavior"
  echo ok > "$WORK/bin/down-behavior"
}

# свежий config/ для v4-сценариев (с секцией networks, как в старом шаблоне)
fresh_config_v4() {
  rm -rf "$WORK/instance/config" "$WORK/instance/config.failed-"* 2>/dev/null
  mkdir -p "$WORK/instance/config"
  cat > "$WORK/instance/config/docker-compose.yml" <<EOF
services:
  opensearch:
    image: opensearchproject/opensearch:2.5.0
  db:
    image: postgres:16
networks:
  network:
EOF
  echo "tzsp0" > "$WORK/bin/interfaces-value"
}

# фикстура журнала opensearch при несовместимых индексах
write_fail_fixture() {
  cat > "$WORK/logs/config-opensearch-$SEED.log" <<'EOF'
[2026-11-09T07:06:44,712][ERROR][o.o.b.Bootstrap] Exception in phase "startup"
java.lang.IllegalStateException: The index [[.kibana_1/AbCdEf12]] was created with version [1.13.0] but the minimum compatible version is [2.0.0]. It should be re-indexed in OpenSearch 2.x before upgrading to 3.0.0.
EOF
  echo "$WORK/logs" > "$WORK/bin/logs-dir"
}
clear_fail_fixture() { echo "" > "$WORK/bin/logs-dir"; }

run_update() {  # $1: сценарий-стейт, $2: тег артефактов, остальные аргументы -> скрипту
  echo "$1" > "$WORK/bin/state"
  ( cd "$WORK/instance" && PATH="$WORK/bin:$PATH" bash "$SCRIPT" --instance "$WORK/instance" --backup-dir "$WORK/backups" --health-timeout 30 "${@:3}" ) > "$WORK/out-$2.txt" 2>&1
  echo $?
}

# ============================ 1. unit-паттерны ==============================
echo "== 1. Паттерны имён контейнеров (seed-суффикс) =="
line="config-opensearch-$SEED Up 2 minutes (healthy)"
st="$(echo "$line" | grep -E -- "-opensearch-[A-Za-z0-9_]+ " | head -1 | awk '{print $2}')"
[ "$st" = "Up" ] && ok "opensearch распознан (Up)" || bad "opensearch не распознан: '$st'"
line2="config-opensearch-dashboards-AbCdEf1234567890 Up 2 minutes"
m="$(echo "$line2" | grep -E -- "-opensearch-[A-Za-z0-9_]+ " | head -1 || true)"
[ -z "$m" ] && ok "opensearch-dashboards не спутывается с opensearch" || bad "ложное совпадение: $m"

# ============================ 2. моки =======================================
setup_mocks

echo "== 2. Preflight: низкий vm.max_map_count =="
echo 65530 > "$WORK/bin/max-map-count"
rc="$(run_update ok s2 --yes --dry-run)"
contains "$(cat "$WORK/out-s2.txt")" "vm.max_map_count" "сообщение о max_map_count показано"
check_rc "$rc" 1 "preflight отказывается продолжать"

echo "== 3. Полный цикл: смена версий, дефолты non-tty (keep + restore PG) =="
echo 262144 > "$WORK/bin/max-map-count"
clear_fail_fixture
rc="$(run_update ok s3 --yes --skip-volume --token fake-token-123)"
out="$(cat "$WORK/out-s3.txt")"
check_rc "$rc" 0 "полный цикл завершился успехом"
contains "$out" "vm.max_map_count = 262144" "preflight прошёл"
contains "$out" "Текущая версия стека (config version): 1.2.3" "версия распарсена"
contains "$out" "Целевая версия: v9.9.9" "целевая версия из GitHub API"
contains "$out" "OpenSearch меняет мажорную версию: opensearchproject/opensearch:2.5.0 → 3.3.1" "смена версии opensearch обнаружена"
contains "$out" "PostgreSQL меняет мажорную версию: postgres:16 → 17" "смена версии postgres обнаружена"
contains "$out" "данные сохраняются по умолчанию" "неинтерактивный дефолт: данные opensearch сохраняются"
contains "$out" "том БД будет пересоздан и восстановлен из дампа" "неинтерактивный дефолт: PG restore"
contains "$out" "Дамп БД:" "дамп БД снят"
contains "$out" "Настройки восстановлены в новый PostgreSQL (postgres:17)" "дамп восстановлен в новый том"
[ -f "$WORK/bin/volume-rm.log" ] && grep -q "db-data-$SEED" "$WORK/bin/volume-rm.log" && ok "volume db-data пересоздан (rm зафиксирован)" || bad "volume db-data не пересоздавался"
contains "$out" "Восстановлен пользовательский файл, отсутствующий в новой конфигурации: config/custom-mikrotik.conf" "пользовательский файл восстановлен"
[ -f "$WORK/instance/config/custom-mikrotik.conf" ] && ok "custom-mikrotik.conf вернулся в config/" || bad "custom-mikrotik.conf НЕ восстановлен"
contains "$out" "suricata.interfaces изменились: «tzsp0» → «eth0»" "потеря suricata.interfaces обнаружена"
contains "$out" "suricata.interfaces восстановлены: tzsp0" "suricata.interfaces восстановлены"
[ "$(cat "$WORK/bin/interfaces-value")" = "tzsp0" ] && ok "значение interfaces в stamusctl = tzsp0" || bad "interfaces-value = $(cat "$WORK/bin/interfaces-value")"
contains "$out" "Обнаружена интеграция MikroTik (mikrocata2selks)" "интеграция MikroTik обнаружена"
contains "$out" "служба mikrocataTZSP0.service: active" "пост-проверка службы mikrocata"
contains "$out" "Все сервисы scirius db suricata nginx opensearch запущены" "wait_healthy видит seed-имена"
contains "$out" "REST API отвечает 200; источников правил в базе: 5" "REST API проверен"
contains "$out" "Обновление Clear NDR завершено: 1.2.3 ->" "итоговый отчёт"
not_contains "$out" "Downloading [" "кадры прогресса docker НЕ попадают в вывод"
not_contains "$out" "Extracting" "кадры Extracting отсутствуют в выводе"
contains "$out" "Pull complete" "завершения слоёв показаны"
contains "$out" "opensearch Pulled" "итог pull показан"
contains "$out" "Container config-db-$SEED  Started" "события запуска контейнеров показаны"
LOGF="$(ls -1 "$WORK/backups"/update-*.log 2>/dev/null | head -1)"
if [ -n "$LOGF" ]; then
  LSIZE=$(du -sk "$LOGF" | awk '{print $1}')
  if [ "$LSIZE" -lt 100 ]; then ok "лог компактный: ${LSIZE}КБ (< 100КБ)"; else bad "лог раздут: ${LSIZE}КБ"; fi
else
  bad "лог обновления не найден"
fi

echo "== 4. Сбой compose up: диагностика + автооткат =="
write_fail_fixture
rm -f "$WORK/bin/volume-rm.log"
rc="$(run_update fail s4 --yes --skip-volume --token fake-token-123)"
out="$(cat "$WORK/out-s4.txt")"
contains "$out" "dependency failed to start" "ошибка compose up в выводе"
contains "$out" "Диагностика сбоя" "диагностика выполнена ДО отката"
DIAGDIR="$(ls -d "$WORK/backups"/fail-logs-* 2>/dev/null | head -1)"
[ -n "$DIAGDIR" ] && [ -f "$DIAGDIR/config-opensearch-$SEED.log" ] && ok "журнал opensearch сохранён в fail-logs" || bad "журнал opensearch НЕ сохранён"
[ -n "$DIAGDIR" ] && [ -s "$DIAGDIR/summary.txt" ] && ok "summary.txt создан" || bad "summary.txt отсутствует"
contains "$out" "OpenSearch не принял данные" "вероятная причина опознана (несовместимые индексы)"
contains "$out" "--opensearch-data wipe" "подсказка про wipe"
contains "$out" "ОТКАТ" "выполнен откат"
contains "$out" "Стек поднят в прежней конфигурации" "стек поднят после отката"
[ -d "$WORK/instance/config.failed-"* ] && ok "сломанный config сохранён как config.failed-*" || bad "config.failed-* не найден"
check_rc "$rc" 2 "код выхода 2 при неудаче обновления"

echo "== 5. --no-rollback =="
echo fail > "$WORK/bin/state"
write_fail_fixture
rm -rf "$WORK/instance/config" "$WORK/instance/config.failed-"* 2>/dev/null
mkdir -p "$WORK/instance/config"; cp "$WORK/instance/config/docker-compose.yml" /dev/null 2>/dev/null || true
cat > "$WORK/instance/config/docker-compose.yml" <<EOF
services:
  opensearch:
    image: opensearchproject/opensearch:2.5.0
  db:
    image: postgres:16
EOF
rc="$(run_update fail s5 --yes --skip-volume --no-rollback)"
out="$(cat "$WORK/out-s5.txt")"
contains "$out" "Откат отключён" "откат отключён по флагу"
check_rc "$rc" 2 "--no-rollback: код выхода 2"

echo "== 6. --opensearch-data wipe: копия в tar + удаление тома =="
echo ok > "$WORK/bin/state"; clear_fail_fixture
rm -rf "$WORK/instance/config" "$WORK/instance/config.failed-"* 2>/dev/null
mkdir -p "$WORK/instance/config"
cat > "$WORK/instance/config/docker-compose.yml" <<EOF
services:
  opensearch:
    image: opensearchproject/opensearch:2.5.0
  db:
    image: postgres:16
EOF
echo "tzsp0" > "$WORK/bin/interfaces-value"
rm -f "$WORK/bin/volume-rm.log"
rc="$(run_update ok s6 --yes --skip-volume --opensearch-data wipe)"
out="$(cat "$WORK/out-s6.txt")"
check_rc "$rc" 0 "цикл с wipe завершился успехом"
contains "$out" "Решение (--opensearch-data wipe): чистые данные событий" "решение wipe принято"
contains "$out" "Копия событий:" "копия volume событий создана"
LS6="$(ls -1 "$WORK/backups"/opensearch-data-*.tar.gz 2>/dev/null | head -1)"
[ -n "$LS6" ] && [ -s "$LS6" ] && ok "tar-архив событий не пуст" || bad "tar-архив событий отсутствует/пуст"
[ -f "$WORK/bin/volume-rm.log" ] && grep -q "opensearch-data-$SEED" "$WORK/bin/volume-rm.log" && ok "volume opensearch-data удалён" || bad "volume opensearch-data НЕ удалялся"
contains "$out" "настройки правил в PostgreSQL НЕ затронуты" "подсказка про сохранность настроек"

echo "== 7. --opensearch-data guide: подсказки, стек не тронут =="
rm -f "$WORK/bin/volume-rm.log"
# пересоздаём конфиг со старой версией (после сценария 6 там уже новая)
rm -rf "$WORK/instance/config" "$WORK/instance/config.failed-"* 2>/dev/null
mkdir -p "$WORK/instance/config"
cat > "$WORK/instance/config/docker-compose.yml" <<EOF
services:
  opensearch:
    image: opensearchproject/opensearch:2.5.0
  db:
    image: postgres:16
EOF
echo "tzsp0" > "$WORK/bin/interfaces-value"
rc="$(run_update ok s7 --yes --skip-volume --opensearch-data guide)"
out="$(cat "$WORK/out-s7.txt")"
check_rc "$rc" 0 "guide: код выхода 0"
contains "$out" "Ручная конвертация данных OpenSearch" "гид по конвертации показан"
contains "$out" "прервано БЕЗ изменений" "обновление прервано без изменений"
not_contains "$out" "ОТКАТ" "откат не выполнялся"
[ ! -f "$WORK/bin/volume-rm.log" ] && ok "тома не удалялись (стек не тронут)" || bad "тома удалялись при guide!"

# ============================ 8-11. Защита конфигурации (v4) =================

echo "== 8. Preflight-восстановление пропавшего compose-файла из архива =="
fresh_config_v4
# «хороший» архив с полным config/ (как бэкап прошлой успешной установки)
tar czf "$WORK/backups/config-20261109-000000.tar.gz" -C "$WORK/instance" config
rm -f "$WORK/instance/config/docker-compose.yml"   # инцидент: файл пропал
rm -f "$WORK/backups"/fail-logs-* 2>/dev/null
echo on > "$WORK/bin/compose-validate"
rc="$(run_update ok s8 --yes --skip-volume)"
out="$(cat "$WORK/out-s8.txt")"
check_rc "$rc" 0 "цикл после авто-восстановления завершился успехом"
contains "$out" "нет compose-файла" "пропажа compose-файла обнаружена в preflight"
contains "$out" "compose-файл на месте — конфигурация восстановлена" "compose-файл восстановлен из архива"
contains "$out" "Конфигурация стека проходит проверку docker compose" "preflight-валидация пройдена"
[ -f "$WORK/instance/config/docker-compose.yml" ] && ok "docker-compose.yml вернулся в config/" || bad "compose-файл не восстановлен"

echo "== 8b. compose.yml (Compose Spec v2) распознаётся как валидный compose-файл =="
fresh_config_v4
if ! mv "$WORK/instance/config/docker-compose.yml" "$WORK/instance/config/compose.yml" 2>/dev/null; then
  # docker-compose.yml отсутствовал — создадим compose.yml вручную
  cat > "$WORK/instance/config/compose.yml" <<'EOF'
services:
  opensearch:
    image: opensearchproject/opensearch:2.5.0
  db:
    image: postgres:16
networks:
  network:
    name: config_network
    external: true
EOF
fi
rc="$(run_update ok s8b --yes --skip-volume)"
out="$(cat "$WORK/out-s8b.txt")"
check_rc "$rc" 0 "цикл с compose.yml завершился успехом"
not_contains "$out" "нет compose-файла" "compose.yml не считается пропажей compose-файла"
not_contains "$out" "стек неуправляем" "compose.yml не считается повреждением конфигурации"

echo "== 9. Автопатч сетей после compose update (шаблон не определяет сеть) =="
fresh_config_v4
rm -f "$WORK/backups/config-20261109-000000.tar.gz"
echo lose-networks > "$WORK/bin/update-behavior"
rc="$(run_update ok s9 --yes --skip-volume)"
out="$(cat "$WORK/out-s9.txt")"
check_rc "$rc" 0 "цикл с патчем сетей завершился успехом"
contains "$out" "Конфигурация стека проходит проверку docker compose" "preflight: сети допатчены до изменений"
contains "$out" "Новая конфигурация проходит проверку docker compose" "после update: сети допатчены"
contains "$out" "существующая docker-сеть «config_network» (external)" "сеть привязана к фактической (external)"
grep -q '^networks:' "$WORK/instance/config/docker-compose.yml" && ok "секция networks: есть в файле" || bad "секция networks: не добавлена"
grep -q 'name: config_network' "$WORK/instance/config/docker-compose.yml" && ok "указано имя фактической сети" || bad "нет name: сети"

echo "== 10. compose update потерял compose-файл — возврат из бэкапа =="
fresh_config_v4
echo lose-compose > "$WORK/bin/update-behavior"
rc="$(run_update ok s10 --yes --skip-volume)"
out="$(cat "$WORK/out-s10.txt")"
check_rc "$rc" 0 "цикл с потерей compose-файла при update завершился успехом"
contains "$out" "compose-файл возвращён из бэкапа" "потеря файла при update обнаружена и компенсирована"
contains "$out" "Новая конфигурация проходит проверку docker compose" "проект валиден после возврата"
[ -f "$WORK/instance/config/docker-compose.yml" ] && ok "docker-compose.yml на месте после update" || bad "compose-файл не возвращён"

echo "== 11. Пропажа compose-файла при остановке — бэкап-гейт прерывает обновление =="
fresh_config_v4
echo lose-compose > "$WORK/bin/down-behavior"
rc="$(run_update ok s11 --yes --skip-volume)"
out="$(cat "$WORK/out-s11.txt")"
check_rc "$rc" 1 "бэкап-гейт: обновление прервано с кодом 1"
contains "$out" "НЕ содержит compose-файл" "аргументированный отказ: архив без compose-файла"
contains "$out" "clearndr-repair-stack.sh" "подсказка про repair-скрипт"

# ============================ итоги =========================================
echo
echo "ИТОГО: ok=$PASS, fail=$FAIL"
[ "$FAIL" -eq 0 ] || { echo "(артефакты сохранены в $WORK для отладки)"; exit 1; }
rm -rf "$WORK"
exit 0
