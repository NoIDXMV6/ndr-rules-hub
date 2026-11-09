#!/usr/bin/env bash
# ============================================================================
# test-clearndr-repair-mock.sh — мок-стенд для
#   scripts/clearndr-repair-stack.sh     (часть A)
#   scripts/clearndr-events-restore.sh   (часть B)
#
# Часть A (repair-stack):
#   A1 целой инстанс — «Инстанс цел», без изменений;
#   A2 пропавший compose + config.failed-* → восстановление + автопатч сетей (Code 15);
#   A3 пропавший compose + только архив config-*.tar.gz → восстановление из архива;
#   A4 ручной config/config/docker-compose.yaml → карантин + размещение compose;
#   A5 --dry-run ничего не меняет;
#   A6 compose ссылается на отсутствующий файл → восстановление из источника;
#   A7 --no-up не поднимает стек;
#   A8 нет источников → rc 1;
#   A9 events-инстанс (глубина 4) чинится сканом и берёт архив из /opt/<root>/backups;
#   A10 --instance-dir для events-инстанса.
#   A11 config/ отсутствует целиком → создаётся, compose из архива корня.
#   A12 скан находит events-инстанс с исчезнувшим config/.
#   A13 events-инстанс без источников, контейнеры живы → РЕКОНСТРУКЦИЯ compose
#       из docker inspect (образы, сеть external, ports, healthcheck, depends_on).
#   A14 --dry-run при реконструкции — файл не создаётся.
#
# Часть B (events-restore):
#   B1 здоровый стек — только диагностика, rc 0;
#   B2 пустой Dashboards (нет индекс-паттернов) → FAIL + рекомендации, rc 1;
#   B3 --fix: kibana_reset в scirius → паттерн logstash-* появился;
#   B4 --fix без scirius → создание паттерна через API Dashboards;
#   B5 --fix: пустой прикреплённый том + старый том → копирование данных;
#   B6 --skip-volume-copy: копирования нет;
#   B7 fluentd остановлен → docker start;
#   B8 несовпадение seed scirius и events-stack → предупреждение;
#   B9 eve.json устарел → предупреждение;
#   B10 --fix на здоровом стеке — ничего не ломает, rc 0.
#
# Моки: docker (подставляется через PATH).
# Запуск: ./scripts/test-clearndr-repair-mock.sh
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPAIR="$HERE/clearndr-repair-stack.sh"
EVENTS="$HERE/clearndr-events-restore.sh"
BASE="${TMOCK_BASE:-$HERE/.tmp-repair-mock-$$}"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check_rc() { [ "$1" = "$2" ] && ok "$3 (rc=$1)" || bad "$3 (ожидался rc=$2, получен $1)"; }
contains() { echo "$1" | grep -qF -- "$2" && ok "$3" || bad "$3 (не найдено: $2)"; }
not_contains() { echo "$1" | grep -qF -- "$2" && bad "$3 (найдено лишнее: $2)" || ok "$3"; }
log_has()    { grep -qF -- "$2" "$1/bin/docker-calls.log" 2>/dev/null && ok "$3" || bad "$3 (нет в calls.log: $2)"; }
log_hasnt()  { grep -qF -- "$2" "$1/bin/docker-calls.log" 2>/dev/null && bad "$3 (лишнее в calls.log: $2)" || ok "$3"; }

SEED="FNISvONwp2TtteCD"

