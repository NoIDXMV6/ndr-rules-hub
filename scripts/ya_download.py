#!/usr/bin/env python3
"""Download all files from Yandex Disk public folder https://disk.yandex.ru/d/YWzlp9N7Xw-tSg"""
import json, subprocess, sys, os, time

PUB = "https://disk.yandex.ru/d/YWzlp9N7Xw-tSg"
OUT = "/home/z/my-project/work/archives"
os.makedirs(OUT, exist_ok=True)

def api(endpoint, **params):
    params["public_key"] = PUB
    qs = "&".join(f"{k}={subprocess.list2cmdline([]) or ''}" for k in [])
    import urllib.parse, urllib.request
    url = f"https://cloud-api.yandex.net/v1/disk/public/resources{endpoint}?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)

listing = api("", limit=200)
items = listing["_embedded"]["items"]
print(f"Found {len(items)} items")

for it in items:
    name, path = it["name"], it["path"]
    dest = os.path.join(OUT, name)
    if os.path.exists(dest) and abs(os.path.getsize(dest) - (it.get("size") or 0)) < 1024:
        print(f"skip (exists): {name}")
        continue
    info = api("/download", path=path)
    href = info["href"]
    print(f"downloading {name} ({it.get('size',0)/1e6:.1f} MB) ...")
    for attempt in range(3):
        rc = subprocess.call(["curl", "-sL", "--connect-timeout", "20", "--max-time", "900", "-o", dest, href])
        if rc == 0 and os.path.getsize(dest) > 0:
            break
        print(f"  retry {attempt+1} failed rc={rc}")
        time.sleep(3)
    sz = os.path.getsize(dest) if os.path.exists(dest) else 0
    print(f"  -> {sz/1e6:.1f} MB {'OK' if sz>0 else 'FAIL'}")

print("done")
