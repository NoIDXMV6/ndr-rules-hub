#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Диагностика файлов правил: аномалии, которые могут уронить импорт clearndr.
Печатает по каждому файлу: число правил, дубли SID, диапазон, BOM/CRLF/NUL,
не-ASCII, правила без msg/rev, самую длинную строку, подозрительные правила."""
import glob
import os
import re

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
MSG_WITH_SEMI = re.compile(r'msg\s*:\s*"[^"]*;[^"]*"')

def diag(path):
    name = os.path.basename(path).replace("-20261107.rules", "").replace("clearndr-src-", "")
    raw = open(path, "rb").read()
    bom = raw[:3] == b"\xef\xbb\xbf"
    crlf = raw.count(b"\r\n")
    nul = raw.count(b"\x00")
    text = raw.decode("utf-8", errors="replace")
    lines = text.split("\n")
    rules = [l for l in lines if RULE_RE.match(l)]
    sids, no_msg, no_rev, weird = [], 0, 0, []
    max_len, max_sid = 0, None
    for l in rules:
        m = SID_RE.search(l)
        sid = int(m.group(1)) if m else None
        if sid is not None:
            sids.append(sid)
        if "msg:" not in l:
            no_msg += 1
        if not re.search(r"\brev\s*:\s*\d+\s*;", l):
            no_rev += 1
        if len(l) > max_len:
            max_len, max_sid = len(l), sid
        if l.count('"') % 2 != 0:
            weird.append((sid, "UNBALANCED_QUOTES", len(l)))
        elif len(l) > 4000:
            weird.append((sid, "LONG", len(l)))
    dups = len(sids) - len(set(sids))
    non_ascii = sum(1 for ch in text if ord(ch) > 126)
    semi_in_msg = sum(1 for l in rules if MSG_WITH_SEMI.search(l))
    print(f"{name[:44]:44s} rules={len(rules):6d} dups={dups:3d} "
          f"sids=[{min(sids) if sids else '-'},{max(sids) if sids else '-'}]")
    print(f"{'':44s} bom={bom} crlf={crlf} nul={nul} non_ascii={non_ascii} "
          f"no_msg={no_msg} no_rev={no_rev} semi_in_msg={semi_in_msg} maxline={max_len} (sid={max_sid})")
    for w in weird[:6]:
        print(f"    !! {w}")

for p in sorted(glob.glob("/home/z/my-project/download/rules/by-source/*.rules")):
    diag(p)

print("\n=== полный файл для сравнения ===")
diag("/home/z/my-project/dist/clearndr-import-20261107.rules")
