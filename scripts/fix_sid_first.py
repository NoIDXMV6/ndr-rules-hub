#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Перенос `sid:NNN;` в начало списка опций правила.

Причина: парсер Scirius достаёт SID регэкспом `sid *: *(\\d+)` — ПЕРВОЕ совпадение
в строке. В правилах Talos BROWSER-* внутри content:"clsid:33FD63B1-..." есть
подстрока `sid:33...`, и Scirius принимает GUID за SID правила. Перенос реального
sid в начало опций делает его первым совпадением регэкспа (порядок опций в
Snort/Suricata свободный, семантика правила не меняется).
"""
import re, sys, os

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s")
SID_OPT = re.compile(r"(?P<sid>\bsid *: *\d+ *;)\s*")
HEAD_RE = re.compile(r"^(?P<head>[^()]+)\(\s*(?P<rest>.*)$")

def fix_line(line: str) -> str:
    if not RULE_RE.match(line):
        return line
    m = SID_OPT.search(line)
    if not m:
        return line
    # sid уже первый после '(' — не трогаем
    head = HEAD_RE.match(line)
    if head and head.group('rest').lstrip().startswith('sid'):
        return line
    sid_txt = m.group('sid')
    without = line[:m.start()] + line[m.end():]
    # вставляем sid сразу после открывающей скобки опций
    paren = without.find('(')
    if paren == -1:
        return line
    insert_at = paren + 1
    fixed = without[:insert_at] + sid_txt + ' ' + without[insert_at:]
    # подчищаем возможный двойной пробел
    fixed = re.sub(r"\(\s+", "(", fixed, count=1)
    fixed = re.sub(r"sid *: *(\d+) *;\s+", lambda mm: f"sid:{mm.group(1)}; ", fixed, count=1)
    return fixed

def main(src: str, dst: str):
    n_rules = n_fixed = 0
    with open(src, encoding="utf-8") as fin, open(dst, "w", encoding="utf-8") as fout:
        for line in fin:
            line = line.rstrip("\n")
            if RULE_RE.match(line):
                n_rules += 1
                nl = fix_line(line)
                if nl != line:
                    n_fixed += 1
                line = nl
            fout.write(line + "\n")
    print(f"{os.path.basename(src)} -> {os.path.basename(dst)}: правил {n_rules:,}, переставлен sid в {n_fixed:,}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
