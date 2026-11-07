#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Минимизатор: сокращает битое правило до минимального воспроизводимого варианта."""
import re, subprocess, os, sys

env = dict(os.environ, LD_LIBRARY_PATH="/tmp/suri/root/usr/lib/x86_64-linux-gnu")

def validate(rules, sid_want=None):
    with open("/tmp/suri/rules/mini.rules", "w") as f:
        for i, r in enumerate(rules):
            f.write(r + "\n")
    r = subprocess.run(["/tmp/suri/root/usr/bin/suricata", "-T", "-c", "/tmp/suri/root/etc/suricata/suricata.yaml",
                        "-S", "/tmp/suri/rules/mini.rules", "-l", "/tmp/suri/logs"],
                       capture_output=True, text=True, env=env, timeout=120)
    out = r.stdout + r.stderr
    causes = []
    for l in out.splitlines():
        m = re.search(r'error parsing signature .* at line (\d+)', l)
        if m:
            causes.append((int(m.group(1)), l))
    # cause line стоит ПЕРЕД signature-строкой; ищем следующую за cause
    pairs = []
    lines = out.splitlines()
    for i, l in enumerate(lines):
        if "detect-parse" in l:
            for j in range(i + 1, min(i + 4, len(lines))):
                m = re.search(r'error parsing signature .* at line (\d+)', lines[j])
                if m:
                    pairs.append((int(m.group(1)), l.split("detect-parse:")[1][:90]))
                    break
    return r.returncode, pairs

def split_opts(rule):
    m = re.match(r'^(.*?)\((.*)\)\s*$', rule, re.S)
    head, body = m.group(1), m.group(2)
    opts, buf, in_q = [], [], False
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == '\\' and i + 1 < len(body):
            buf.append(body[i:i+2]); i += 2; continue
        if ch == '"': in_q = not in_q
        elif ch == ';' and not in_q:
            opts.append(''.join(buf).strip()); buf = []; i += 1; continue
        buf.append(ch); i += 1
    return head, [o for o in opts if o]

def minimize(rule):
    head, opts = split_opts(rule)
    # бинарное сокращение опций
    cur = list(opts)
    changed = True
    while changed and len(cur) > 3:
        changed = False
        n = len(cur) // 2 or 1
        while n >= 1:
            i = 0
            while i < len(cur):
                cand = cur[:i] + cur[i+n:]
                _, pairs = validate([head + "(" + "; ".join(cand) + ";)"])
                bad = any(p[1].startswith(("no matches", "mixes")) for p in pairs)
                if bad:
                    cur = cand
                    changed = True
                else:
                    i += n
            n //= 2
    return head, cur

if __name__ == "__main__":
    rules_file = sys.argv[1]
    targets = [int(x) for x in sys.argv[2].split(",")]  # номера строк (1-based)
    lines = open(rules_file).read().splitlines()
    for ln in targets:
        rule = lines[ln - 1]
        print(f"\n=== строка {ln} ===")
        rc, pairs = validate([rule])
        print(f"исходные причины: {pairs}")
        head, cur = minimize(rule)
        print(f"минимум ({len(cur)} опций): {head}({' ;'.join(cur)})")
