#!/usr/bin/env bash
# Smoke-тест TS-генерируемого probe-скрипта (buildOsdProbeScript) против
# фейкового OpenSearch: канал docker exec (local-режим с docker-сокетом).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d /tmp/osd-probe-smoke.XXXXXX)"
trap 'kill ${MOCK_PID:-0} 2>/dev/null; rm -rf "$T"' EXIT
MOCK_PORT=$((21000 + RANDOM % 2000))
MOCK_URL="http://127.0.0.1:$MOCK_PORT"

# фейковый OpenSearch (как в test-clearndr-osd-mock.sh)
cat > "$T/mock_os.py" <<'PYOS'
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def _send(self, obj):
        b = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/":
            return self._send({"cluster_name": "clearndr-mock", "version": {"number": "3.3.0"}})
        if p == "/api/stats":
            return self._send({"version": {"number": "3.3.0"}})
        if p == "/_cat/plugins":
            b = b"opensearch-alerting\nopensearch-anomaly-detection\nopensearch-security-analytics\n"
            self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        if p.startswith("/_cat/indices/logstash-"):
            b = b"295000\n"
            self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        if p.startswith("/_plugins/_alerting/monitors"):
            return self._send({"hits": {"hits": [{"_id": "m1", "_source": {"name": "NDR · test"}}]}})
        if p.startswith("/_plugins/_anomaly_detection/detectors"):
            return self._send({"hits": {"hits": []}})
        if p.startswith("/_plugins/_security_analytics/detectors"):
            return self._send({"hits": {"hits": []}})
        if p.startswith("/.kibana/_search"):
            return self._send({"hits": {"total": {"value": 3, "relation": "eq"}, "hits": []}})
        return self._send({"error": "no_route"})
    def log_message(self, *a):
        pass
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PYOS
python3 "$T/mock_os.py" "$MOCK_PORT" >/dev/null 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 30); do curl -s "$MOCK_URL/" | grep -q clearndr && break; sleep 0.2; done

# фейковый docker: exec → curl на mock
mkdir -p "$T/bin"
cat > "$T/bin/docker" <<SHEOF
#!/bin/bash
if [ "\$1" = "info" ]; then exit 0; fi
if [ "\$1" = "ps" ]; then echo "config-opensearch-ABCD1234"; echo "config-opensearch-dashboards-ABCD1234"; exit 0; fi
if [ "\$1" = "exec" ]; then
  CT="\$2"; shift 2
  [ "\${1:-}" = curl ] && shift
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

# генерируем probe-скрипт из TS
bun -e "
import { buildOsdProbeScript } from '$ROOT/src/lib/engine/clearndr-osd.ts'
const s = buildOsdProbeScript({ updateMode:'local', sshHost:'', sshPort:'22', sshUser:'root', sshKey:'', sudoMode:'auto', instanceDir:'/opt/ClearNDR', scriptPath:'/opt/ClearNDR/clearndr-update.sh', healthUrl:'https://172.17.0.1/', apiToken:'', osdEsUrl:'' })
await Bun.write('$T/probe.sh', s)
"
bash -n "$T/probe.sh" || { echo "FAIL: probe.sh синтаксис"; exit 1; }

OUT="$(PATH="$T/bin:$PATH" DOCKER_HOST=unix:///tmp/osd-probe-fake.sock bash "$T/probe.sh" 2>&1)"
echo "$OUT"
echo "---"
rc=0
grepq() { printf '%s' "$OUT" | grep -q "$1" || { echo "FAIL: нет «$1»"; rc=1; }; }
grepq $'cluster\tclearndr-mock'
grepq $'docker_status\tok'
grepq 'es_channel.*exec:config-opensearch-ABCD1234'
grepq $'es_version\t3.3.0'
grepq $'alerting\t1'
grepq $'anomaly\t1'
grepq $'security\t1'
grepq $'indices\t1'
grepq $'docs\t295000'
grepq $'packs\t3'
grepq $'monitors\t1'
grepq $'osd_version\t3.3.0'
[ $rc -eq 0 ] && echo "SMOKE OK"
exit $rc