# ----------------------------- мок docker ------------------------------------
write_mocks() {  # $1 — WORK
  local W="$1"; mkdir -p "$W/bin"
  cat > "$W/bin/docker" <<MOCK
#!/usr/bin/env bash
MOCKBIN="$(cd "$W/bin" && pwd)"
S() { local f="\$MOCKBIN/\$1"; if [ -s "\$f" ]; then cat "\$f"; else echo "\$2"; fi; }
STATE="\$(S state ok)"
SEED="\$(S seed $SEED)"
LOG() { echo "\$*" >> "\$MOCKBIN/docker-calls.log"; }
running_names() {
  local list="opensearch opensearch-dashboards fluentd scirius db suricata nginx"
  [ "\$STATE" = fluentd-down ] && list="opensearch opensearch-dashboards scirius db suricata nginx"
  [ "\$STATE" = no-scirius ] && list="opensearch opensearch-dashboards fluentd db suricata nginx"
  local s; for s in \$list; do echo "config-\$s-\$SEED"; done
}
all_names() {
  local list="opensearch opensearch-dashboards fluentd scirius db suricata nginx"
  [ "\$STATE" = no-scirius ] && list="opensearch opensearch-dashboards fluentd db suricata nginx"
  local s; for s in \$list; do echo "config-\$s-\$SEED"; done
}
json_for() {  # docker inspect <name> — JSON по службе (для реконструкции compose)
  local n="\$1" svc img ports mounts
  case "\$n" in
    *-opensearch-dashboards-*) svc="opensearch-dashboards"; img="opensearchproject/opensearch-dashboards:3.3.0";;
    *-opensearch-*)            svc="opensearch";            img="opensearchproject/opensearch:3.3.1";;
    *-fluentd-*)               svc="fluentd";               img="ghcr.io/stamusnetworks/stamus-images/fluentd:1.16";;
    *-scirius-*)               svc="scirius";               img="ghcr.io/stamusnetworks/scirius:clear-ndr-1.1.2";;
    *-db-*)                    svc="db";                    img="postgres:16";;
    *-suricata-*)              svc="suricata";              img="ghcr.io/stamusnetworks/suricata:7";;
    *-nginx-*)                 svc="nginx";                 img="nginx:alpine";;
    *)                         svc="unknown";               img="test/\$n:latest";;
  esac
  ports="null"
  [ "\$svc" = "opensearch-dashboards" ] && ports='{"5601/tcp":[{"HostIp":"0.0.0.0","HostPort":"5601"}]}'
  mounts="[]"
  case "\$svc" in
    opensearch)            mounts='[{"Type":"volume","Name":"opensearch-data-'"$SEED"'","Destination":"/usr/share/opensearch/data","RW":true}]';;
    opensearch-dashboards) mounts='[{"Type":"bind","Source":"/opt/ClearNDR/config/events-stack/opensearch_dashboards/opensearch_dashboards.yml","Destination":"/usr/share/opensearch-dashboards/config/opensearch_dashboards.yml","RW":true}]';;
    fluentd)               mounts='[{"Type":"volume","Name":"fluentd-pos-'"$SEED"'","Destination":"/fluentd/log/td-agent","RW":true},{"Type":"bind","Source":"/opt/ClearNDR/containers-data/suricata/logs","Destination":"/var/log/suricata","RW":false}]';;
  esac
  printf '[{"Name":"%s","Config":{"Image":"%s","Env":["PATH=/usr/bin","DISABLE_SECURITY_DASHBOARDS_PLUGIN=true"],"Labels":{"com.docker.compose.project":"config","com.docker.compose.service":"%s"},"WorkingDir":"","User":"","Healthcheck":{"Test":["CMD-SHELL","curl --silent --fail localhost:9200/_cluster/health || exit 1"],"Interval":10000000000,"Timeout":5000000000,"Retries":3,"StartPeriod":30000000000}},"HostConfig":{"RestartPolicy":{"Name":"unless-stopped"},"ExtraHosts":[]},"NetworkSettings":{"Networks":{"config_network":{"Aliases":["%s"]}},"Ports":%s},"Mounts":%s}]\n' "\$n" "\$img" "\$svc" "\$svc" "\$ports" "\$mounts"
}
case "\$1 \$2" in
  "ps "*)
    onlyn=0; isa=0; for a in "\$@"; do [ "\$a" = "{{.Names}}" ] && onlyn=1; [ "\$a" = "-a" ] && isa=1; done
    if [ \$onlyn -eq 1 ]; then
      if [ \$isa -eq 1 ]; then all_names; else running_names; fi
      exit 0
    fi
    running_names; exit 0 ;;
  "volume ls")
    if [ -s "\$MOCKBIN/volumes" ]; then cat "\$MOCKBIN/volumes"; else
      echo "db-data-\$SEED
