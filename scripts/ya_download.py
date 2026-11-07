#!/usr/bin/env python3
"""Download all files from Yandex Disk public folder https://disk.yandex.ru/d/YWzlp9N7Xw-tSg"""
import json, subprocess, sys, os, time, urllib.parse

PUB = "https://disk.yandex.ru/d/YWzlp9N7Xw-tSg"
OUT = "/home/z/my-project/work/archives"
os.makedirs(OUT, exist_ok=True)

def curl_json(url, tries=6):
    for a in range(tries):
        p = subprocess.run(["curl", "-sL", "--connect-timeout", "20", "--max-time", "60",
                            "-H", "Accept: application/json", url],
                           capture_output=True, text=True)
        if p.returncode == 0 and p.stdout.strip().startswith("{"):
            try:
                d = json.loads(p.stdout)
                if "error" not in d:
                    return d
                print(f"  api error: {d['error']}", flush=True)
            except json.JSONDecodeError:
                pass
        wait = 5 * (a + 1)
        print(f"  attempt {a+1} failed, wait {wait}s", flush=True)
        time.sleep(wait)
    return None

def api(endpoint, **params):
    params["public_key"] = PUB
    url = f"https://cloud-api.yandex.net/v1/disk/public/resources{endpoint}?" + urllib.parse.urlencode(params)
    return curl_json(url)

listing = api("", limit=200)
if not listing:
    sys.exit("cannot list folder")
items = listing["_embedded"]["items"]
print(f"Found {len(items)} items", flush=True)

for it in items:
    name, path = it["name"], it["path"]
    dest = os.path.join(OUT, name)
    if os.path.exists(dest) and abs(os.path.getsize(dest) - (it.get("size") or 0)) < 1024:
        print(f"skip (exists): {name}", flush=True)
        continue
    info = api("/download", path=path)
    if not info or "href" not in info:
        print(f"FAIL get href for {name}", flush=True)
        continue
    href = info["href"]
    print(f"downloading {name} ({it.get('size',0)/1e6:.1f} MB) ...", flush=True)
    ok = False
    for attempt in range(3):
        rc = subprocess.call(["curl", "-sL", "--connect-timeout", "20", "--max-time", "1200",
                              "--retry", "3", "--retry-delay", "5", "-C", "-", "-o", dest, href])
        if rc == 0 and os.path.getsize(dest) > 0:
            ok = True
            break
        print(f"  retry {attempt+1} failed rc={rc}", flush=True)
        time.sleep(5)
    sz = os.path.getsize(dest) if os.path.exists(dest) else 0
    print(f"  -> {sz/1e6:.1f} MB {'OK' if ok else 'FAIL'}", flush=True)

print("done")
