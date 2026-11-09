#!/usr/bin/env bash
# ============================================================================
# e2e-hub-update.sh — сквозная проверка раздела «Обновление Clear NDR».
# Поднимает собранный standalone-сервер хаба с моками (docker/stamusctl/sysctl/
# curl/systemctl) в PATH, режим обновления local, и через HTTP API:
#   1) сохраняет настройки, 2) читает статус (версия/релиз/предпроверки),
#   3) запускает обновление, 4) поллит лог до rc, 5) проверяет итог.
# Моки те же по духу, что в test-clearndr-update-mock.sh.
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SERVER_JS="$ROOT/.next/standalone/server.js"
[ -f "$SERVER_JS" ] || { echo "нет сборки: $SERVER_JS (сначала bun run build)"; exit 1; }
SCRIPT="$ROOT/scripts/clearndr-update.sh"

WORK="$(mktemp -d /tmp/e2e-hub.XXXXXX)"
mkdir -p "$WORK/bin" "$WORK/instance/config" "$WORK/data"
PORT=3210
SEED="FNISvONwp2TtteCD"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# ---- моки -------------------------------------------------------------------
cat > "$WORK/instance/config/docker-compose.yml" <<EOF
services:
  opensearch:
    image: opensearchproject/opensearch:2.5.0
  db:
    image: postgres:16
EOF

cat > "$WORK/bin/stamusctl" <<EOF
#!/usr/bin/env bash
MOCKBIN="\$(dirname "\$(command -v stamusctl)")"
SEED="\$(cat "\$MOCKBIN/seed")"
case "\$1" in
  version) echo "stamusctl version 1.0.0 (build test)" ;;
  config)
    if [ "\$2" = "version" ]; then echo "instance config, template version: 1.2.3"
    elif [ "\$2" = "get" ] && [ "\$3" = "suricata.interfaces" ]; then echo "suricata.interfaces: tzsp0"
    elif [ "\$2" = "set" ]; then exit 0
    else echo "opensearch.memory: 2g"; fi ;;
  compose)
    case "\$2" in
      ps)      echo "fake-db-id" ;;
      pull)    echo "opensearch Pulled" ;;
      update)  sed -i 's/opensearch:2.5.0/opensearch:3.3.1/; s/postgres:16/postgres:17/' "\$PWD/config/docker-compose.yml"; echo "template updated" ;;
      up)      echo "stack started" ;;
      *)       exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
EOF