opensearch-data-\$SEED
fluentd-pos-\$SEED"
    fi
    exit 0 ;;
  "network ls") echo "config_network"; exit 0 ;;
  "info "*) exit 0 ;;
  "compose version") echo "Docker Compose version v2.29.0"; exit 0 ;;
  "compose "*)
    prev=""; cf=""; sub=""
    for a in "\$@"; do
      [ "\$prev" = "-f" ] && cf="\$a"
      prev="\$a"
    done
    case "\$*" in
      *" config -q"*)
        if [ -n "\$cf" ] && [ ! -f "\$cf" ]; then
          echo "stat \${cf}: no such file or directory"; exit 14
        fi
        if [ -n "\$cf" ] && ! grep -q '^networks:' "\$cf"; then
          echo 'service "opensearch" refers to undefined network network: invalid compose project'; exit 15
        fi
        exit 0 ;;
      *" up -d"*) LOG "compose-up \${cf}"; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  "logs "*)
    ct="\$3"; [ "\$2" = "--tail" ] && ct="\$4"
    f="\$MOCKBIN/logs-\${ct}"; [ -f "\$f" ] && cat "\$f" || echo "(no logs)"
    exit 0 ;;
  "cp "*)
    LOG "docker-cp"
    dst="\${@: -1}"
    mkdir -p "\$dst/index-pattern" "\$dst/dashboard"
    echo '{"type":"index-pattern","id":"logstash","attributes":{"title":"logstash-*","timeFieldName":"@timestamp"}}' > "\$dst/index-pattern/logstash.json"
    echo '{"type":"dashboard","id":"SN-Demo","attributes":{"title":"SN Demo"}}' > "\$dst/dashboard/SN-Demo.json"
    exit 0 ;;
  "start "*) LOG "docker-start \$2"; sed -i "/^state\$/d" "\$MOCKBIN/state" 2>/dev/null; exit 0 ;;
  "stop "*) LOG "docker-stop \$2"; exit 0 ;;
  "run "*)
    src=""; dst=""
    prev=""
    for a in "\$@"; do
      [ "\$prev" = "-v" ] || [ "\$prev" = "--volume" ] || { prev="\$a"; continue; }
      case "\$a" in *:/src:ro) src="\${a%:/src:ro}" ;; *:/dst) dst="\${a%:/dst}" ;; esac
      prev="\$a"
    done
    if [ -n "\$src" ] && [ -n "\$dst" ]; then
      LOG "volume-copy \$src->\$dst"; exit 0
    fi
    if [ -n "\$src" ]; then echo "1.2G"; exit 0; fi
    exit 0 ;;
  "exec "*)
    if printf '%s\n' "\$@" | grep -q 'test -f /code/manage.py'; then exit 0; fi
    if printf '%s\n' "\$@" | grep -q 'kibana_reset'; then
      LOG "kibana-reset"
      if [ -s "\$MOCKBIN/kibana-fail" ]; then
        echo 'rules.es_graphs.ESError: ES failure: ES transport error: 400 illegal_argument_exception' >&2
        exit 1
      fi
      echo "Kibana dashboards reloaded successfully"
      echo "logstash-*" > "\$MOCKBIN/osd-patterns"
      exit 0
    fi
    # ветки для вызовов внутри КОНТЕЙНЕРА SCIRIUS (имя содержит «-scirius-»):
    # дамп исходников, test -d, путь к дашбордам. Важно: не срабатывать на
    # имени config-opensearch-dashboards-…!
    if printf '%s\n' "\$@" | grep -q -- '-scirius-'; then
      if printf '%s\n' "\$@" | grep -q 'es_extra_params\|sed -n'; then
        echo '(mock scirius source dump)'; exit 0
      fi
      if printf '%s\n' "\$@" | grep -q 'test -d'; then exit 0; fi
      if [ ! -s "\$MOCKBIN/no-dashboards-dir" ] && printf '%s\n' "\$@" | grep -q 'dashboards'; then
        echo '/opt/selks/kibana7-dashboards'; exit 0
      fi
    fi
    # curl внутри контейнера: URL — последний аргумент
    url="\${@: -1}"
    is_post=0; for a in "\$@"; do [ "\$a" = "POST" ] && is_post=1; done
    if [ \$is_post -eq 1 ]; then
      LOG "osd-pattern-created \$url"
      echo "logstash-*" > "\$MOCKBIN/osd-patterns"
      echo '{"id":"logstash-*"}'; exit 0
    fi
    case "\$url" in
      *_cluster/health*) echo '{"status":"yellow","number_of_indices":13}'; exit 0 ;;
      *_cat/indices/logstash-*h=docs.count*)
        n=\$(( \$(cat "\$MOCKBIN/osd-probe" 2>/dev/null || echo 0) + 1 ))
        echo \$n > "\$MOCKBIN/osd-probe"
        base=\$(cat "\$MOCKBIN/logstash-base" 2>/dev/null || echo 0)
        if [ "\$(S flow 1)" = "1" ]; then echo \$((base + 2 * n)); else echo \$base; fi
        exit 0 ;;
      *.kibana/_count*) echo '{"count":37,"_shards":{"total":1}}'; exit 0 ;;
      *_cat/allocation*) echo '[{"disk.percent":"31%"}]'; exit 0 ;;
      *localhost:5601/api/status*) echo '{"level":{"state":"green"},"state":"green"}'; exit 0 ;;
      *api/saved_objects/_find*)
        p="\$(cat "\$MOCKBIN/osd-patterns" 2>/dev/null || echo '')"
        if [ -n "\$p" ]; then
          out='{"saved_objects":['; sep=''
          for i in \$p; do out="\$out\$sep{\"id\":\"\$i\"}"; sep=','; done
          echo "\$out]}"
        else
          echo '{"saved_objects":[]}'
        fi
        exit 0 ;;
      *) echo '{}'; exit 0 ;;
    esac ;;
  "inspect "*)
    hasfmt=0; for a in "\$@"; do [ "\$a" = "--format" ] && hasfmt=1; done
    if [ "\$hasfmt" -eq 0 ]; then json_for "\${@: -1}"; exit 0; fi
    case "\$*" in
      *State.Health*) echo healthy ;;
      *NetworkSettings.Networks*) echo "config_network " ;;
      *range\ .Config.Env*) printf 'STAMUSCTL_SEED=%s\nPATH=/usr/bin\n' "\$(S scirius-seed \$SEED)" ;;
      *range\ .Mounts*) cat "\$MOCKBIN/eve-dir" 2>/dev/null || true ;;
      *) echo '{}' ;;
    esac
    exit 0 ;;
