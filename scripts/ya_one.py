#!/usr/bin/env python3
"""Download one file from Yandex Disk public folder by name."""
import json, subprocess, sys, os, time, urllib.parse

PUB = "https://disk.yandex.ru/d/YWzlp9N7Xw-tSg"
OUT = "/home/z/my-project/work/archives"
name = sys.argv[1] if len(sys.argv) > 1 else "Talos_LightSPD.tar.gz"
dest = os.path.join(OUT, name)

def curl_json(url, tries=8):
    for a in range(tries):
        p = subprocess.run(["curl", "-sL", "--connect-timeout", "20", "--max-time", "60", url],
                           capture_output=True, text=True)
        if p.returncode == 0 and p.stdout.strip().startswith("{"):
            try:
                d = json.loads(p.stdout)
                if "error" not in d:
                    return d
                print(f"  api error: {d['error']}", flush=True)
            except json.JSONDecodeError:
                pass
        wait = 8 * (a + 1)
        print(f"  attempt {a+1} failed, wait {wait}s", flush=True)
        time.sleep(wait)
    return None

qs = urllib.parse.urlencode({"public_key": PUB, "path": "/" + name, "limit": 10})
listing = curl_json("https://cloud-api.yandex.net/v1/disk/public/resources?" + qs)
if not listing or "_embedded" not in listing:
    print("listing failed"); sys.exit(1)
items = listing["_embedded"]["items"]
if not items:
    print("item not found"); sys.exit(1)
size = items[0].get("size", 0)
if os.path.exists(dest) and os.path.getsize(dest) == size:
    print(f"skip (exists): {name}"); sys.exit(0)

info = curl_json("https://cloud-api.yandex.net/v1/disk/public/resources/download?" + qs)
if not info or "href" not in info:
    print("no href"); sys.exit(1)
print(f"downloading {name} ({size/1e6:.1f} MB)...", flush=True)
for attempt in range(3):
    rc = subprocess.call(["curl", "-sL", "--connect-timeout", "20", "--max-time", "1800",
                          "--retry", "3", "--retry-delay", "10", "-C", "-", "-o", dest, info["href"]])
    if rc == 0 and os.path.getsize(dest) > 0:
        print(f"  -> {os.path.getsize(dest)/1e6:.1f} MB OK")
        sys.exit(0)
    print(f"  retry {attempt+1} rc={rc}")
    time.sleep(10)
print("DOWNLOAD FAILED")
