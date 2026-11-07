#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Точная симуляция парсера Scirius (rules/models.py: get_rules):
- regex `sid *: *(\\d+)` — ПЕРВОЕ совпадение в строке;
- строки с '#' пропускаются, кроме «закомментированных сигнатур» (->, sid, ) в строке);
- дубликат sid внутри одного файла => DuplicateSidException(same_source=True).
Ищем строки, где совпадение sid НЕ является нашим реальным sid:1XXXXXXXXX;"""
import re, sys, zipfile, tempfile, os, glob
from collections import defaultdict

GETSID = re.compile(r"sid *: *(\d+)")
REAL_SID = re.compile(r"\bsid *: *1\d{9} *;")

def scirius_lines(path):
    """(line_no, line, state) в том виде, в каком их увидит get_rules."""
    out = []
    for i, line in enumerate(open(path, encoding="utf-8", errors="replace"), 1):
        if line.startswith('#'):
            if "->" in line and "sid" in line and ")" in line:
                line = line.lstrip("# ")
                state = False
            else:
                continue
        else:
            state = True
        out.append((i, line.rstrip("\n"), state))
    return out

def check_file(path, verbose=True):
    problems = []
    seen = defaultdict(list)  # sid -> [(line_no, line)]
    for i, line, state in scirius_lines(path):
        m = GETSID.search(line)
        if not m:
            continue
        sid = int(m.group(1))
        seen[sid].append((i, line))
        rm = REAL_SID.search(line)
        # совпадение не на месте реального sid — подозрительно
        if not rm or m.start() != rm.start():
            problems.append(("ODD", i, sid, line))
    dups = {s: ls for s, ls in seen.items() if len(ls) > 1}
    return seen, dups, problems

def main(targets):
    grand_files = 0
    for t in targets:
        paths = []
        if os.path.isdir(t):
            paths = sorted(glob.glob(os.path.join(t, "**", "*.rules"), recursive=True))
        else:
            tmp = tempfile.mkdtemp(prefix="scirsim-")
            with zipfile.ZipFile(t) as z:
                z.extractall(tmp)
            paths = sorted(glob.glob(os.path.join(tmp, "**", "*.rules"), recursive=True))
        for p in paths:
            grand_files += 1
            seen, dups, problems = check_file(p)
            rel = os.path.relpath(p, t if os.path.isdir(t) else "/tmp")
            status = "OK"
            if dups:
                status = f"CONFLICT: {len(dups)} дубликатов sid"
            elif problems:
                status = f"подозрительных строк: {len(problems)}"
            if dups or problems:
                print(f"\n== {rel}: парсится строк: {sum(len(v) for v in seen.values())}, {status}")
                for kind, i, sid, line in problems[:8]:
                    pos = GETSID.search(line).start()
                    print(f"   [{kind}] стр.{i} совпадение sid={sid} на позиции {pos}:")
                    print(f"        {line[:200]}")
                for sid, ls in list(dups.items())[:5]:
                    print(f"   [DUP] sid={sid} встречается {len(ls)} раз:")
                    for i, line in ls[:2]:
                        print(f"        стр.{i}: {line[:200]}")
    if grand_files == 0:
        print("файлы не найдены")
    print(f"\nПроверено файлов: {grand_files}")

if __name__ == "__main__":
    main(sys.argv[1:])