esac
exit 0
MOCK
  chmod +x "$W/bin/docker"
}

# ----------------------------- стенды -----------------------------------------
new_work() {  # $1 — имя сценария
  local W="$BASE/$1"
  rm -rf "$W"; mkdir -p "$W/bin"
  write_mocks "$W"
  echo "$W"
}

setup_state() {  # $1 — WORK; $2.. — state-файлы (k=v)
  local W="$1"; shift
  : > "$W/bin/docker-calls.log"
  echo "$SEED" > "$W/bin/seed"
  local kv
  for kv in "$@"; do
    printf '%s\n' "${kv#*=}" > "$W/bin/${kv%%=*}"
  done
}

compose_plain() {  # без секции networks (как шаблон 3.3.x)
  cat <<'EOF'
services:
  opensearch:
    image: opensearchproject/opensearch:3.3.1
    container_name: config-opensearch-FNISvONwp2TtteCD
    networks: network:
  opensearch-dashboards:
    image: opensearchproject/opensearch-dashboards:3.3.0
    container_name: config-opensearch-dashboards-FNISvONwp2TtteCD
    networks: network:
  fluentd:
    image: ghcr.io/stamusnetworks/stamus-images/fluentd:1.16
    container_name: config-fluentd-FNISvONwp2TtteCD
    networks: network:
EOF
}

compose_fixed() {  # с сетью — целой инстанс
  compose_plain
  cat <<'EOF'
networks:
  network:
    name: config_network
    external: true
EOF
}

# ============================================================================
echo "== Часть A: clearndr-repair-stack.sh =="

# --- A1: целой инстанс ---
W="$(new_work a1)"; setup_state "$W" "state=ok"
mkdir -p "$W/ndrroot/config"
compose_fixed > "$W/ndrroot/config/docker-compose.yaml"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A1: rc"
contains "$out" "Инстанс цел" "A1: инстанс распознан как целой"
not_contains "$out" "refers to undefined" "A1: без ошибки сетей"

# --- A2: пропавший compose, источник config.failed-*, автопатч сетей ---
W="$(new_work a2)"; setup_state "$W" "state=ok"
mkdir -p "$W/ndrroot/config" "$W/ndrroot/config.failed-001/config"
compose_plain > "$W/ndrroot/config.failed-001/config/docker-compose.yaml"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A2: rc"
[ -f "$W/ndrroot/config/docker-compose.yaml" ] && ok "A2: compose восстановлен" || bad "A2: compose не восстановлен"
grep -q 'external: true' "$W/ndrroot/config/docker-compose.yaml" && ok "A2: сеть дописана (external)" || bad "A2: сети нет"
contains "$out" "Проект compose валиден" "A2: проект валиден после патча"
contains "$(cat "$W/ndrroot/config/docker-compose.yaml")" "name: config_network" "A2: использована фактическая сеть (name в compose)"

