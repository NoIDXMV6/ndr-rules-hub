#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Пометка релиза v1.4.0 как подтверждённого реальным импортом в Clear NDR.
Идемпотентно: если пометка уже стоит — пропуск. Токен берётся ТОЛЬКО из git
remote URL и не выводится."""
import json, subprocess, sys, urllib.request

REPO = "NoIDXMV6/ndr-rules-hub"
TAG = "v1.4.0"
MARK = "✅ ПОДТВЕРЖДЕНО РЕАЛЬНЫМ ИМПОРТОМ В CLEAR NDR"
NOTE = (
    f"**{MARK} (2026-11-08).** Оба ассета импортированы в боевой Clear NDR без ошибок:\n\n"
    "- `clearndr-rules-20261107-sidfirst.zip` — ошибки `conflicting SID (33)` больше не возникают;\n"
    "- `clearndr-snort2-import-kit-20261108-v3.zip` — импорт 45 985 правил Talos Snort 2.9 "
    "(10 кусков, каждый кусок = отдельный источник) прошёл без ошибок.\n\n"
    "Дополнительные проверки: воспроизведение на живом Scirius в песочнице — 31/31 файлов "
    "импортируется после фикса; `suricata -T` — 0 ошибок.\n\n"
    "---\n\n"
)


def api(method: str, url: str, payload: dict | None = None) -> tuple[int, dict | list | None]:
    req = urllib.request.Request(f"https://api.github.com{url}", method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "ndr-rules-hub-verify-mark",
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

st, rel = api("GET", f"/repos/{REPO}/releases/tags/{TAG}")
if st != 200:
    sys.exit(f"RELEASE_NOT_FOUND (HTTP {st})")

body = rel.get("body") or ""
if MARK in body:
    print("пометка «подтверждено реальным импортом» уже стоит — пропуск")
else:
    st, _ = api("PATCH", f"/repos/{REPO}/releases/{rel['id']}", {"body": NOTE + body})
    print(f"тело релиза v1.4.0 дополнено пометкой подтверждения -> HTTP {st}")

print("\n== первые строки тела релиза после патча:")
_, rel = api("GET", f"/repos/{REPO}/releases/tags/{TAG}")
for line in (rel["body"] or "").splitlines()[:12]:
    print("  " + line)
