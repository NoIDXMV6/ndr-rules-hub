#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Анализ совместимости нотаций Snort 3 / Snort 2 / Suricata на живом корпусе.
Извлекает все ключевые слова правил с частотами (по источникам) и статистику
проблемного синтаксиса → work/keyword-stats.json
"""
import re, json, sys
from collections import Counter, defaultdict

SRC = "/home/z/my-project/data/exports/clearndr-import.rules"
OUT = "/home/z/my-project/work/keyword-stats.json"

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")

def split_options(body: str):
    """Разбить тело опций '()' на top-level опции, уважая кавычки."""
    opts, buf, in_q, depth = [], [], False, 0
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            buf.append(body[i:i+2]); i += 2; continue
        if ch == '"':
            in_q = not in_q
        elif not in_q:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
            elif ch == ';' and depth == 0:
                opts.append(''.join(buf).strip()); buf = []; i += 1; continue
        buf.append(ch); i += 1
    tail = ''.join(buf).strip()
    if tail:
        opts.append(tail)
    return [o for o in opts if o]

def keyword_of(option: str):
    m = re.match(r'^([a-zA-Z][a-zA-Z0-9_.]*)\s*[:;]', option)
    return m.group(1) if m else option  # флаговые ключевые слова без значения (nocase, fast_pattern...)

# Синтаксические особенности для конвертера: собираем варианты значений
FEATURES = ["bufferlen", "byte_math", "http_header", "http_num_headers", "http_header_test",
            "http_header:field", "byte_extract", "loop", "keystore", "pkt_trace", "to_utf6",
            "sniff_interval", "snort", "attribute_table", "bsize", "sticky_buffer", "stream_reconnect"]
feature_values = defaultdict(Counter)  # feature -> Counter(value-shape)
feature_sources = defaultdict(Counter)  # feature -> Counter(source)

kw_total = Counter()                # keyword -> count
kw_by_src = defaultdict(Counter)    # keyword -> Counter(source)
rules_total = 0
cur_src = None

def value_shape(v: str) -> str:
    v = v.strip().strip(';').strip()
    v = re.sub(r'"[^"]*"', '"..."', v)
    v = re.sub(r'\d+', 'N', v)
    return v[:60]

for line in open(SRC, encoding="utf-8"):
    line = line.rstrip("\n")
    if line.startswith("# ["):
        cur_src = line[3:-1]; continue
    if not RULE_RE.match(line):
        continue
    rules_total += 1
    m = re.match(r'^[^()]*\((.*)\)\s*$', line)
    if not m:
        continue
    for opt in split_options(m.group(1)):
        kw = keyword_of(opt)
        kw_total[kw] += 1
        kw_by_src[kw][cur_src] += 1
        for f in FEATURES:
            if kw == f or (f.endswith(":field") and opt.lower().startswith(f[:-5] + ":field")):
                feature_values[f][value_shape(opt.split(':', 1)[1] if ':' in opt else '')] += 1
                feature_sources[f][cur_src] += 1

out = {
    "rules_total": rules_total,
    "keywords": {k: v for k, v in kw_total.most_common()},
    "keywords_by_source": {k: dict(c) for k, c in sorted(kw_by_src.items(), key=lambda x: -sum(x[1].values()))},
    "features": {f: {"values": dict(feature_values[f].most_common(12)),
                     "sources": dict(feature_sources[f])} for f in FEATURES if feature_values[f]},
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

print(f"Правил: {rules_total}; уникальных ключевых слов: {len(kw_total)}")
print("\nTOP-60 ключевых слов:")
for k, v in kw_total.most_common(60):
    print(f"  {v:7d}  {k}")
print("\nПроблемные фичи:")
for f, d in out["features"].items():
    print(f"  {f}: {sum(d['sources'].values())} вхождений; варианты: {list(d['values'])[:6]}")
