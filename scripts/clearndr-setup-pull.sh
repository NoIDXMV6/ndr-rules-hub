#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Настройка PULL-схемы доставки правил: Clear NDR сам забирает итоговый файл
# с NDR Rules Hub по HTTP и обновляется по своему расписанию.
#
# Использование:
#   CLEAR_NDR_URL=https://clearndr.local CLEAR_NDR_TOKEN=xxxx \
#   HUB_URL=http://rules-hub.local:3080/api/export \
#   ./clearndr-setup-pull.sh
#
# Что делает (идемпотентно — безопасно перезапускать):
#   1. проверяет доступность файла на Hub;
#   2. находит или создаёт источник (source) типа HTTP URL на файл Hub;
#   3. находит или создаёт набор (ruleset) и привязывает источник;
#   4. включает категорию источника в наборе (если она уже создана);
#   5. применяет набор (update_push_all — пересборка, push, перезапуск Suricata).
#
# Переменные:
#   CLEAR_NDR_URL, CLEAR_NDR_TOKEN  — см. clearndr-check.sh
#   HUB_URL       — адрес итогового файла на Hub (по умолчанию http://127.0.0.1:3080/api/export)
#   SOURCE_NAME   — имя источника в Clear NDR (по умолчанию «NDR Rules Hub»)
#   RULESET_NAME  — имя набора в Clear NDR (по умолчанию «NDR Rules Hub»)
#   CURL_INSECURE — 1 (по умолчанию) — добавить -k
#
# Требования: curl, python3.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="${CLEAR_NDR_URL:-}"; BASE="${BASE%/}"
TOKEN="${CLEAR_NDR_TOKEN:-}"
HUB_URL="${HUB_URL:-http://127.0.0.1:3080/api/export}"
SOURCE_NAME="${SOURCE_NAME:-NDR Rules Hub}"
RULESET_NAME="${RULESET_NAME:-NDR Rules Hub}"
INSECURE="${CURL_INSECURE:-1}"
KFLAG=""; [ "$INSECURE" = "1" ] && KFLAG="-k" || true
AUTH="Authorization: Token ${TOKEN}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "ОШИБКА: $*" >&2; exit 1; }
[ -n "$BASE" ]  || fail "задайте CLEAR_NDR_URL"
[ -n "$TOKEN" ] || fail "задайте CLEAR_NDR_TOKEN"
[ -n "$HUB_URL" ] || fail "задайте HUB_URL"

# 1. Hub доступен?
echo "▶ 1/5 Проверка файла правил на Hub: ${HUB_URL}"
HEAD=$(curl -sS -o /dev/null -w '%{http_code}' "$HUB_URL" || true)
case "$HEAD" in
  200) echo "  ✓ файл доступен (HTTP 200)" ;;
  *) fail "Hub недоступен (HTTP ${HEAD}). Проверьте адрес (обычно http://<hub-host>:3080/api/export) и, что на Hub выполнена сборка" ;;
esac

# 2. Источник
echo "▶ 2/5 Источник «${SOURCE_NAME}»"
curl -sS $KFLAG -G "${BASE}/rest/rules/source/" -H "$AUTH" \
  --data-urlencode "name=${SOURCE_NAME}" -o "$TMP/src.json"
SRCPK=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); r=(d.get("results") or [None])[0]; print(r["pk"] if r else "")' "$TMP/src.json")
if [ -n "$SRCPK" ]; then
  echo "  ✓ найден (pk=${SRCPK})"
else
  curl -sS $KFLAG -X POST "${BASE}/rest/rules/source/" -H "$AUTH" -H 'Content-Type: application/json' -d @- > "$TMP/created.json" <<JSON
{"name": "${SOURCE_NAME}", "method": "http", "datatype": "sig", "uri": "${HUB_URL}", "use_sys_proxy": false, "comment": "итоговый набор правил NDR Rules Hub (pull)"}
JSON
  SRCPK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pk"])' "$TMP/created.json")
  echo "  ✓ создан HTTP-источник (pk=${SRCPK}) → ${HUB_URL}"
fi

# 3. Набор правил
echo "▶ 3/5 Набор правил «${RULESET_NAME}»"
curl -sS $KFLAG -G "${BASE}/rest/rules/ruleset/" -H "$AUTH" \
  --data-urlencode "name=${RULESET_NAME}" -o "$TMP/rs.json"