# --- A3: восстановление из архива ---
W="$(new_work a3)"; setup_state "$W" "state=ok"
mkdir -p "$W/ndrroot/config" "$W/ndrroot/backups/tpl/config"
compose_plain > "$W/ndrroot/backups/tpl/config/docker-compose.yaml"
echo "fluentd conf" > "$W/ndrroot/backups/tpl/config/fluentd-note.txt"
tar czf "$W/ndrroot/backups/config-20261109-093937.tar.gz" -C "$W/ndrroot/backups/tpl" config
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A3: rc"
[ -f "$W/ndrroot/config/docker-compose.yaml" ] && ok "A3: compose из архива" || bad "A3: compose нет"
grep -q 'external: true' "$W/ndrroot/config/docker-compose.yaml" && ok "A3: сети дописаны" || bad "A3: сетей нет"
[ -f "$W/ndrroot/config/fluentd-note.txt" ] && ok "A3: прочие файлы архива восстановлены" || bad "A3: файлы архива не восстановлены"

# --- A4: ручной config/config → карантин + compose на место ---
W="$(new_work a4)"; setup_state "$W" "state=ok"
mkdir -p "$W/ndrroot/config/config"
compose_plain > "$W/ndrroot/config/config/docker-compose.yaml"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A4: rc"
[ -f "$W/ndrroot/config/docker-compose.yaml" ] && ok "A4: compose размещён из ручной копии" || bad "A4: compose нет"
[ -d "$W/ndrroot/config.quarantine-"* ] && ok "A4: ручной каталог в карантине" || bad "A4: карантина нет"
[ ! -d "$W/ndrroot/config/config" ] && ok "A4: config/config убран" || bad "A4: config/config остался"
grep -q 'external: true' "$W/ndrroot/config/docker-compose.yaml" && ok "A4: сети дописаны" || bad "A4: сетей нет"

# --- A5: --dry-run ничего не меняет ---
W="$(new_work a5)"; setup_state "$W" "state=ok"
mkdir -p "$W/ndrroot/config/config"
compose_plain > "$W/ndrroot/config/config/docker-compose.yaml"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --dry-run --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A5: rc"
[ -d "$W/ndrroot/config/config" ] && ok "A5: config/config не тронут" || bad "A5: config/config перемещён"
[ ! -f "$W/ndrroot/config/docker-compose.yaml" ] && ok "A5: compose не создан" || bad "A5: compose создан"
contains "$out" "dry-run" "A5: план показан"

# --- A6: восстановление файла, на который ссылается compose ---
W="$(new_work a6)"; setup_state "$W" "state=ok"
mkdir -p "$W/ndrroot/config" "$W/ndrroot/config.failed-001/config/fluentd"
compose_fixed > "$W/ndrroot/config/docker-compose.yaml"
cat >> "$W/ndrroot/config/docker-compose.yaml" <<'EOF'
configs:
  fluentd-config:
    file: fluentd/fluent.conf
EOF
echo "# fluent conf" > "$W/ndrroot/config.failed-001/config/fluentd/fluent.conf"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A6: rc"
[ -f "$W/ndrroot/config/fluentd/fluent.conf" ] && ok "A6: fluent.conf восстановлен" || bad "A6: fluent.conf нет"
contains "$out" "Все упомянутые файлы на месте" "A6: проверка файлов пройдена"

# --- A7: --no-up не поднимает стек ---
log_hasnt "$W" "compose-up" "A7: --no-up (стек не поднимался)"

# --- A8: инстанс есть, источников нет → rc 1 ---
W="$(new_work a8)"; setup_state "$W" "state=ok"
mkdir -p "$W/ndrroot/config/scirius"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 1 "A8: rc"
contains "$out" "Источник не найден" "A8: сообщение об отсутствии источников"

# --- A9: events-инстанс чинится сканом; архив содержит поддерево events-stack ---
W="$(new_work a9)"; setup_state "$W" "state=ok"
EV="$W/ndrroot/config/events-stack/opensearch_dashboards"
mkdir -p "$EV/config" "$EV/backups" \
  "$W/ndrroot/backups/tpl/config/events-stack/opensearch_dashboards/config"
compose_plain > "$W/ndrroot/backups/tpl/config/events-stack/opensearch_dashboards/config/docker-compose.yaml"
tar czf "$EV/backups/config-events.tar.gz" -C "$W/ndrroot/backups/tpl" config
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A9: rc"
[ -f "$EV/config/docker-compose.yaml" ] && ok "A9: events compose восстановлен" || bad "A9: events compose нет"
contains "$out" "opensearch_dashboards" "A9: events-инстанс найден сканом"
grep -q 'external: true' "$EV/config/docker-compose.yaml" && ok "A9: сети дописаны" || bad "A9: сетей нет"