cat > "$WORK/bin/docker" <<EOF
#!/usr/bin/env bash
MOCKBIN="\$(dirname "\$(command -v docker)")"
SEED="\$(cat "\$MOCKBIN/seed")"
FMT=""; prev=""
for a in "\$@"; do [ "\$prev" = "--format" ] && FMT="\$a"; prev="\$a"; done
case "\$1 \$2" in
  "ps "*)
    case "\$FMT" in
      *"CT\\t"*) for s in opensearch scirius db suricata nginx; do printf 'CT\\tconfig-%s-%s\\tUp 2 minutes (healthy)\\n' "\$s" "\$SEED"; done ;;
      *'{{.Names}} {{.Status}}'*) for s in opensearch scirius db suricata nginx; do printf 'config-%s-%s Up 2 minutes (healthy)\n' "\$s" "\$SEED"; done ;;
      *) for s in opensearch scirius db suricata nginx; do printf 'config-%s-%s\n' "\$s" "\$SEED"; done ;;
    esac ;;
  "volume ls") printf 'db-data-%s\nopensearch-data-%s\n' "\$SEED" "\$SEED" ;;
  "info "*) echo "/tmp" ;;
  "exec "*) case "\$*" in *pg_dumpall*) echo "CREATE TABLE rules_source;" ;; *pg_isready*) echo ok ;; *psql*) echo "RESTORE DUMP OK" ;; *) echo "POSTGRES_USER=selks" ;; esac ;;
  "run "*)
    prev=""; dst=""; f=""
    for a in "\$@"; do
      case "\$a" in *:/dst) dst="\${a%:/dst}" ;; esac
      case "\$a" in /dst/*) f="\${a#/dst/}" ;; esac
      prev="\$a"
    done
    [ -n "\$dst" ] && [ -n "\$f" ] && echo "mock volume backup" > "\$dst/\$f"
    exit 0 ;;
  *) exit 0 ;;
esac
EOF

cat > "$WORK/bin/sysctl" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "-n" ] && echo 262144 && exit 0
exit 0
EOF

cat > "$WORK/bin/curl" <<EOF
#!/usr/bin/env bash
# перехватываем только то, что нужно скрипту обновления; остальное — реальный curl
for a in "\$@"; do
  case "\$a" in
    *api.github.com*) echo '{"tag_name": "v9.9.9", "published_at": "2026-11-01T00:00:00Z", "html_url": "https://github.com/x/r/releases/tag/v9.9.9"}'; exit 0 ;;
  esac
done
if echo "\$@" | grep -q 'http_code'; then echo "200"; exit 0; fi
exec /usr/bin/curl "\$@"
EOF

cat > "$WORK/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$*" in *list-unit-files*) exit 0 ;; esac
exit 0
EOF
chmod +x "$WORK/bin/"* 2>/dev/null
echo "$SEED" > "$WORK/bin/seed"

# ---- запуск сервера ----------------------------------------------------------
# как в docker-entrypoint.sh: БД создаётся из схемы (в образе — шаблон стадии builder)
(cd "$ROOT" && DATABASE_URL="file:$WORK/data/hub.db" bunx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1) || {
  echo "не удалось создать БД для e2e"; exit 1; }
# offline-источник «последнего релиза» (в песочнице GitHub недоступен)
cat > "$WORK/releases.json" <<'JSON'
{"tag_name": "v9.9.9", "published_at": "2026-11-01T00:00:00Z", "html_url": "https://github.com/StamusNetworks/stamusctl-templates/releases/tag/v9.9.9"}
JSON
export PORT RULES_DATA_DIR="$WORK/data"
export CLEARNDR_RELEASES_JSON="$WORK/releases.json"
export DATABASE_URL="file:$WORK/data/hub.db"
export CLEARNDR_UPDATE_SCRIPT="$SCRIPT"
export PATH="$WORK/bin:$PATH"
node "$SERVER_JS" > "$WORK/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "== 1. Настройки (PUT) =="
R="$(curl -s -X PUT "http://127.0.0.1:$PORT/api/clearndr-update" -H 'Content-Type: application/json' -d "{
  \"updateMode\":\"local\",
  \"instanceDir\":\"$WORK/instance\",
  \"scriptPath\":\"$WORK/instance/clearndr-update.sh\",
  \"healthUrl\":\"http://127.0.0.1:$PORT/\",
  \"sudoMode\":\"plain\"
}")"
echo "$R" | grep -q '"updateMode":"local"' && ok "настройки сохранены" || bad "настройки: $R"

echo "== 2. Статус: версия/релиз/предпроверки =="
R="$(curl -s "http://127.0.0.1:$PORT/api/clearndr-update")"
echo "$R" | grep -q '"stackVersion":"1.2.3"' && ok "текущая версия определена (1.2.3)" || bad "stackVersion: $R"
echo "$R" | grep -q '"tag":"v9.9.9"' && ok "последний релиз получен (v9.9.9)" || bad "latest: $R"
echo "$R" | grep -q '"updateAvailable":true' && ok "обновление доступно" || bad "updateAvailable: $R"
echo "$R" | grep -q '"maxMapCount":262144' && ok "preflight max_map_count" || bad "maxMapCount: $R"
echo "$R" | grep -q '"up":true' && ok "контейнеры стека видны" || bad "containers: $R"

echo "== 3. Запуск обновления =="
R="$(curl -s -X POST "http://127.0.0.1:$PORT/api/clearndr-update" -H 'Content-Type: application/json' -d '{"action":"start","options":{"version":"v9.9.9","opensearchData":"keep","healthTimeout":120}}')"
RUN_ID="$(echo "$R" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')"
[ -n "$RUN_ID" ] && ok "прогон запущен ($RUN_ID)" || bad "start: $R"

echo "== 4. Поллинг до завершения =="
FINAL=""
for i in $(seq 1 120); do
  R="$(curl -s "http://127.0.0.1:$PORT/api/clearndr-update?log=$RUN_ID")"
  if echo "$R" | grep -q '"active":false'; then FINAL="$R"; break; fi
  sleep 1
done
[ -n "$FINAL" ] || { bad "прогон не завершился за 120с"; FINAL="$R"; }
echo "$FINAL" | grep -q '"exitCode":0' && ok "обновление завершено успешно (rc=0)" || bad "итог: $FINAL"
echo "$FINAL" | grep -qF "Обновление Clear NDR завершено" && ok "в логе есть итоговый отчёт" || bad "нет итогового отчёта в логе"
echo "$FINAL" | grep -qF "v9.9.9" && ok "в логе фигурирует целевая версия" || bad "нет целевой версии в логе"

echo "== 5. Статус после: история и состояние =="
R="$(curl -s "http://127.0.0.1:$PORT/api/clearndr-update")"
echo "$R" | grep -qF "\"runId\":\"$RUN_ID\"" && ok "прогон в истории" || bad "нет прогона в истории: $R"
echo "$R" | grep -q '"exitCode":0' && ok "в истории rc=0" || bad "rc в истории"
echo "$R" | grep -q '"webHttp":"200"' && ok "web UI проверен после обновления" || bad "webHttp: $R"

echo "== 6. Неудача: код ошибки доходит до UI =="
# инстанс без config/ → preflight скрипта завершится с rc=1
curl -s -X PUT "http://127.0.0.1:$PORT/api/clearndr-update" -H 'Content-Type: application/json' \
  -d "{\"updateMode\":\"local\",\"instanceDir\":\"$WORK/empty\",\"scriptPath\":\"$WORK/empty/clearndr-update.sh\",\"healthUrl\":\"http://127.0.0.1:$PORT/\",\"sudoMode\":\"plain\"}" >/dev/null
R="$(curl -s -X POST "http://127.0.0.1:$PORT/api/clearndr-update" -H 'Content-Type: application/json' -d '{"action":"start","options":{"version":"v9.9.9"}}')"
RUN2="$(echo "$R" | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')"
FINAL2=""
for i in $(seq 1 60); do
  R="$(curl -s "http://127.0.0.1:$PORT/api/clearndr-update?log=$RUN2")"
  echo "$R" | grep -q '"active":false' && { FINAL2="$R"; break; }
  sleep 1
done
[ -n "$FINAL2" ] && echo "$FINAL2" | grep -q '"exitCode":1' && ok "неудача дошла как rc=1" || bad "неудача: $FINAL2"
echo "$FINAL2" | grep -qF "Каталог конфигурации инстанса не найден" && ok "причина отказа видна в логе" || bad "причины нет в логе"

echo
echo "ИТОГО: ok=$PASS, fail=$FAIL"
[ "$FAIL" -eq 0 ] || { echo "(артефакты: $WORK; лог сервера: $WORK/server.log)"; exit 1; }
rm -rf "$WORK"
exit 0
