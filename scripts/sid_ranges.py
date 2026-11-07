#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Диапазоны SID по источникам в файле экспорта (метки '# [label]').
Аргумент: путь к файлу правил."""
import re
import sys
from collections import defaultdict

path = sys.argv[1]
RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SRC_RE = re.compile(r"^# \[(.+)\]$")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")

per = defaultdict(list)
cur = "unknown"
for line in open(path, encoding="utf-8"):
    line = line.rstrip("\n")
    m = SRC_RE.match(line)
    if m:
        cur = m.group(1)
        continue
    if not RULE_RE.match(line):
        continue
    mm = SID_RE.search(line)
    if mm:
        per[cur].append(int(mm.group(1)))

print(f"{'источник':62s} {'правил':>7s} {'min sid':>12s} {'max sid':>12s}")
for label, sids in sorted(per.items(), key=lambda kv: -len(kv[1])):
    print(f"{label[:62]:62s} {len(sids):7d} {min(sids):12,d} {max(sids):12,d}")

all_sids = [s for v in per.values() for s in v]
if all_sids:
    print(f"\nИТОГО: {len(all_sids):,} правил; глобальный min {min(all_sids):,}; глобальный max {max(all_sids):,}")
    print(f"SID >= 1 млрд:              {sum(1 for s in all_sids if s >= 1_000_000_000):,}")
    print(f"SID в блоке 1.0-1.1 млрд:   {sum(1 for s in all_sids if 1_000_000_000 <= s < 1_100_000_000):,}")
    print(f"SID 3: {all_sids.count(3)};  SID 33: {all_sids.count(33)}")