# --- A10: --instance-dir для events-инстанса ---
W="$(new_work a10)"; setup_state "$W" "state=ok"
EV="$W/ndrroot/config/events-stack/opensearch_dashboards"
mkdir -p "$EV/config" "$EV/config.failed-001/config"
compose_plain > "$EV/config.failed-001/config/docker-compose.yaml"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --instance-dir "$EV" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A10: rc"
[ -f "$EV/config/docker-compose.yaml" ] && ok "A10: compose восстановлен по --instance-dir" || bad "A10: compose нет"

# --- A11: config/ отсутствует ЦЕЛИКОМ → создаётся, compose из архива корня ---
W="$(new_work a11)"; setup_state "$W" "state=ok"
EV="$W/ndrroot/config/events-stack/opensearch_dashboards"
mkdir -p "$EV" "$W/ndrroot/backups/tpl/config/events-stack/opensearch_dashboards/config"
compose_plain > "$W/ndrroot/backups/tpl/config/events-stack/opensearch_dashboards/config/docker-compose.yaml"
tar czf "$W/ndrroot/backups/config-20261109-093937.tar.gz" -C "$W/ndrroot/backups/tpl" config
out="$(PATH="$W/bin:$PATH" "$REPAIR" --instance-dir "$EV" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A11: rc"
[ -f "$EV/config/docker-compose.yaml" ] && ok "A11: config/ создан, compose из архива" || bad "A11: compose нет"
grep -q 'external: true' "$EV/config/docker-compose.yaml" && ok "A11: сети дописаны" || bad "A11: сетей нет"

# --- A12: скан находит events-инстанс с исчезнувшим config/ ---
W="$(new_work a12)"; setup_state "$W" "state=ok"
EV="$W/ndrroot/config/events-stack/opensearch_dashboards"
mkdir -p "$EV" "$W/ndrroot/backups/tpl/config/events-stack/opensearch_dashboards/config"
compose_plain > "$W/ndrroot/backups/tpl/config/events-stack/opensearch_dashboards/config/docker-compose.yaml"
# реалистичный архив: главное поддерево + поддерево events-stack (как config-<ts>.tar.gz)
compose_fixed > "$W/ndrroot/backups/tpl/config/docker-compose.yaml"
tar czf "$W/ndrroot/backups/config-main.tar.gz" -C "$W/ndrroot/backups/tpl" config
out="$(PATH="$W/bin:$PATH" "$REPAIR" --scan-root "$W/ndrroot" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A12: rc"
[ -f "$EV/config/docker-compose.yaml" ] && ok "A12: events-инстанс найден сканом, compose из архива" || bad "A12: compose нет"
[ -f "$W/ndrroot/config/docker-compose.yaml" ] && ok "A12: главный инстанс тоже восстановлен" || bad "A12: главный compose нет"

# --- A13: events-инстанс без источников, контейнеры живы → реконструкция compose ---
W="$(new_work a13)"; setup_state "$W" "state=ok"
EV="$W/ndrroot/config/events-stack/opensearch_dashboards"
mkdir -p "$EV"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --instance-dir "$EV" --no-up --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "A13: rc"
[ -f "$EV/config/docker-compose.yaml" ] && ok "A13: compose реконструирован" || bad "A13: compose нет"
CG="$EV/config/docker-compose.yaml"
grep -q 'opensearchproject/opensearch:3.3.1' "$CG" && ok "A13: образ opensearch из inspect" || bad "A13: образа opensearch нет"
grep -q 'opensearchproject/opensearch-dashboards:3.3.0' "$CG" && ok "A13: образ dashboards из inspect" || bad "A13: образа dashboards нет"
grep -q 'ghcr.io/stamusnetworks/stamus-images/fluentd:1.16' "$CG" && ok "A13: образ fluentd из inspect" || bad "A13: образа fluentd нет"
grep -q 'external: true' "$CG" && ok "A13: сеть external" || bad "A13: external нет"
grep -q 'config_network' "$CG" && ok "A13: фактическая сеть (config_network)" || bad "A13: config_network нет"
grep -q "condition: 'service_healthy'" "$CG" && ok "A13: depends_on с healthcheck" || bad "A13: depends_on нет"
grep -q '5601' "$CG" && ok "A13: порт dashboards из inspect" || bad "A13: порта нет"
grep -q 'unless-stopped' "$CG" && ok "A13: restart policy из inspect" || bad "A13: restart нет"
not_contains "$(cat "$CG")" 'scirius' "A13: чужие службы (scirius) не попали в events-compose"
contains "$out" "реконструирован из работающих контейнеров" "A13: сообщение о реконструкции"
contains "$out" "Проект compose валиден" "A13: проект валиден"
if python3 -c 'import yaml' 2>/dev/null; then
  python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$CG" \
    && ok "A13: YAML валиден (pyyaml)" || bad "A13: YAML невалиден"
