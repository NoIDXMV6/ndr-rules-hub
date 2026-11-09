#!/usr/bin/env bash
# ============================================================================
# test-clearndr-update-mock.sh — мок-стенд для scripts/clearndr-update.sh.
# Проверяет:
#   1) паттерны сопоставления имён контейнеров Clear NDR (<base>-<svc>-<seed>);
#   2) успешный цикл обновления (wait_healthy с seed-суффиксами);
#   3) сбой compose up: диагностика fail-logs + вероятная причина + автооткат;
#   4) preflight: vm.max_map_count < 262144 -> отказ с инструкцией.
# Моки: docker, stamusctl, sysctl, curl (подставляются через PATH).
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

SEED="FNISvONwp2TtteCD"
setup_mocks() {
  mkdir -p "$WORK/bin" "$WORK/instance/config" "$WORK/backups"
  echo "placeholder" > "$WORK/instance/config/docker-compose.yml"
  echo "seed: $SEED" > "$WORK/instance/config/values.yaml"
  echo "$WORK/bin/state" > "$WORK/bin/state-path"   # путь к файлу-стейту (содержимое: ok|fail)

  # ---- мок docker ----
  cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
MOCKBIN="$(dirname "$(command -v docker)")"   # каталог с моками и state-файлами
STATE_FILE="$MOCKBIN/state-path"
STATE_PATH="$(cat "$STATE_FILE" 2>/dev/null || echo "")"
STATE="$(cat "$STATE_PATH" 2>/dev/null || echo ok)"
SEED="$(cat "$MOCKBIN/seed")"
is_a=0; for a in "$@"; do [ "$a" = "-a" ] && is_a=1; done
case "$1 $2" in
  "ps "*)
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
  "info "*) echo "/tmp" ;;
  "logs "*) LOGS_DIR="$(cat "$MOCKBIN/logs-dir" 2>/dev/null || echo "")"; CT="$4"; [ -n "$LOGS_DIR" ] && [ -f "$LOGS_DIR/$CT.log" ] && cat "$LOGS_DIR/$CT.log" || echo "(no logs)" ;;
  "inspect "*) echo '{"Status":"unhealthy","FailingStreak":5,"Log":[{"ExitCode":1,"Output":"curl: (7) Failed to connect"}]}' ;;
  "exec "*)
    case "$*" in *pg_dumpall*) echo "CREATE TABLE rules_source;"; echo "CREATE TABLE rules_ruleset;"; echo "-- done" ;;
                   *) echo "POSTGRES_USER=selks" ;; esac ;;
  "run "*) exit 0 ;;
  *) exit 0 ;;
esac
EOF

  # ---- мок stamusctl ----
  cat > "$WORK/bin/stamusctl" <<'EOF'
#!/usr/bin/env bash
MOCKBIN="$(dirname "$(command -v stamusctl)")"
STATE="$(cat "$MOCKBIN/state" 2>/dev/null || echo ok)"
SUB="$1"; shift || true
case "$SUB" in
  version) echo "stamusctl version 1.0.0 (build test)" ;;
  config)
    case "$1" in
      version) echo "instance config, template version: 1.2.3" ;;
      get)     echo "opensearch.memory: 2g"; echo "suricata.interfaces: eth0" ;;
      *)       exit 0 ;;
    esac ;;
  compose)
    case "$1" in
      ps)      echo "fake-db-container-id" ;;
      images)  echo "opensearch 2.5.0" ;;
      pull)    echo "pulled: ok" ;;
      update)  head -c 4096 > /dev/null 2>&1 || true; echo "template updated" ;;   # читает stdin как реальный stamusctl, потом выходит
      down)    echo "stack down"; echo ok > "$MOCKBIN/state" ;;   # после down стек «подняли» — имитация успешного отката
      up)      if [ "$STATE" = fail ]; then
                 echo "dependency failed to start: container config-opensearch-FNISvONwp2TtteCD is unhealthy" >&2
                 exit 1
               fi
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
    *api.github.com*) echo '{"tag_name": "v9.9.9"}'; exit 0 ;;
    *http_code*)      if echo "$@" | grep -q 'rest/rules'; then printf '{"count": 5}\n200\n'; else echo "200"; fi; exit 0 ;;
  esac
done
echo '{"count": 5}'; exit 0
EOF

  chmod +x "$WORK/bin/docker" "$WORK/bin/stamusctl" "$WORK/bin/sysctl" "$WORK/bin/curl"
  echo "$SEED" > "$WORK/bin/seed"
}

# фикстура журнала opensearch при несовместимых индексах
write_fail_fixture() {
  mkdir -p "$WORK/logs"
  cat > "$WORK/logs/config-opensearch-$SEED.log" <<'EOF'
[2026-11-09T07:06:40,100][INFO ][o.o.n.Node] starting ...
[2026-11-09T07:06:44,712][ERROR][o.o.b.Bootstrap] Exception in phase "startup"
java.lang.IllegalStateException: The index [[.kibana_1/AbCdEf12]] was created with version [1.13.0] but the minimum compatible version is [2.0.0]. It should be re-indexed in OpenSearch 2.x before upgrading to 3.0.0.
        at org.opensearch.index.IndexSettings.<init>(IndexSettings.java:308)
EOF
  echo "$WORK/logs" > "$WORK/bin/logs-dir"
}
clear_fail_fixture() { echo "" > "$WORK/bin/logs-dir"; }

