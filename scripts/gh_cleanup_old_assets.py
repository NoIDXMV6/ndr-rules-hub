#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Удаление старых некорректных наборов правил с релизов v1.2.0 и v1.1.0-validated
+ пометка релизов устаревшими. Токен берётся ТОЛЬКО из git remote URL и не выводится."""
import json, subprocess, sys, urllib.request

REPO = "NoIDXMV6/ndr-rules-hub"
DEPRECATED_TAGS = ("v1.3.0",)
GOOD_TAG = "v1.4.0"
NOTE = (
    "**⚠️ РЕЛИЗ УСТАРЕЛ — АССЕТЫ УДАЛЕНЫ.** Наборы этого релиза некорректны для Clear NDR: "
    "Scirius принимает GUID из `content:\"clsid:33FD63B1-…\"` за SID правила (регэксп "
    "`sid *: *(\\d+)` матчит первое вхождение в строке), из-за чего импорт падал с "
    "`The source contains conflicting SID (33) in same source`.\n\n"
    f"**Актуальный пакет: [{GOOD_TAG}](https://github.com/{REPO}/releases/tag/{GOOD_TAG})** — "
    "sid-first: опция `sid:…;` перенесена в начало опций, импорт проверен на живом Scirius "
    "(31/31 файлов) и `suricata -T` (0 ошибок). Импорт Talos Snort 2.9 — кит v3.\n\n"
    "---\n\n"
)


def api(method: str, url: str, payload: dict | None = None) -> tuple[int, dict | list | None]:
    req = urllib.request.Request(f"https://api.github.com{url}", method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "ndr-rules-hub-cleanup",
    })
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        with urllib.request.urlopen(req, data=data) as r:
            body = r.read().decode()
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


# токен только из remote URL
u = subprocess.check_output(["git", "config", "--get", "remote.origin.url"], text=True).strip()
creds = u.split("://", 1)[1].split("@", 1)[0] if "://" in u else u
TOKEN = creds.split(":", 1)[1] if ":" in creds else creds
if not TOKEN:
    sys.exit("NO_TOKEN_IN_REMOTE")

for tag in DEPRECATED_TAGS:
    st, rel = api("GET", f"/repos/{REPO}/releases/tags/{tag}")
    if st != 200:
        print(f"[{tag}] релиз не найден (HTTP {st}), пропуск")
        continue
    rid, assets = rel["id"], rel.get("assets", [])
    print(f"[{tag}] id={rid}, ассетов: {len(assets)}")
    for a in assets:
        st, _ = api("DELETE", f"/repos/{REPO}/releases/assets/{a['id']}")
        print(f"   удалён {a['name']} ({a['size']:,}B) -> HTTP {st}")
    body = rel.get("body") or ""
    if body.startswith("**⚠️ РЕЛИЗ УСТАРЕЛ"):
        print("   пометка «устарел» уже стоит")
    else:
        st, _ = api("PATCH", f"/repos/{REPO}/releases/{rid}", {"body": NOTE + body})
        print(f"   тело релиза помечено устаревшим -> HTTP {st}")

print("\n== итоговое состояние релизов:")
st, rels = api("GET", f"/repos/{REPO}/releases?per_page=20")
for r in rels:
    print(f"  {r['tag_name']}: assets={[a['name'] for a in r['assets']]}")
