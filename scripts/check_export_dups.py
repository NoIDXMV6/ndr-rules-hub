#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверка дубликатов SID в файле экспорта (по источникам)."""
import re
import sys
from collections import defaultdict

SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SRC_RE = re.compile(r"^# \[(.+)\]$")

path = sys.argv[1] if len(sys.argv) > 1 else "/home/z/my-project/data/exports/clearndr-import.rules"
owners = defaultdict(list)   # sid -> [источники]
cur = "unknown"
total = 0
for line in open(path, encoding="utf-8"):
    line = line.rstrip("\n")
    m = SRC_RE.match(line)
    if m:
        cur = m.group(1)
        continue
    if not RULE_RE.match(line):
        continue
    total += 1
    mm = SID_RE.search(line)
    if mm:
        owners[int(mm.group(1))].append(cur)

dups = {s: v for s, v in owners.items() if len(v) > 1}
print(f"файл: {path}")
print(f"всего правил: {total}; уникальных sid: {len(owners)}; дублирующихся sid: {len(dups)}")
by_pair = defaultdict(int)
for s, v in dups.items():
    key = tuple(sorted(set(v)))
    by_pair[key] += 1
print("\nдубли по парам источников:")
for pair, cnt in sorted(by_pair.items(), key=lambda kv: -kv[1])[:10]:
    print(f"  {cnt:6d}  {pair}")
if 33 in dups:
    print(f"\nsid 33 встречается в: {dups[33]}")
lo = [s for s in owners if s < 1_000_000_000]
print(f"\nsid ниже блока 1e9: {len(lo)} (минимальный: {min(owners) if owners else '-'})")