fi

# --- A14: --dry-run при реконструкции — файл не создаётся ---
W="$(new_work a14)"; setup_state "$W" "state=ok"
EV="$W/ndrroot/config/events-stack/opensearch_dashboards"
mkdir -p "$EV"
out="$(PATH="$W/bin:$PATH" "$REPAIR" --instance-dir "$EV" --no-up --no-color --dry-run 2>&1)"; rc=$?
check_rc "$rc" 0 "A14: rc"
[ ! -f "$EV/config/docker-compose.yaml" ] && ok "A14: dry-run не создавал compose" || bad "A14: compose создан при dry-run"
contains "$out" "был бы реконструирован из контейнеров" "A14: план реконструкции показан"

# ============================================================================
echo "== Часть B: clearndr-events-restore.sh =="

setup_events_fs() {  # $1 — WORK: каталог инстанса с compose + eve-каталог со свежим файлом
  local W="$1"
  mkdir -p "$W/inst/config" "$W/eve"
  compose_fixed > "$W/inst/config/docker-compose.yaml"
  echo '{"event_type":"alert"}' > "$W/eve/eve.json"
  echo "$W/eve" > "$W/bin/eve-dir"
}

# --- B1: здоровый стек ---
W="$(new_work b1)"; setup_state "$W" "state=ok" "osd-patterns=logstash-*" "logstash-base=1234" "flow=1"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "B1: rc"
contains "$out" "Индекс-паттерны Dashboards: logstash-*" "B1: паттерн виден"
contains "$out" "События в индексах logstash-*: 1236" "B1: события посчитаны"
contains "$out" "Suricata eve.json обновляется" "B1: eve.json свежий"

# --- B2: пустой Dashboards (нет паттернов) ---
W="$(new_work b2)"; setup_state "$W" "state=ok" "logstash-base=500" "flow=1"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --no-color 2>&1)"; rc=$?
check_rc "$rc" 1 "B2: rc"
contains "$out" "Индекс-паттернов в Dashboards НЕТ" "B2: пустой Dashboards обнаружен"
contains "$out" "--fix" "B2: рекомендован --fix"
contains "$out" "События в индексах logstash-*: 502" "B2: данные на месте (проблема только в паттернах)"

# --- B3: --fix → kibana_reset в scirius ---
W="$(new_work b3)"; setup_state "$W" "state=ok" "logstash-base=500" "flow=1"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --fix --yes --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "B3: rc"
log_has "$W" "kibana-reset" "B3: kibana_reset выполнен в scirius"
contains "$out" "Индекс-паттерн logstash-* в Dashboards: ЕСТЬ" "B3: паттерн после kibana_reset"
contains "$out" "все устранены" "B3: проблемы диагностики устранены"

# --- B4: --fix без scirius → создание паттерна через API ---
W="$(new_work b4)"; setup_state "$W" "state=no-scirius" "logstash-base=500" "flow=1"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --fix --yes --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "B4: rc"
log_has "$W" "osd-pattern-created http://localhost:5601/api/saved_objects/index-pattern/logstash-*" "B4: паттерн создан через API"
contains "$out" "Индекс-паттерн logstash-* в Dashboards: ЕСТЬ" "B4: паттерн появился"

# --- B5: пустой том + старый том → копирование данных ---
W="$(new_work b5)"; setup_state "$W" "state=ok" "osd-patterns=logstash-*" "logstash-base=0" "flow=0" \
  "volumes=opensearch-data-$SEED
