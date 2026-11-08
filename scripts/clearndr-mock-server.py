#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mock-сервер Clear NDR (Scirius REST API) для проверки интеграции NDR Rules Hub.

Имитирует поведение реального Clear NDR:
  • аутентификация Authorization: Token <токен> (DRF TokenAuthentication);
  • пагинированные списки {"count": N, "next": …, "results": […]};
  • GET/POST /rest/rules/source/           — список/создание источника;
  • POST /rest/rules/source/<pk>/upload/   — multipart-загрузка файла правил
    (имитирует импорт: считает SID, при конфликте внутри файла возвращает
    ошибку «conflicting SID» как настоящий Scirius);
  • POST /rest/suricata/update_push_all/   — применение набора;
  • GET/POST/PATCH /rest/rules/ruleset/    — наборы правил;
  • POST /rest/rules/category/<pk>/enable/ — включение категории в наборе;
  • GET /_stats                            — служебный просмотр состояния mock.

Запуск:
    python3 scripts/clearndr-mock-server.py --port 8080 --token mysecret
Проверка:
    curl -s http://127.0.0.1:8080/_stats | python3 -m json.tool

Файлы источников сохраняются в каталог состояния (по умолчанию
/tmp/clearndr-mock/) — их можно сверить с отправленными по sha256.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

STATE = {
    "token": "",
    "dir": "/tmp/clearndr-mock",
    "sources": {},   # pk -> {pk, name, method, datatype, uri, created}
    "rulesets": {},  # pk -> {pk, name, descr, sources: []}
    "categories": {},# pk -> {pk, name, source, enabled_in: []}
    "uploads": [],   # [{ts, source, filename, sha256, bytes, rules, sids}]
    "events": [],    # журнал запросов
    "next_pk": 1,
}

RULE_RE = re.compile(r"^[a-z]+\s+\S+", re.IGNORECASE)
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;", re.IGNORECASE)


def next_pk():
    STATE["next_pk"] += 1
    return STATE["next_pk"] - 1


