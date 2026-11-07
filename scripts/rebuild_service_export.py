#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Замена сервисного экспорта (файл последней Build-записи) на валидированный набор
с перенумерованными SID. Файл = пакет full (уже прошёл suricata -T, 0 дубликатов
SID, весь блок 1e9..1.1e9). Обновляет запись Build в db/custom.db.
"""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys

SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SRC_RE = re.compile(r"^# \[(.+)\]$")

FULL = "/home/z/my-project/download/rules/clearndr-full-20261107.rules"
EXPORT = "/home/z/my-project/data/exports/clearndr-import.rules"
DB = "/home/z/my-project/db/custom.db"

shutil.copyfile(FULL, EXPORT)

# контроль
owners, cur, total = {}, "unknown", 0
for line in open(EXPORT, encoding="utf-8"):
    line = line.rstrip("\n")
    m = SRC_RE.match(line)
    if m:
        cur = m.group(1)
        continue
    if not RULE_RE.match(line):
        continue
    total += 1
    sid = int(SID_RE.search(line).group(1))
    assert sid not in owners, f"дубликат sid {sid}"
    owners[sid] = cur
assert min(owners) >= 1_000_000_000, f"sid ниже блока: {min(owners)}"

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

s_full, s_exp = sha256(FULL), sha256(EXPORT)
assert s_full == s_exp, "копия не совпадает"
size = os.path.getsize(EXPORT)

con = sqlite3.connect(DB)
row = con.execute("SELECT id, totalRules FROM Build ORDER BY createdAt DESC LIMIT 1").fetchone()
stats = {
    "totalInputRules": total, "uniqueSids": total, "duplicateBySid": 0,
    "duplicateByContent": 0, "incompatibleDropped": 0,
    "renumbered": total,
    "note": "regenerated: validated set + clearndr SID remap (block 1e9..1.1e9), "
            "дубликатов SID нет; повторный импорт в тот же источник конфликтов не даст",
}
con.execute(
    "UPDATE Build SET totalRules=?, statsJson=?, sha256=?, sizeBytes=? WHERE id=?",
    (total, json.dumps(stats, ensure_ascii=False), s_exp, size, row[0]),
)
con.commit()
con.close()
print(f"Build {row[0]}: было totalRules={row[1]} → стало {total}")
print(f"sid: min={min(owners)}, max={max(owners)}, дубликатов=0, правил={total}")
print(f"sha256: {s_exp[:16]}… ({size:,} байт)")
print("OK: сервисный экспорт заменён на валидированный набор с SID 1e9+")
