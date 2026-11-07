#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сравнение наборов опций-ключевых слов между by-source файлами.
Ищем ключевые слова, которые есть в falose-файле, но НЕТ ни в одном успешно
импортированном файле — это кандидаты на отказ парсера clearndr."""
import glob
import os
import re
from collections import defaultdict

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
OPT_RE = re.compile(r"(?:^|\()\s*|;")

def keywords_of(rule):
    # тело правила в скобках
    i = rule.find("(")
    if i < 0:
        return set()
    body = rule[i:]
    # грубое разбиение по ';' вне кавычек
    kws, buf, in_q, esc = [], [], False, False
    for ch in body:
        if esc:
            buf.append(ch); esc = False; continue
        if ch == "\\":
            buf.append(ch); esc = True; continue
        if ch == '"':
            in_q = not in_q; buf.append(ch); continue
        if ch == ";" and not in_q:
            kws.append("".join(buf)); buf = []; continue
        buf.append(ch)
    kws.append("".join(buf))
    out = set()
    for opt in kws:
        opt = opt.strip().lstrip("(").strip()
        if not opt:
            continue
        m = re.match(r"([a-zA-Z_0-9]+)\s*:", opt)
        if m:
            out.add(m.group(1).lower())
        else:
            out.add(opt.split()[0].lower() if opt.split() else "?")
    return out

per = {}
for p in sorted(glob.glob("/home/z/my-project/download/rules/by-source/*.rules")):
    name = os.path.basename(p).replace("clearndr-src-", "").replace("-20261107.rules", "")
    kws = defaultdict(int)
    for line in open(p, encoding="utf-8"):
        if RULE_RE.match(line):
            for k in keywords_of(line):
                kws[k] += 1
    per[name] = kws

ok = ["abusech-sslbl", "blocklistde", "cins-army", "et-open", "feodo-iplist",
      "feodo-rules", "oisf-traffic-id", "phishing-army", "pt-attack-detection",
      "quadrant", "spamhaus-drop", "talos-snort3-converted"]
ok_union = set()
for n in ok:
    ok_union |= set(per[n])

target = per["talos-snort2-converted"]
uniq = {k: v for k, v in target.items() if k not in ok_union}
print(f"Ключевые слова ТОЛЬКО в talos-snort2-converted (нет ни в одном успешном файле): {len(uniq)}")
for k, v in sorted(uniq.items(), key=lambda kv: -kv[1]):
    print(f"  {k:28s} {v:6d}")

# и для справки: частота всех ключевых слов snort2-файла, топ-40
print("\nТоп-40 ключевых слов talos-snort2-converted:")
for k, v in sorted(target.items(), key=lambda kv: -kv[1])[:40]:
    print(f"  {k:28s} {v:6d}")
