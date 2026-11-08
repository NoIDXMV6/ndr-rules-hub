#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Проверка доступа к REST API Clear NDR (Scirius) — первый шаг интеграции.
#
# Использование:
#   CLEAR_NDR_URL=https://clearndr.local CLEAR_NDR_TOKEN=xxxx ./clearndr-check.sh
#
# Переменные:
#   CLEAR_NDR_URL    базовый URL Clear NDR (без /rest)
#   CLEAR_NDR_TOKEN  API-токен (Clear NDR → меню пользователя → Edit Token → Regenerate)
#   CURL_INSECURE    1 (по умолчанию) — добавить -k (self-signed сертификаты appliance)
#
# Требования: curl, python3 (стандартная библиотека).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="${CLEAR_NDR_URL:-}"; BASE="${BASE%/}"
TOKEN="${CLEAR_NDR_TOKEN:-}"
INSECURE="${CURL_INSECURE:-1}"
KFLAG=""; [ "$INSECURE" = "1" ] && KFLAG="-k" || true
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "ОШИБКА: $*" >&2; exit 1; }
[ -n "$BASE" ]  || fail "задайте CLEAR_NDR_URL (например https://clearndr.local)"
[ -n "$TOKEN" ] || fail "задайте CLEAR_NDR_TOKEN (Clear NDR → меню пользователя → Edit Token → Regenerate)"

echo "▶ Проверка REST API Clear NDR: ${BASE}"
HTTP1=$(curl -sS $KFLAG -G -o /dev/null -w '%{http_code}' --data-urlencode 'name=__probe__' \
  "${BASE}/rest/rules/source/" -H "Authorization: Token ${TOKEN}" || true)
case "$HTTP1" in
  200) echo "  ✓ сервер отвечает, токен принят (HTTP 200)" ;;
  401|403) fail "токен отклонён (HTTP ${HTTP1}). Сгенерируйте новый: меню пользователя → User Settings → Edit Token → Regenerate; заголовок должен быть «Authorization: Token <код>»" ;;
  000) fail "сервер недоступен: ${BASE} — проверьте адрес/сеть/брандмауэр" ;;
  *) fail "неожиданный ответ HTTP ${HTTP1} — убедитесь, что ${BASE} это Clear NDR, а URL указан без /rest" ;;
esac

echo "▶ Источники правил (sources):"
curl -sS $KFLAG "${BASE}/rest/rules/source/" -H "Authorization: Token ${TOKEN}" -o "$TMP/src.json"
python3 - "$TMP/src.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
items = d.get("results", d if isinstance(d, list) else [])
print(f'  всего: {d.get("count", len(items))}')
for s in items:
    print(f'  • [{s["pk"]}] {s["name"]} (method={s["method"]}, datatype={s["datatype"]}, uri={s.get("uri")})')
PY

echo "▶ Наборы правил (rulesets):"
curl -sS $KFLAG "${BASE}/rest/rules/ruleset/" -H "Authorization: Token ${TOKEN}" -o "$TMP/rs.json"
python3 - "$TMP/rs.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
items = d.get("results", d if isinstance(d, list) else [])
print(f'  всего: {d.get("count", len(items))}')
for r in items:
    print(f'  • [{r["pk"]}] {r["name"]} (sources: {r.get("sources")})')
PY

echo
echo "✓ API доступен. Дальше:"
echo "  pull-схема : ./clearndr-setup-pull.sh   (Clear NDR сам забирает файл с Hub)"
echo "  push-схема : ./clearndr-push.sh         (Hub/скрипт сам отправляет файл)"
echo "  mock-тест  : python3 scripts/clearndr-mock-server.py --port 8080"