def save_state():
    os.makedirs(STATE["dir"], exist_ok=True)
    with open(os.path.join(STATE["dir"], "state.json"), "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in STATE.items() if k != "token"}, f, ensure_ascii=False, indent=1)


def log(msg):
    print(f"[mock] {time.strftime('%H:%M:%S')} {msg}", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ClearNDRMock/1.0"

    # ── служебные ────────────────────────────────────────────────────────────
    def log_message(self, fmt, *args):  # тише стандартного
        pass

    def _send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        STATE["events"].append({"ts": time.time(), "method": self.command, "path": self.path, "status": status})
        log(f'{self.command} {self.path} -> {status}')

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        if auth == f"Token {STATE['token']}":
            return True
        self._send(401, {"detail": "Invalid token."})
        return False

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    # ── GET ──────────────────────────────────────────────────────────────────
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/_stats":
            return self._send(200, {k: v for k, v in STATE.items() if k != "token"})
        if not path.startswith("/rest/"):
            return self._send(404, {"detail": "Not found."})
        if not self._authorized():
            return

        params = {k: v[0] for k, v in parse_qs(query).items()}

        if path == "/rest/rules/source/":
            items = list(STATE["sources"].values())
            if "name" in params:
                items = [s for s in items if s["name"] == params["name"]]
            return self._send(200, {"count": len(items), "next": None, "previous": None, "results": items})

        if path == "/rest/rules/ruleset/":
            items = list(STATE["rulesets"].values())
            return self._send(200, {"count": len(items), "next": None, "previous": None, "results": items})

        if path == "/rest/rules/category/":
            items = list(STATE["categories"].values())
            if "source" in params:
                items = [c for c in items if c["source"] == int(params["source"])]
            return self._send(200, {"count": len(items), "next": None, "previous": None, "results": items})

        return self._send(404, {"detail": "Not found."})

    # ── POST / PATCH / DELETE ───────────────────────────────────────────────
    def do_POST(self):
        path = self.path.split("?")[0]
        if not path.startswith("/rest/"):
            return self._send(404, {"detail": "Not found."})
        if not self._authorized():
            return
        body = self._read_body()

        # создание источника
        if path == "/rest/rules/source/":
            try:
                data = json.loads(body or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"name": ["Invalid JSON."]})
            if not data.get("name") or not data.get("method") or not data.get("datatype"):
                return self._send(400, {"name": ["This field is required."]})
            if data["method"] not in ("local", "http"):
                return self._send(400, {"method": [f'"{data["method"]}" is not a valid choice.']})
            if data["datatype"] not in ("sig", "sigs", "other", "b64dataset"):
                return self._send(400, {"datatype": ["Data type must be one of: sig,sigs,other,b64dataset"]})
            for s in STATE["sources"].values():
                if s["name"] == data["name"]:
                    return self._send(400, {"name": ["source with this name already exists."]})
            pk = next_pk()
            src = {"pk": pk, "name": data["name"], "method": data["method"],
                   "datatype": data["datatype"], "uri": data.get("uri"),
                   "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            STATE["sources"][pk] = src
            save_state()
            return self._send(201, src)

        m = re.match(r"^/rest/rules/source/(\d+)/upload/$", path)
        if m:
            return self._upload(int(m.group(1)), body)

        if path == "/rest/suricata/update_push_all/":
            n = len(STATE["uploads"])
            if n == 0:
                return self._send(400, {"update_push_all": ["Ruleset has no sources with content yet."]})
            return self._send(200, {"update_push_all": "ok", "applied_uploads": n})

        if path == "/rest/rules/ruleset/":
            try:
                data = json.loads(body or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"name": ["Invalid JSON."]})
            if not data.get("name"):
                return self._send(400, {"name": ["This field is required."]})
            pk = next_pk()
            rs = {"pk": pk, "name": data["name"], "descr": data.get("descr", ""),
                  "sources": data.get("sources", []), "need_test": False}
            STATE["rulesets"][pk] = rs
            save_state()
            return self._send(201, rs)

        m = re.match(r"^/rest/rules/category/(\d+)/enable/$", path)
        if m:
            try:
                data = json.loads(body or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"ruleset": ["Invalid JSON."]})
            if "ruleset" not in data:
                return self._send(400, {"ruleset": ["This field is required."]})
            cat = STATE["categories"].get(int(m.group(1)))
            if not cat:
                return self._send(404, {"detail": "Not found."})
            if data["ruleset"] not in cat["enabled_in"]:
                cat["enabled_in"].append(data["ruleset"])
            save_state()
            return self._send(200, {"enable": "ok"})

        return self._send(404, {"detail": "Not found."})

    def do_PATCH(self):
        path = self.path.split("?")[0]
        m = re.match(r"^/rest/rules/ruleset/(\d+)/$", path)
        if not m:
            return self._send(404, {"detail": "Not found."})
        if not self._authorized():
            return
        body = self._read_body()
        rs = STATE["rulesets"].get(int(m.group(1)))
        if not rs:
            return self._send(404, {"detail": "Not found."})
        try:
            data = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"name": ["Invalid JSON."]})
        if "sources" in data:
            rs["sources"] = data["sources"]
        if "name" in data:
            rs["name"] = data["name"]
        save_state()
        return self._send(200, rs)

    def do_DELETE(self):
        path = self.path.split("?")[0]
        m = re.match(r"^/rest/rules/source/(\d+)/$", path)
        if not m:
            return self._send(404, {"detail": "Not found."})
        if not self._authorized():
            return
        STATE["sources"].pop(int(m.group(1)), None)
        save_state()
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── multipart-загрузка правил ────────────────────────────────────────────
    def _upload(self, pk, body):
        src = STATE["sources"].get(pk)
        if not src:
            return self._send(404, {"detail": "Not found."})
        if src["method"] != "local":
            return self._send(400, {"upload": [f'No upload is allowed. method is currently "{src["method"]}"']})
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self._send(400, {"upload": ["Expected multipart/form-data with a 'file' part"]})

        # разбор multipart через email.parser (стандартная библиотека)
        raw = (f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n").encode() + body
        msg = BytesParser(policy=email_default).parsebytes(raw)
        file_part = None
        comment = None
        for part in msg.iter_parts():
            fn = part.get_filename()
            if fn:
                file_part = (fn, part.get_payload(decode=True) or b"")
            elif part.get_param("name", header="content-disposition") == "comment":
                comment = part.get_payload(decode=True)
        if not file_part:
            return self._send(400, {"file": ["This field is required."]})

        filename, content = file_part
        text = content.decode("utf-8", "replace")
        rules = [l for l in text.splitlines() if RULE_RE.match(l.strip()) and not l.strip().startswith("#")]
        sids = [int(x) for x in SID_RE.findall(text)]

        # имитация гейта Scirius: конфликтующие SID внутри одного файла
        dup = {s for s in sids if sids.count(s) > 1}
        if dup:
            return self._send(400, {"upload": [
                f"The source contains conflicting SID ({sorted(dup)[0]}) in same source {src['name']}"]})

        srcdir = os.path.join(STATE["dir"], "sources", str(pk))
        os.makedirs(srcdir, exist_ok=True)
        with open(os.path.join(srcdir, filename), "wb") as f:
            f.write(content)
        STATE["uploads"].append({
            "ts": time.time(), "source": pk, "filename": filename,
            "sha256": hashlib.sha256(content).hexdigest(),
            "bytes": len(content), "rules": len(rules), "comment": (comment or b"").decode("utf-8", "replace"),
        })
        # категория «<имя источника> Sigs» — как Scirius для datatype=sig
        catname = ("%s Sigs" % src["name"])[:100]
        cat = next((c for c in STATE["categories"].values() if c["source"] == pk), None)
        if not cat:
            catpk = next_pk()
            cat = {"pk": catpk, "name": catname, "source": pk, "enabled_in": []}
            STATE["categories"][catpk] = cat
        cat["rules"] = len(rules)
        save_state()
        return self._send(200, {"upload": "ok", "rules": len(rules), "sha256": STATE["uploads"][-1]["sha256"]})


def main():
    ap = argparse.ArgumentParser(description="Mock-сервер Clear NDR (Scirius REST API)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--token", default="mock-clearndr-token",
                    help="ожидаемый API-токен (Authorization: Token <…>)")
    ap.add_argument("--state-dir", default="/tmp/clearndr-mock")
    args = ap.parse_args()

    STATE["token"] = args.token
    STATE["dir"] = args.state_dir
    os.makedirs(args.state_dir, exist_ok=True)
    save_state()

    log(f"запуск: http://{args.host}:{args.port}/rest/  (токен: {args.token})")
    log(f"состояние: {args.state_dir}  |  статистика: http://127.0.0.1:{args.port}/_stats")
    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        log("остановлен")
        sys.exit(0)


if __name__ == "__main__":
    main()
