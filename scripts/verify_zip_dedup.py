#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверка ZIP-архива, уходящего на GitHub: распаковать во временную папку,
посчитать правила и дубликаты (SID / контент K1 / контент без reference K3) в каждом файле."""
import re, sys, zipfile, os, tempfile, shutil
from collections import defaultdict

ZIP = sys.argv[1]
RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
REF_RE = re.compile(r"\breference\s*:[^;]*(?:;|$)")

def key(raw, deep):
    s = SID_RE.sub("", raw)
    if deep:
        s = REF_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()

tmp = tempfile.mkdtemp(prefix="dedupcheck-")
try:
    with zipfile.ZipFile(ZIP) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        z.extractall(tmp)
    print(f"Архив: {ZIP}  ({len(names)} файлов)")
    fail = 0
    grand = 0
    all_sids = defaultdict(list)  # глобальный SID -> файлы (кросс-файловые дубли)
    for root, _, fs in os.walk(tmp):
        for fn in sorted(fs):
            if not fn.endswith((".rules", ".csv", ".txt", ".md")):
                continue
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, tmp)
            if fn.endswith((".csv", ".txt", ".md")):
                print(f"  [вспом.] {rel}  {os.path.getsize(p):,}B")
                continue
            sids, k1, k3 = set(), set(), set()
            d_sid = d_k1 = d_k3 = 0
            n = 0
            for line in open(p, encoding="utf-8", errors="replace"):
                if not RULE_RE.match(line):
                    continue
                n += 1
                s = SID_RE.search(line).group(1)
                if s in sids: d_sid += 1
                sids.add(s)
                all_sids[s].append(rel)
                a = key(line, False)
                if a in k1: d_k1 += 1
                k1.add(a)
                b = key(line, True)
                if b in k3: d_k3 += 1
                k3.add(b)
            grand += n
            bad = d_sid or d_k1 or d_k3
            fail += bad
            mark = "OK " if not bad else "FAIL"
            print(f"  {mark} {rel}: правил={n:,}, дублSID={d_sid}, дублK1={d_k1}, дублK3={d_k3}")
    cross = {s: fs for s, fs in all_sids.items() if len(fs) > 1}
    print(f"ИТОГО: правил {grand:,}; проблем внутри файлов: {fail}; SID в нескольких файлах: {len(cross)}")
    for s, fs in list(cross.items())[:10]:
        print(f"   sid {s}: {fs}")
    sys.exit(1 if (fail or cross) else 0)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