opensearch-data-OLDSEED001
fluentd-pos-$SEED
db-data-$SEED"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --fix --yes --no-color 2>&1)"; rc=$?
log_has "$W" "volume-copy opensearch-data-OLDSEED001->opensearch-data-$SEED" "B5: данные скопированы из старого тома"
contains "$out" "Кандидат: opensearch-data-OLDSEED001" "B5: старый том показан"
log_has "$W" "docker-stop config-opensearch-$SEED" "B5: стек остановлен перед копированием"
log_has "$W" "docker-start config-opensearch-$SEED" "B5: стек запущен обратно"

# --- B6: --skip-volume-copy ---
W="$(new_work b6)"; setup_state "$W" "state=ok" "osd-patterns=logstash-*" "logstash-base=0" "flow=0" \
  "volumes=opensearch-data-$SEED
opensearch-data-OLDSEED001
fluentd-pos-$SEED"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --fix --yes --skip-volume-copy --no-color 2>&1)"; rc=$?
log_hasnt "$W" "volume-copy" "B6: копирование пропущено"

# --- B7: fluentd остановлен → docker start ---
W="$(new_work b7)"; setup_state "$W" "state=fluentd-down" "osd-patterns=logstash-*" "logstash-base=10" "flow=1"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --fix --yes --no-color 2>&1)"; rc=$?
log_has "$W" "docker-start config-fluentd-$SEED" "B7: fluentd запущен"

# --- B8: несовпадение seed scirius ---
W="$(new_work b8)"; setup_state "$W" "state=ok" "osd-patterns=logstash-*" "logstash-base=10" "flow=1" "scirius-seed=DIFFERENTSEED"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --no-color 2>&1)"; rc=$?
contains "$out" "не совпадает с seed events-stack" "B8: предупреждение о разных seed"

# --- B9: eve.json устарел ---
W="$(new_work b9)"; setup_state "$W" "state=ok" "osd-patterns=logstash-*" "logstash-base=10" "flow=1"
setup_events_fs "$W"
mkdir -p "$W/eve-old"
echo '{}' > "$W/eve-old/eve.json"
touch -d "2 hours ago" "$W/eve-old/eve.json"
echo "$W/eve-old" > "$W/bin/eve-dir"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --no-color 2>&1)"; rc=$?
contains "$out" "не обновлялся" "B9: устаревший eve.json обнаружен"

# --- B10: --fix на здоровом стеке ничего не ломает ---
W="$(new_work b10)"; setup_state "$W" "state=ok" "osd-patterns=logstash-*" "logstash-base=777" "flow=1"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --fix --yes --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "B10: rc"
log_hasnt "$W" "kibana-reset" "B10: kibana_reset не вызывался (паттерн уже есть)"
log_hasnt "$W" "volume-copy" "B10: тома не копировались"
contains "$out" "уже есть — kibana_reset не требуется" "B10: лишних действий нет"
contains "$out" "События поступают: 781 → 783" "B10: приток событий подтверждён"

# --- B11: kibana_reset падает (400) → прямая загрузка дашбордов через REST ---
W="$(new_work b11)"; setup_state "$W" "state=ok" "logstash-base=500" "flow=1" "kibana-fail=1"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --fix --yes --no-color 2>&1)"; rc=$?
check_rc "$rc" 0 "B11: rc"
log_has "$W" "kibana-reset" "B11: kibana_reset предпринят"
log_has "$W" "docker-cp" "B11: дашборды скопированы из scirius"
log_has "$W" "osd-pattern-created http://localhost:5601/api/saved_objects/index-pattern/logstash-*" "B11: паттерн создан через API"
log_hasnt "$W" "docker-stop config-opensearch-dashboards-$SEED" "B11: .kibana не стирался (инжект помог)"
contains "$out" "Индекс-паттерн logstash-* в Dashboards: ЕСТЬ" "B11: паттерн после прямой загрузки"

# --- B12: kibana_reset и инжект падают → пересоздание .kibana → паттерн через API ---
W="$(new_work b12)"; setup_state "$W" "state=ok" "logstash-base=500" "flow=1" "kibana-fail=1" "no-dashboards-dir=1"
setup_events_fs "$W"
out="$(PATH="$W/bin:$PATH" "$EVENTS" --instance-dir "$W/inst" --fix --yes --no-color 2>&1)"; rc=$?
log_has "$W" "docker-stop config-opensearch-dashboards-$SEED" "B12: dashboards остановлен перед стиранием .kibana"
log_has "$W" "docker-start config-opensearch-dashboards-$SEED" "B12: dashboards запущен обратно"
log_has "$W" "osd-pattern-created" "B12: финальный фолбэк — паттерн через API"

# ============================================================================
echo
echo "Итог: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
