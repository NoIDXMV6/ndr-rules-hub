#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-clearndr-osd-mock.sh — mock-стенд для скриптов «Дашборды OpenSearch»:
#   • clearndr-osd-analytics-setup.sh (status / apply-* / remove-managed)
#   • clearndr-osd-dashboard-import.sh (list / import / remove)
# Фейковый docker (shim) направляет docker exec … curl http://127.0.0.1:9200
# на локальный fake-сервер OpenSearch (python http.server), который также
# пишет журнал запросов для проверок.
# ─────────────────────────────────────────────────────────────────────────────
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d /tmp/osd-mock.XXXXXX)"
[ "${KEEP_MOCK:-0}" = 1 ] && printf 'MOCK_DIR=%s\n' "$T"
MOCK_PORT=$((19000 + RANDOM % 2000))
MOCK_URL="http://127.0.0.1:$MOCK_PORT"
PASS=0 FAIL=0

ok()  { PASS=$((PASS+1)); printf '  ok: %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL: %s\n' "$1"; }
check() { # $1=имя $2=условие (0 → ok)
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi
}
grepq() { if [ $# -ge 2 ]; then printf '%s' "$2" | grep -q "$1"; else grep -q "$1"; fi; }

# ── fake OpenSearch ──────────────────────────────────────────────────────────
cat > "$T/mock_os.py" <<'PYOS'
import json, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

REQ_LOG = sys.argv[2]
ST = {"monitors": [], "adets": [], "sdets": [], "kibana": {}, "bulk": []}

def log(line):
    with open(REQ_LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")

class H(BaseHTTPRequestHandler):
    def _send(self, obj, code=200, text=None):
        body = (text if text is not None else json.dumps(obj, ensure_ascii=False)).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json" if text is None else "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n).decode("utf-8") if n else ""

    def do_GET(self):
        u = urlparse(self.path); p = unquote(u.path)
        log("GET " + self.path)
        if p == "/":
            return self._send({"cluster_name": "clearndr-mock", "version": {"number": "3.3.0"}})
        if p == "/_cat/plugins":
            return self._send(None, text="opensearch-alerting\nopensearch-anomaly-detection\nopensearch-security-analytics\n")
        if p.startswith("/_cat/indices/logstash-"):
            return self._send(None, text="logstash-2026.11.10 295000\n")
        if p == "/_cat/indices":
            # JSON-формат (h=index,docs.count) — для автоопределения источника данных
            return self._send([
                {"index": "logstash-2026.11.10", "docs.count": "210000"},
                {"index": "logstash-2026.11.09", "docs.count": "85000"},
                {"index": "security-auditlog-2026.11.10", "docs.count": "1234"},
            ])
        if p.endswith("/_search") and "q=_exists_" in self.path:
            # проба «есть ли тут EVE-события»: только logstash-* содержит event_type
            idx = p.rsplit("/_search", 1)[0].strip("/")
            v = 210000 if idx.startswith("logstash") else 0
            return self._send({"hits": {"total": {"value": v, "relation": "eq"}, "hits": []}})
        if p.endswith("/_count"):
            v = 295000 if "logstash" in p else 0
            return self._send({"count": v})
        if p.endswith("/_field_caps"):
            raw = unquote(u.query).split("fields=")[-1].split("&")[0]
            T = {}
            def add(n, t, agg=True):
                T.setdefault(n, {})[t] = {"searchable": True, "aggregatable": agg}
            add("src_ip", "ip"); add("dest_ip", "ip")
            for n in ("src_port", "dest_port", "alert.severity", "fileinfo.size",
                      "flow.bytes_toserver", "flow.bytes_toclient", "flow.packets_toserver"):
                add(n, "long")
            for n in ("event_type", "dns.type", "dns.rcode", "http.http_method",
                      "http.http_user_agent", "alert.signature_id", "alert.category",
                      "tls.client.server_name", "tls.ja3.hash", "fileinfo.filename"):
                add(n, "keyword")
            for n in ("proto", "app_proto", "dns.rrname", "alert.signature",
                      "http.hostname", "http.url", "fileinfo.magic"):
                add(n, "text", agg=False)        # динамический маппинг: text без agg
                add(n + ".keyword", "keyword")   # …и keyword-подполе
            for n in ("timestamp", "@timestamp"):
                add(n, "date")
            # поля-«объекты»: в _field_caps у родительских контейнеров (dns, http,
            # tls, flow, fileinfo, alert) единственный вариант типа «object» —
            # именно на них падал fetch_ip_fields (StopIteration на пустом
            # множестве типов), поэтому они обязаны быть в моке
            for n in ("dns", "http", "tls", "fileinfo", "alert", "flow", "sip"):
                T.setdefault(n, {})["object"] = {"searchable": False, "aggregatable": False}
            sel = [s for s in raw.split(",") if s]
            if "*" in sel:
                return self._send({"fields": T})
            return self._send({"fields": {k: v for k, v in T.items() if k in sel}})
        if p.startswith("/_plugins/_alerting/monitors"):
            return self._send({"hits": {"hits": [{"_id": m["id"], "_source": {"name": m["name"]}} for m in ST["monitors"]]}})
        if p.startswith("/_plugins/_anomaly_detection/detectors"):
            return self._send({"hits": {"hits": [{"_id": m["id"], "_source": {"name": m["name"]}} for m in ST["adets"]]}})
        if p.startswith("/_plugins/_security_analytics/detectors/_search"):
            return self._send({"hits": {"hits": [{"_id": m["id"], "_source": {"name": m["name"]}} for m in ST["sdets"]]}})
        if p.startswith("/_plugins/_security_analytics/detectors"):
            return self._send({"hits": {"hits": [{"_id": m["id"], "_source": {"name": m["name"]}} for m in ST["sdets"]]}})
        if p.startswith("/.kibana/_search"):
            if "q=_id:ndr-pack" in self.path:
                hits = [{"_id": k} for k in ST["kibana"] if "ndr-pack-" in k]
                return self._send({"hits": {"total": {"value": len(hits), "relation": "eq"}, "hits": hits}})
            if "type:index-pattern" in self.path:
                hits = [{"_id": k, "_source": v} for k, v in ST["kibana"].items()
                        if k.startswith("index-pattern:")]
                return self._send({"hits": {"total": {"value": len(hits), "relation": "eq"}, "hits": hits}})
            return self._send({"hits": {"total": {"value": 0, "relation": "eq"}, "hits": []}})
        if p.startswith("/.kibana/_doc/"):
            doc = ST["kibana"].get(p.rsplit("/", 1)[-1])
            if doc is None:
                return self._send({"error": "not_found"}, code=404)
            return self._send({"_id": p.rsplit("/", 1)[-1], "_source": doc})
        return self._send({"error": "no_route"}, code=404)

    def do_POST(self):
        u = urlparse(self.path); p = unquote(u.path)
        body = self._read_body()
        full = p.startswith("/.kibana/")   # для kibana-маршрутов пишем тело целиком (проверки)
        log("POST " + self.path + (" BODY=" + body if full else " BODY=" + body[:2000]))
        if p == "/__ctl/seed_pattern":
            # сценарий «на хосте уже есть урезанный index-pattern от SELKS»
            for k in [k for k in ST["kibana"] if k.startswith("index-pattern:")]:
                ST["kibana"].pop(k, None)
            ST["kibana"]["index-pattern:06e1e3c0-c1c7-11e8-9888-3f5bc9c31629"] = {
                "type": "index-pattern",
                "index-pattern": {
                    "title": "logstash-*", "timeFieldName": "timestamp",
                    "fields": json.dumps([
                        {"name": "proto", "type": "string", "esTypes": ["text"],
                         "count": 1, "scripted": False, "searchable": True,
                         "aggregatable": False, "readFromDocValues": False},
                        {"name": "src_ip", "type": "ip", "esTypes": ["ip"],
                         "count": 1, "scripted": False, "searchable": True,
                         "aggregatable": True, "readFromDocValues": True},
                        # маркер SELKS: при обновлении полей паттерна запись
                        # обязана выжить (merge, а не замена)
                        {"name": "selks_custom_field", "type": "string",
                         "esTypes": ["keyword"], "count": 1, "scripted": False,
                         "searchable": True, "aggregatable": True,
                         "readFromDocValues": True},
                    ]),
                },
                "migrationVersion": {"index-pattern": "7.9.3"},
            }
            return self._send({"ok": True})
        if p == "/__ctl/seed_host":
            # сценарий реального хоста clearNDR: зонтичный SELKS-паттерн с
            # «мёртвым» полем времени (данные есть, значения поля времени — нет)
            # и decoy-паттерн logstash-smb-* без данных; старый код брал их
            # по фолбэку «любой logstash*» — дашборды получались пустыми
            for k in [k for k in ST["kibana"] if k.startswith("index-pattern:")]:
                ST["kibana"].pop(k, None)
            ST["kibana"]["index-pattern:logstash-*"] = {
                "type": "index-pattern",
                "index-pattern": {"title": "logstash-*", "timeFieldName": "time_iso",
                                  "fields": "[]"},
                "migrationVersion": {"index-pattern": "7.9.3"},
            }
            ST["kibana"]["index-pattern:smb-decoy"] = {
                "type": "index-pattern",
                "index-pattern": {"title": "logstash-smb-*", "timeFieldName": "@timestamp",
                                  "fields": "[]"},
                "migrationVersion": {"index-pattern": "7.9.3"},
            }
            return self._send({"ok": True})
        if p.startswith("/.kibana/_update/"):
            _id = p.rsplit("/", 1)[-1]
            cur = ST["kibana"].get(_id, {})
            upd = json.loads(body).get("doc", {})
            log("KIBANA_UPDATE " + _id + " " + json.dumps(upd, ensure_ascii=False))
            for k, v in upd.items():
                if isinstance(v, dict) and isinstance(cur.get(k), dict):
                    cur[k].update(v)
                else:
                    cur[k] = v
            ST["kibana"][_id] = cur
            return self._send({"_id": _id, "result": "updated"})
        if p.endswith("/_search") and '"aggs"' in body:
            # max-агрегация по полю времени (последнее событие): 2026-11-10 08:00 UTC;
            # time_iso — «мёртвое» поле времени (value: null) для сценария B11
            if '"time_iso"' in body:
                return self._send({"took": 1, "hits": {"hits": []},
                                   "aggregations": {"m": {"value": None}}})
            return self._send({"took": 1, "hits": {"hits": []},
                               "aggregations": {"m": {"value": 1794297600000.0}}})
        if p.startswith("/_plugins/_alerting/monitors"):
            _id = "mon-%d" % (len(ST["monitors"]) + 1)
            ST["monitors"].append({"id": _id, "name": json.loads(body).get("name", "?")})
            return self._send({"_id": _id, "_version": 1})
        if p.startswith("/_plugins/_anomaly_detection/detectors") and "_start" not in p:
            _id = "adet-%d" % (len(ST["adets"]) + 1)
            ST["adets"].append({"id": _id, "name": json.loads(body).get("name", "?")})
            return self._send({"_id": _id, "_version": 1})
        if p.endswith("/_start"):
            return self._send({"name": p.rstrip("/").split("/")[-2], "state": "STARTED"})
        if p == "/_plugins/_security_analytics/mappings":
            return self._send({"message": "mappings created"})
        if p.startswith("/_plugins/_security_analytics/detectors"):
            _id = "sdet-%d" % (len(ST["sdets"]) + 1)
            ST["sdets"].append({"id": _id, "name": json.loads(body).get("name", "?")})
            return self._send({"_id": _id, "_version": 1})
        if p == "/_bulk":
            # как настоящий OpenSearch: тело bulk должно заканчиваться \n
            if not body.endswith("\n"):
                return self._send({
                    "error": {"root_cause": [{"type": "illegal_argument_exception",
                                "reason": "The bulk request must be terminated by a newline [\\n]"}],
                               "type": "illegal_argument_exception",
                               "reason": "The bulk request must be terminated by a newline [\\n]"},
                    "status": 400}, code=400)
            ST["bulk"].append(body)
            log("BULK_RAW_START")
            with open(REQ_LOG, "a", encoding="utf-8") as f:
                f.write(body + "\n")
            log("BULK_RAW_END")
            # сохраняем объекты как их сохранил бы ES
            lines = [l for l in body.split("\n") if l.strip()]
            for i in range(0, len(lines) - 1, 2):
                try:
                    meta = json.loads(lines[i])
                    doc = json.loads(lines[i + 1])
                    _id = meta["index"]["_id"]
                    ST["kibana"][_id] = doc
                except Exception:
                    pass
            return self._send({"errors": False, "took": 1, "items": []})
        if p.startswith("/.kibana/_doc/"):
            _id = p.rsplit("/", 1)[-1]
            ST["kibana"][_id] = json.loads(body)
            return self._send({"_id": _id, "result": "created"})
        return self._send({"error": "no_route"}, code=404)

    def do_PUT(self):
        p = unquote(urlparse(self.path).path)
        body = self._read_body()
        log("PUT " + self.path + " BODY=" + body[:2000])
        for lst, pre in ((ST["monitors"], "mon-"), (ST["adets"], "adet-"), (ST["sdets"], "sdet-")):
            for m in lst:
                if m["id"] == p.rsplit("/", 1)[-1]:
                    m["name"] = json.loads(body).get("name", m["name"])
                    return self._send({"_id": m["id"], "_version": 2})
        return self._send({"error": "no_route"}, code=404)

    def do_DELETE(self):
        p = unquote(urlparse(self.path).path)
        log("DELETE " + self.path)
        if p.startswith("/.kibana/_doc/"):
            _id = p.rsplit("/", 1)[-1]
            ST["kibana"].pop(_id, None)
            return self._send({"result": "deleted"})
        return self._send({"result": "deleted"})

    def log_message(self, *a):
        pass

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PYOS
python3 "$T/mock_os.py" "$MOCK_PORT" "$T/requests.log" >/dev/null 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -s "$MOCK_URL/" | grep -q clearndr && break; sleep 0.2; done

# ── fake docker shim ─────────────────────────────────────────────────────────
mkdir -p "$T/bin"
cat > "$T/bin/docker" <<SHEOF
#!/bin/bash
# фейковый docker: ps/info/exec → реальный curl на mock
if [ "\$1" = "info" ]; then exit 0; fi
if [ "\$1" = "ps" ]; then
  echo "config-opensearch-ABCD1234"
  echo "config-opensearch-dashboards-ABCD1234"
  exit 0
fi
if [ "\$1" = "exec" ]; then
  CT="\$2"; shift 2
  while [ "\${1:-}" = "-i" ] || [ "\${1:-}" = "-t" ] || [ "\${1:-}" = "--interactive" ]; do shift; done
  [ "\${1:-}" = curl ] && shift
  # curl -s -X M -H ... -d BODY http://127.0.0.1:9200/PATH → curl ... \$MOCK_URL/PATH
  ARGS=()
  for a in "\$@"; do
    case "\$a" in
      http://127.0.0.1:9200*) ARGS+=("\${a/http:\/\/127.0.0.1:9200/$MOCK_URL}") ;;
      http://127.0.0.1:5601*) ARGS+=("\${a/http:\/\/127.0.0.1:5601/$MOCK_URL}") ;;
      *) ARGS+=("\$a") ;;
    esac
  done
  exec "\$(command -v curl)" "\${ARGS[@]}"
fi
exit 1
SHEOF
chmod +x "$T/bin/docker"

run_analytics() { PATH="$T/bin:$PATH" bash "$HERE/clearndr-osd-analytics-setup.sh" "$@"; }
run_import()    { PATH="$T/bin:$PATH" bash "$HERE/clearndr-osd-dashboard-import.sh" "$@"; }
requests() { cat "$T/requests.log"; }

printf '%s\n' "== Часть A: clearndr-osd-analytics-setup.sh"

out="$(run_analytics --status 2>&1)"; rc=$?
check "A1: status rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'clearndr-mock' "$out"; check "A1: кластер показан" $?
grepq 'opensearch-alerting' "$out" && grepq 'установлен' "$out"; check "A1: плагины показаны" $?
grepq '295000' "$out"; check "A1: документы посчитаны" $?
grepq 'alert.severity' "$out"; check "A1: поля определены (EVE)" $?

out="$(run_analytics --apply-alerting --yes 2>&1)"; rc=$?
check "A2: apply-alerting rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'монитор создан' "$out"; check "A2: мониторы созданы" $?
req="$(requests | grep 'POST /_plugins/_alerting/monitors' | grep ' BODY=' | head -1)"
printf '%s' "$req" | grepq 'alert.severity'; check "A2: в мониторе поле alert.severity" $?
printf '%s' "$req" | grepq 'ndr-alerts-audit'; check "A2: аудит-индекс в action" $?
printf '%s' "$req" | grepq 'severity": "1"\|severity":"1"'; check "A2: severity критичный" $?
nmon="$(requests | grep -c 'POST /_plugins/_alerting/monitors BODY' || true)"
check "A2: создано 5 мониторов (получено $nmon)" $([ "$nmon" -eq 5 ]; echo $?)

out2="$(run_analytics --apply-alerting --yes 2>&1)"; rc=$?
check "A3: повторный apply rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'монитор обновлён' "$out2"; check "A3: upsert — обновление вместо дубля" $?

out="$(run_analytics --apply-anomaly --yes 2>&1)"; rc=$?
check "A4: apply-anomaly rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'детектор AD создан\|детектор AD обновлён\|детектор запущен' "$out"; check "A4: детекторы AD созданы/запущены" $?
req="$(requests | grep 'POST /_plugins/_anomaly_detection/detectors BODY' | head -1)"
printf '%s' "$req" | grepq 'category_field'; check "A4: категоризация по src_ip" $?
printf '%s' "$req" | grepq 'flow.bytes_toserver'; check "A4: поле байтов EVE" $?

out="$(run_analytics --apply-security --yes 2>&1)"; rc=$?
check "A5: apply-security rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'маппинг EVE→ECS' "$out"; check "A5: маппинг записан" $?
grepq 'детектор SA создан' "$out"; check "A5: SA-детектор создан" $?
requests | grep 'POST /_plugins/_security_analytics/mappings' | grepq 'src_ip'; check "A5: маппинг на EVE-поля" $?

out="$(run_analytics --apply-alerting --dry-run 2>&1)"
grepq 'dry-run' "$out" && ! grepq 'монитор создан' "$out"; check "A6: dry-run не меняет кластер" $?
nmon2="$(requests | grep -c 'POST /_plugins/_alerting/monitors BODY' || true)"
check "A6: число мониторов не изменилось ($nmon2)" $([ "$nmon2" -eq 5 ]; echo $?)

out="$(run_analytics --remove-managed --yes 2>&1)"; rc=$?
check "A7: remove-managed rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'удалён монитор' "$out"; check "A7: мониторы удалены" $?

printf '%s\n' "== Часть B: clearndr-osd-dashboard-import.sh"

out="$(run_import --list 2>&1)"; rc=$?
check "B1: list rc=$rc" $([ $rc -eq 0 ]; echo $?)
for k in traffic http dns tls alerts files; do grepq "$k" "$out"; done; check "B1: все 6 пакетов" $?

out="$(run_import --pack traffic --yes 2>&1)"; rc=$?
check "B2: import traffic rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'импортирован: 7 объектов' "$out"; check "B2: traffic — 7 объектов импортировано" $?
grepq 'index-pattern найден' "$out" || grepq 'index-pattern создан' "$out"; check "B2: index-pattern найден/создан" $?
bulk="$(sed -n '/BULK_RAW_START/,/BULK_RAW_END/p' "$T/requests.log" | grep 'dashboard:ndr-pack-traffic' | head -1)"
printf '%s' "$bulk" | grep -q .; check "B2: дашборд traffic в bulk" $?
bulkall="$(sed -n '/BULK_RAW_START/,/BULK_RAW_END/p' "$T/requests.log")"
printf '%s' "$bulkall" | grep -q 'src_ip'; check "B2: поле src_ip подставлено" $?
printf '%s' "$bulk" | grep -q '__F:'; check "B2: плейсхолдеров не осталось" $([ $? -ne 0 ]; echo $?)
printf '%s' "$bulkall" | grep -q '"type": "dashboard"'; check "B2: сырой формат .kibana — поле type" $?
printf '%s' "$bulkall" | grep -q '"dashboard": {'; check "B2: атрибуты вложены под именем типа" $?
printf '%s' "$bulkall" | grep -q '"attributes"'; check "B2: envelope-поля attributes нет" $([ $? -ne 0 ]; echo $?)
printf '%s' "$out" | grepq 'в .kibana: [1-9]'; check "B2: объекты видны в проверке после refresh=wait_for" $?
requests | grep 'POST /.kibana/_doc/index-pattern' | grep -q 'logstash-\*'; check "B2: title index-pattern записан" $?
printf '%s' "$bulkall" | grep -q 'proto.keyword'; check "B2: proto заменён на proto.keyword (Terms-агрегации)" $?

# B7: созданный index-pattern получает ПОЛНЫЙ список полей из кластера
req_create="$(requests | grep 'POST /.kibana/_doc/index-pattern' | grep ' BODY=' | tail -1)"
body_create="${req_create#*BODY=}"
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
ipa = d["index-pattern"]
names = {e["name"] for e in json.loads(ipa["fields"])}
assert ipa["title"] == "logstash-*", ipa["title"]
assert ipa["timeFieldName"] == "timestamp", ipa.get("timeFieldName")
for need in ("dns.rrname", "dns.rrname.keyword", "http.url", "alert.severity",
             "proto", "proto.keyword", "app_proto.keyword", "tls.client.server_name",
             "fileinfo.filename", "flow.bytes_toserver", "src_ip", "timestamp"):
    assert need in names, "нет поля %s" % need
assert len(names) >= 25, len(names)
print("ok")
' "$body_create" >/dev/null; check "B7: index-pattern создан с полным списком полей из _field_caps" $?
printf '%s' "$out" | grepq 'полей в index-pattern: [2-9]'; check "B7: счётчик полей показан" $?
printf '%s' "$out" | grepq 'EVE-данные: logstash-\*'; check "B7: источник данных определён" $?

out="$(run_import --pack alerts --pack dns --yes 2>&1)"; rc=$?
check "B3: два пакета rc=$rc" $([ $rc -eq 0 ]; echo $?)
bulkall="$(sed -n '/BULK_RAW_START/,/BULK_RAW_END/p' "$T/requests.log")"
printf '%s' "$bulkall" | grep -q 'dashboard:ndr-pack-alerts'; check "B3: alerts импортирован" $?
printf '%s' "$bulkall" | grep -q 'dashboard:ndr-pack-dns'; check "B3: dns импортирован" $?
printf '%s' "$bulkall" | grep -q 'alert.signature'; check "B3: поле сигнатур EVE" $?
printf '%s' "$bulkall" | grep -q 'dns.rrname'; check "B3: поле DNS EVE" $?

out="$(run_import --pack tls --yes 2>&1)"
grepq 'импортирован' "$out"; check "B4: tls импортирован" $?

out="$(run_import --pack nope --yes 2>&1)"; rc=$?
check "B5: неизвестный пакет — rc=$rc" $([ $rc -ne 0 ]; echo $?)

out="$(run_import --remove all --yes 2>&1)"; rc=$?
check "B6: remove all rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'удалён' "$out"; check "B6: объекты удаляются" $?
requests | grep -q 'DELETE /.kibana/_doc/dashboard:ndr-pack-traffic'; check "B6: DELETE дашборда traffic" $?

# B8: найденный урезанный паттерн (как у SELKS) дополняется полями, не пересоздаётся
curl -s -X POST "$MOCK_URL/__ctl/seed_pattern" >/dev/null
out="$(run_import --pack http --yes 2>&1)"; rc=$?
check "B8: import http (seeded pattern) rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'index-pattern найден: 06e1e3c0' "$out"; check "B8: найден урезанный паттерн SELKS" $?
grepq 'поля index-pattern синхронизированы' "$out"; check "B8: поля синхронизированы из кластера" $?
upd="$(requests | grep 'KIBANA_UPDATE index-pattern:06e1e3c0' | tail -1)"
printf '%s' "$upd" | grep -q 'dns.rrname'; check "B8: в _update ушёл полный список полей" $?
printf '%s' "$upd" | grep -q 'selks_custom_field'; check "B8: MERGE — свои поля SELKS сохранены" $?
bulkall="$(sed -n '/BULK_RAW_START/,/BULK_RAW_END/p' "$T/requests.log")"
printf '%s' "$bulkall" | grep -q '06e1e3c0-c1c7-11e8-9888-3f5bc9c31629'; check "B8: панели ссылаются на найденный паттерн" $?
doc="$(curl -s "$MOCK_URL/.kibana/_doc/index-pattern:06e1e3c0-c1c7-11e8-9888-3f5bc9c31629")"
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
ipa = d["_source"]["index-pattern"]
names = {e["name"] for e in json.loads(ipa["fields"])}
assert "http.url" in names, "http.url не дописан"
assert "selks_custom_field" in names, "MERGE затёр поле SELKS"
assert ipa["timeFieldName"] == "timestamp", ipa["timeFieldName"]
assert ipa["title"] == "logstash-*", ipa["title"]
print("ok")
' "$doc" >/dev/null; check "B8: паттерн дополнен, титул/timeFieldName сохранены" $?

# B9: --check — диагностика данных без изменений в кластере
out="$(run_import --check 2>&1)"; rc=$?
check "B9: --check rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'Источник данных' "$out"; check "B9: секция источника" $?
grepq 'EVE-данные: logstash-\*' "$out"; check "B9: цель данных показана" $?
grepq 'последнее событие' "$out"; check "B9: время последнего события" $?
grepq 'полей в паттерне' "$out"; check "B9: список index-pattern'ов" $?
grepq 'proto.keyword' "$out"; check "B9: keyword-подполя показаны" $?
printf '%s' "$out" | grepq 'полей в кластере под logstash-\*: [1-9]'; check "B9: поля кластера посчитаны (не 0 — регрессия StopIteration на object-полях)" $?
printf '%s' "$out" | grepq 'StopIteration'; check "B9: без traceback StopIteration" $([ $? -ne 0 ]; echo $?)

# B10: импорт при наличии object-полей в _field_caps (регрессия v1.14.5:
# StopIteration на «dns"/"http"/… с единственным типом object)
out="$(run_import --pack traffic --yes 2>&1)"; rc=$?
check "B10: import с object-полями в field_caps rc=$rc" $([ $rc -eq 0 ]; echo $?)
printf '%s' "$out" | grepq 'полей в index-pattern: [1-9]'; check "B10: полный список полей получен" $?
printf '%s' "$out" | grepq 'StopIteration'; check "B10: без traceback StopIteration" $([ $? -ne 0 ]; echo $?)

# B11: сценарий реального хоста — зонтичный паттерн с мёртвым полем времени и
# decoy logstash-smb-*; оба обязаны быть ПРОПУЩЕНЫ, создаётся свой паттерн
curl -s -X POST "$MOCK_URL/__ctl/seed_host" >/dev/null
out="$(run_import --pack traffic --yes 2>&1)"; rc=$?
check "B11: сценарий хоста rc=$rc" $([ $rc -eq 0 ]; echo $?)
printf '%s' "$out" | grepq 'пропущен: поле времени'; check "B11: зонтичный с мёртвым временем отклонён" $?
printf '%s' "$out" | grepq 'index-pattern создан: ndr-logstash-pattern'; check "B11: создан свой паттерн" $?
bulkall="$(sed -n '/BULK_RAW_START/,/BULK_RAW_END/p' "$T/requests.log")"
printf '%s' "$bulkall" | grep -q 'smb-decoy'; check "B11: decoy smb не используется" $([ $? -ne 0 ]; echo $?)
printf '%s' "$bulkall" | grepq '"id": "ndr-logstash-pattern"\|"id":"ndr-logstash-pattern"'; check "B11: панели ссылаются на свой паттерн" $?

printf '%s\n' "== Часть C: автоопределение канала OpenSearch"

# C1: явный --es-url (host-канал, docker не нужен)
out="$(run_analytics --status --es-url "$MOCK_URL" 2>&1)"; rc=$?
check "C1: --es-url rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'OpenSearch: '"$MOCK_URL" "$out"; check "C1: подключение по --es-url" $?
# C2: URL с учётными данными — секрет маскируется
out="$(run_analytics --status --es-url "http://admin:s3cr3t@127.0.0.1:$MOCK_PORT" 2>&1)"; rc=$?
check "C2: --es-url с авторизацией rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'admin:\*\*\*@"127.0.0.1' "$out" || grepq 'admin:\*\*\*@127.0.0.1' "$out"; check "C2: пароль маскирован" $?
printf '%s' "$out" | grepq 's3cr3t' && check "C2: секрет не печатается" 1 || check "C2: секрет не печатается" 0
# C3: автоопределение без --es-url — через docker exec (фейковый docker → mock)
out="$(run_analytics --status 2>&1)"; rc=$?
check "C3: автоопределение rc=$rc" $([ $rc -eq 0 ]; echo $?)
grepq 'OpenSearch через контейнер: config-opensearch-ABCD1234' "$out"; check "C3: найден контейнер opensearch" $?
# C4: тот же автоопределение в import-скрипте
out="$(run_import --list 2>&1)"; rc=$?
check "C4: import без --es-url rc=$rc" $([ $rc -eq 0 ]; echo $?)
# C5: недоступный --es-url — внятная ошибка, rc=1
out="$(run_analytics --status --es-url "http://127.0.0.1:1" 2>&1)"; rc=$?
check "C5: недоступный --es-url rc=$rc" $([ $rc -eq 1 ]; echo $?)
grepq 'недоступен по --es-url' "$out"; check "C5: сообщение об ошибке" $?

printf '%s\n' "== Итог: PASS=$PASS FAIL=$FAIL"
[ "${KEEP_MOCK:-0}" = 1 ] || rm -rf "$T"
[ "$FAIL" -eq 0 ]
