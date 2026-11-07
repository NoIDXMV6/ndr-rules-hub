#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Финальная верификация пересобранного пакета: дубликаты (K1/K3) во всех файлах
+ совпадение SID-набора talos-snort2 с импорт-набором v2."""
import re, glob, os
from collections import defaultdict

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
REF_RE = re.compile(r"\breference\s*:[^;]*(?:;|$)")

def k(raw, deep):
    s = SID_RE.sub("", raw)
    if deep:
        s = REF_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()

files = sorted(glob.glob("/home/z/my-project/download/rules/*.rules")) + \
        sorted(glob.glob("/home/z/my-project/download/rules/*/*.rules"))
print(f"Файлов на проверку: {len(files)}")
fail = 0
total_rules = 0
for p in files:
    sids, k1, k3 = set(), set(), set()
    d_sid = d_k1 = d_k3 = 0
    n = 0
    for line in open(p, encoding="utf-8"):
        if not RULE_RE.match(line):
            continue
        n += 1
        s = SID_RE.search(line).group(1)
        if s in sids: d_sid += 1
        sids.add(s)
        a = k(line, False)
        if a in k1: d_k1 += 1
        k1.add(a)
        b = k(line, True)
        if b in k3: d_k3 += 1
        k3.add(b)
    total_rules += n
    bad = d_sid or d_k1 or d_k3
    fail += bad
    mark = "OK " if not bad else "FAIL"
    if bad or n > 40000:
        print(f"{mark} {os.path.relpath(p, '/home/z/my-project/download')}: правил={n:,}, "
              f"дублSID={d_sid}, дублK1={d_k1}, дублK3={d_k3}")
print(f"ИТОГО: файлов {len(files)}, правил {total_rules:,}, проблем: {fail}")

# сверка SID-набора talos-snort2 с импорт-набором v2
kit = set()
for p in sorted(glob.glob("/home/z/my-project/download/snort2-import-kit/clearndr-talos2-kit-*of10-20261108.rules")):
    for line in open(p, encoding="utf-8"):
        if RULE_RE.match(line):
            kit.add(SID_RE.search(line).group(1))
src = set()
for line in open("/home/z/my-project/download/rules/by-source/clearndr-src-talos-snort2-converted-20261107.rules", encoding="utf-8"):
    if RULE_RE.match(line):
        src.add(SID_RE.search(line).group(1))
print(f"\nSID talos-snort2: {len(src):,}; SID импорт-набора v2: {len(kit):,}")
print(f"Совпадение наборов: {'ПОЛНОЕ' if src == kit else 'РАСХОЖДЕНИЕ: ' + str(len(src ^ kit))}")
