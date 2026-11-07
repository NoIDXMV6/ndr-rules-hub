#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Инвентаризация SID в валидированном экспорте: метки, счётчики, диапазоны, утечки raw Snort3."""
import re
from collections import defaultdict

SRC = "/home/z/my-project/data/exports/clearndr-import-validated.rules"
RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SRC_RE = re.compile(r"^# \[(.+)\]$")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
SNORT3_ONLY = re.compile(r"\b(bufferlen|http_header_test|http_num_headers|to_utf6|pkt_trace|sniff_interval|keystorage)\b"
                         r"|http_header\s*:\s*field|http_uri\s*:\s*field|http_uri\s*:\s*path|http_uri\s*:\s*query")

per = defaultdict(list)   # label -> sids
snort3_leak = defaultdict(list)  # label -> [sids]
sid_owner = {}            # sid -> label (для поиска дубликатов между источниками)
dups = []
no_sid = 0
total = 0

cur = "unknown"
for line in open(SRC, encoding="utf-8"):
    line = line.rstrip("\n")
    m = SRC_RE.match(line)
    if m:
        cur = m.group(1)
        continue
    if not RULE_RE.match(line):
        continue
    total += 1
    mm = SID_RE.search(line)
    if not mm:
        no_sid += 1
        continue
    sid = int(mm.group(1))
    per[cur].append(sid)
    if sid in sid_owner and sid_owner[sid] != cur:
        dups.append((sid, sid_owner[sid], cur))
    else:
        sid_owner[sid] = cur
    if SNORT3_ONLY.search(line):
        snort3_leak[cur].append(sid)

print(f"Всего правил: {total}, без sid: {no_sid}, дубликатов sid между источниками: {len(dups)}")
print(f"{'Источник':58s} {'правил':>7s} {'min sid':>10s} {'max sid':>10s}")
for label, sids in sorted(per.items(), key=lambda kv: -len(kv[1])):
    print(f"{label[:58]:58s} {len(sids):7d} {min(sids):10d} {max(sids):10d}")

print("\nУтечки raw Snort3-синтаксиса по источникам:")
for label, sids in snort3_leak.items():
    print(f"  {label[:60]}: {len(sids)} правил, напр. sids {sorted(set(sids))[:6]}")

# занятые диапазоны
buckets = defaultdict(int)
for label, sids in per.items():
    for s in sids:
        buckets[s // 10_000_000 * 10_000_000] += 1
print("\nЗанятость 10-миллионных диапазонов:")
for b in sorted(buckets):
    print(f"  {b:>12,d} .. {b+9_999_999:<12,d}: {buckets[b]:6d}")