RSPK=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); r=(d.get("results") or [None])[0]; print(r["pk"] if r else "")' "$TMP/rs.json")
if [ -n "$RSPK" ]; then
  echo "  ✓ найден (pk=${RSPK})"
  curl -sS $KFLAG "${BASE}/rest/rules/ruleset/${RSPK}/" -H "$AUTH" -o "$TMP/rs1.json"
  HAS=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
srcs = [s['pk'] if isinstance(s, dict) else s for s in (d.get('sources') or [])]
print('yes' if ${SRCPK} in srcs else 'no')" "$TMP/rs1.json")
  if [ "$HAS" = "no" ]; then
    printf '{"sources": [%s]}' "${SRCPK}" > "$TMP/patch.json"
    curl -sS $KFLAG -X PATCH "${BASE}/rest/rules/ruleset/${RSPK}/" -H "$AUTH" \
      -H 'Content-Type: application/json' -d @"$TMP/patch.json" > /dev/null
    echo "  ✓ источник добавлен в набор"
  fi
else
  printf '{"name": "%s", "descr": "Набор из NDR Rules Hub", "sources": [%s]}' "${RULESET_NAME}" "${SRCPK}" > "$TMP/newrs.json"
  curl -sS $KFLAG -X POST "${BASE}/rest/rules/ruleset/" -H "$AUTH" \
    -H 'Content-Type: application/json' -d @"$TMP/newrs.json" -o "$TMP/newrs-resp.json"
  RSPK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pk"])' "$TMP/newrs-resp.json")
  echo "  ✓ создан набор (pk=${RSPK}), источник привязан"
fi

# 4. Категория источника в наборе
echo "▶ 4/5 Включение категории источника в наборе"
curl -sS $KFLAG -G "${BASE}/rest/rules/category/" -H "$AUTH" \
  --data-urlencode "source=${SRCPK}" -o "$TMP/cat.json"
CATPK=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); r=(d.get("results") or [None])[0]; print(r["pk"] if r else "")' "$TMP/cat.json")
if [ -z "$CATPK" ]; then
  echo "  ⚠ у источника ещё нет категорий — они появятся после первой загрузки (шаг 5) или кнопки Update у источника; затем повторите скрипт"
else
  printf '{"ruleset": %s, "comment": "NDR Rules Hub setup"}' "${RSPK}" > "$TMP/enable.json"
  curl -sS $KFLAG -X POST "${BASE}/rest/rules/category/${CATPK}/enable/" -H "$AUTH" \
    -H 'Content-Type: application/json' -d @"$TMP/enable.json" > /dev/null
  echo "  ✓ категория [${CATPK}] включена в набор [${RSPK}]"
fi

# 5. Применить
echo "▶ 5/5 Применение набора (update_push_all)"
APPLY=$(curl -sS $KFLAG -o "$TMP/apply.json" -w '%{http_code}' -X POST "${BASE}/rest/suricata/update_push_all/" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"comment": "NDR Rules Hub: pull setup"}' || true)
if [ "$APPLY" = "200" ]; then
  echo "  ✓ набор собран и применён к Suricata"
elif [ "$APPLY" = "400" ]; then
  echo "  ⚠ Clear NDR ответил ошибкой применения: $(cat "$TMP/apply.json")"
  echo "    Это нормально при первом запуске (пустой набор/нет категорий). Загрузите источник (Update) и повторите."
else
  echo "  ⚠ HTTP ${APPLY}: $(cat "$TMP/apply.json" 2>/dev/null || echo 'нет тела')"
fi

echo
echo "✓ PULL-схема настроена. Автообновление на стороне Clear NDR — любой из вариантов:"
echo "  a) встроенное расписание: интерфейс Clear NDR → меню Suricata → Update → включить"
echo "     «Reload» + «Push» и задать Recurrence (например Daily) → задача сама будет"
echo "     забирать файл с Hub, пересобирать набор и перезапускать Suricata;"
echo "  b) системный cron на любом сервере:"
echo "     «0 5 * * * curl -sk -X POST -H 'Authorization: Token <токен>' ${BASE}/rest/suricata/update_push_all/»"
echo "  c) автоматизация на стороне Hub: Настройки → Расписание (cron) → включить +"
echo "     «Экспортировать после сборки» (режим Clear NDR REST — см. push-схему)."