run_update() {  # $1: сценарий-стейт, $2: тег для артефактов, остальные аргументы -> скрипту
  echo "$1" > "$WORK/bin/state"
  local xflag=""
  [ -n "${MOCK_DEBUG:-}" ] && xflag="-x"
  ( cd "$WORK/instance" && PATH="$WORK/bin:$PATH" bash $xflag "$SCRIPT" --instance "$WORK/instance" --backup-dir "$WORK/backups" --health-timeout 30 "${@:3}" ) > "$WORK/out-$2.txt" 2>&1
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
m="$(echo "config-db-$SEED Up 1 minute" | grep -E -- "-db-[A-Za-z0-9_]+ " | head -1 | awk '{print $2}')"
[ "$m" = "Up" ] && ok "db распознан" || bad "db не распознан"

# ============================ 2. моки =======================================
setup_mocks
printf '%s' "$SEED" > "$WORK/bin/seed"

echo "== 2. Preflight: низкий vm.max_map_count =="
echo 65530 > "$WORK/bin/max-map-count"
rc="$(run_update ok s2 --yes --dry-run)"
contains "$(cat "$WORK/out-s2.txt")" "vm.max_map_count" "сообщение о max_map_count показано"
check_rc "$rc" 1 "preflight отказывается продолжать"

echo "== 3. Успешный цикл обновления =="
echo 262144 > "$WORK/bin/max-map-count"
clear_fail_fixture
rc="$(run_update ok s3 --yes --skip-volume --token fake-token-123)"
out="$(cat "$WORK/out-s3.txt")"
contains "$out" "vm.max_map_count = 262144" "preflight прошёл"
contains "$out" "Текущая версия стека (config version): 1.2.3" "версия распарсена из config version"
contains "$out" "Целевая версия: v9.9.9" "целевая версия из GitHub API"
contains "$out" "Дамп БД:" "дамп БД снят"
contains "$out" "Все сервисы scirius db suricata nginx opensearch запущены" "wait_healthy видит seed-имена"
contains "$out" "REST API отвечает 200; источников правил в базе: 5" "REST API проверен"
contains "$out" "Обновление Clear NDR завершено: 1.2.3 ->" "итоговый отчёт"
check_rc "$rc" 0 "полный цикл завершился успехом"

echo "== 4. Сбой compose up: диагностика + автооткат =="
write_fail_fixture
rc="$(run_update fail s4 --yes --skip-volume --token fake-token-123)"
out="$(cat "$WORK/out-s4.txt")"
contains "$out" "dependency failed to start" "ошибка compose up в выводе"
contains "$out" "Диагностика сбоя" "диагностика выполнена ДО отката"
DIAGDIR="$(ls -d "$WORK/backups"/fail-logs-* 2>/dev/null | head -1)"
[ -n "$DIAGDIR" ] && [ -f "$DIAGDIR/config-opensearch-$SEED.log" ] && ok "журнал opensearch сохранён в fail-logs" || bad "журнал opensearch НЕ сохранён"
[ -n "$DIAGDIR" ] && [ -s "$DIAGDIR/summary.txt" ] && ok "summary.txt создан" || bad "summary.txt отсутствует"
contains "$out" "OpenSearch не принял данные" "вероятная причина опознана (несовместимые индексы)"
contains "$out" "opensearch-data-" "подсказка про volume событий"
contains "$out" "ОТКАТ" "выполнен откат"
contains "$out" "config/ восстановлен из архива" "config восстановлен"
contains "$out" "Стек поднят в прежней конфигурации" "стек поднят после отката"
[ -d "$WORK/instance/config.failed-"* ] && ok "сломанный config сохранён как config.failed-*" || bad "config.failed-* не найден"
check_rc "$rc" 2 "код выхода 2 при неудаче обновления"

echo "== 5. Откат: прежний стек не поднялся =="
# state=fail после отката: mock compose up снова возвращает ошибку, docker ps пуст
echo fail > "$WORK/bin/state"
write_fail_fixture
rm -rf "$WORK/instance/config" "$WORK/instance/config.failed-"* 2>/dev/null
mkdir -p "$WORK/instance/config"; echo "placeholder" > "$WORK/instance/config/docker-compose.yml"
rc="$(run_update fail s5 --yes --skip-volume --no-rollback)"
out="$(cat "$WORK/out-s5.txt")"
contains "$out" "Откат отключён" "откат отключён по флагу"
check_rc "$rc" 2 "--no-rollback: код выхода 2"

# ============================ итоги =========================================
echo
echo "ИТОГО: ok=$PASS, fail=$FAIL"
[ "$FAIL" -eq 0 ] || { echo "(артефакты сохранены в $WORK для отладки)"; exit 1; }
rm -rf "$WORK"
exit 0
