#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PUSH-доставка готового файла правил в Clear NDR через REST API (Scirius):
#   найти/создать источник → upload (импорт правил) → update_push_all.
#
# Использование:
#   CLEAR_NDR_URL=https://clearndr.local CLEAR_NDR_TOKEN=xxxx \
#   RULES_FILE=./clearndr-import.rules ./clearndr-push.sh
#
# Годится для cron (короткий вывод, ненулевой код выхода при ошибке):
#   15 5 * * * CLEAR_NDR_URL=… CLEAR_NDR_TOKEN=… RULES_FILE=… /opt/hub/clearndr-push.sh
#
# Переменные:
#   CLEAR_NDR_URL, CLEAR_NDR_TOKEN  — см. clearndr-check.sh
#   RULES_FILE  — путь к .rules файлу (обязательно)
#   SOURCE_NAME — имя источника в Clear NDR (по умолчанию «NDR Rules Hub»)
#   APPLY       — 1 (по умолчанию) вызвать update_push_all после загрузки
#   CURL_INSECURE — 1 (по умолчанию) — добавить -k
#
# Требования: curl, python3.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="${CLEAR_NDR_URL:-}"; BASE="${BASE%/}"
TOKEN="${CLEAR_NDR_TOKEN:-}"
FILE="${RULES_FILE:-}"
SOURCE_NAME="${SOURCE_NAME:-NDR Rules Hub}"
APPLY="${APPLY:-1}"
INSECURE="${CURL_INSECURE:-1}"
KFLAG=""; [ "$INSECURE" = "1" ] && KFLAG="-k" || true
AUTH="Authorization: Token ${TOKEN}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "ОШИБКА: $*" >&2; exit 1; }
[ -n "$BASE" ]  || fail "задайте CLEAR_NDR_URL"
[ -n "$TOKEN" ] || fail "задайте CLEAR_NDR_TOKEN"
[ -n "$FILE" ] && [ -f "$FILE" ] || fail "файл RULES_FILE не найден: ${FILE:-<пусто>}"

curl -sS $KFLAG -G "${BASE}/rest/rules/source/" -H "$AUTH" \
  --data-urlencode "name=${SOURCE_NAME}" -o "$TMP/src.json" \
  || fail "нет доступа к Clear NDR (проверьте URL/токен: clearndr-check.sh)"
SRCPK=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); r=(d.get("results") or [None])[0]; print(r["pk"] if r else "")' "$TMP/src.json")

if [ -z "$SRCPK" ]; then
  printf '{"name": "%s", "method": "local", "datatype": "sig", "use_sys_proxy": false, "comment": "создан clearndr-push.sh"}' "${SOURCE_NAME}" > "$TMP/newsrc.json"
  curl -sS $KFLAG -X POST "${BASE}/rest/rules/source/" -H "$AUTH" \
    -H 'Content-Type: application/json' -d @"$TMP/newsrc.json" -o "$TMP/newsrc-resp.json"
  SRCPK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pk"])' "$TMP/newsrc-resp.json")
  echo "создан источник «${SOURCE_NAME}» (pk=${SRCPK})"
fi

HTTPU=$(curl -sS $KFLAG -o "$TMP/upl.json" -w '%{http_code}' \
  -X POST "${BASE}/rest/rules/source/${SRCPK}/upload/" -H "$AUTH" \
  -F "file=@${FILE}" -F "comment=NDR Rules Hub push $(date '+%F %T')" || true)
[ "$HTTPU" = "200" ] || fail "upload не принят (HTTP ${HTTPU}): $(cat "$TMP/upl.json" 2>/dev/null || echo 'нет тела')"
if grep -qi 'conflicting SID\|Duplicate sids' "$TMP/upl.json"; then
  fail "конфликт SID — включите дедупликацию в NDR Rules Hub и пересоберите файл"
fi
python3 - "$TMP/upl.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit(0)
if d.get("upload") == "ok":
    print(f'upload ok: {d.get("rules", "?")} правил, sha256={str(d.get("sha256", "?"))[:12]}…')
PY

if [ "$APPLY" = "1" ]; then
  RES=$(curl -sS $KFLAG -X POST "${BASE}/rest/suricata/update_push_all/" -H "$AUTH" \
    -H 'Content-Type: application/json' -d '{"comment": "clearndr-push.sh: применить набор"}' 2>&1) \
    || fail "update_push_all не выполнен: ${RES}"
  echo "apply ok: ${RES}"
else
  echo "файл загружен в Clear NDR; применение отключено (APPLY=0) — примените набор вручную"
fi
