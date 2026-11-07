#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Патч файла экспорта data/exports/clearndr-import.rules:
1. Заменить правила Spamhaus DROP на полные из БД (раньше обрезались лимитом 8000 символов).
2. Исключить структурно битые правила (незакрытые кавычки/скобки — 2 бага в оригинальном ET Open).
3. Проверить целостность: каждое правило заканчивается ')', содержит sid, сбалансировано.
"""
import re, sqlite3, shutil, sys

SRC = "/home/z/my-project/data/exports/clearndr-import.rules"
BAK = SRC + ".bak"
DB = "/home/z/my-project/db/custom.db"
SPAMHAUS_SID_COL = "cmw6dry5z000irlhdt5msh332"
SPAMHAUS_NAME = "Spamhaus DROP (угнанные сети)"

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log|activate|dynamic)\s+\S+")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")

def balanced(line):
    in_q = False; p = 0; i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\": i += 2; continue
        if ch == '"': in_q = not in_q
        elif not in_q:
            if ch == "(": p += 1
            elif ch == ")": p -= 1
            if p < 0: return False
        i += 1
    return p == 0 and not in_q

shutil.copy(SRC, BAK)

# свежие правила Spamhaus из БД (refetch уже выполнен с исправленным кодом)
con = sqlite3.connect(DB)
fresh = [(sid, raw) for sid, raw in con.execute(
    "SELECT sid, raw FROM Rule WHERE sourceId=? ORDER BY sid", (SPAMHAUS_SID_COL,))]
con.close()
print(f"Свежих правил Spamhaus в БД: {len(fresh)}")
for sid, raw in fresh:
    assert raw.rstrip().endswith(")"), f"sid {sid}: не заканчивается ')'"
    assert balanced(raw), f"sid {sid}: дисбаланс скобок/кавычек"
    assert SID_RE.search(raw), f"sid {sid}: нет sid в тексте"
print("Все свежие правила валидны.")

# полный список sid свежих правил
fresh_sids = {sid for sid, _ in fresh}

lines_out = []
in_spamhaus = False
replaced = 0
dropped_bad = []
seen_sids = {}

def process_rule(line, src):
    """Вернуть True если правило оставлено."""
    global replaced
    r = line.rstrip("\n")
    if not r.rstrip().endswith(")") and not r.rstrip().endswith(";"):
        dropped_bad.append((src, "нет закрывающей скобки (обрезано?)", r[:80])); return False
    if not balanced(r):
        dropped_bad.append((src, "дисбаланс кавычек/скобок", r[:80])); return False
    m = SID_RE.search(r)
    if not m:
        dropped_bad.append((src, "нет sid в тексте", r[:80])); return False
    sid = int(m.group(1))
    if sid in seen_sids:
        dropped_bad.append((src, f"дубликат sid {sid} (уже у {seen_sids[sid]})", r[:80])); return False
    seen_sids[sid] = src
    return True

cur_src = None
rule_buf = None

for line in open(SRC, encoding="utf-8"):
    line = line.rstrip("\n")
    if line.startswith("# ["):
        cur_src = line[3:-1]
        continue
    if RULE_RE.match(line):
        if cur_src == SPAMHAUS_NAME:
            replaced += 1
            continue  # старые правила Spamhaus выбрасываем, вставим свежие позже
        if process_rule(line, cur_src):
            lines_out.append(("# [" + cur_src + "]", line))
        continue
    # заголовок исходного файла — пропускаем (перегенерируем)
# вставить свежие правила Spamhaus (после фидов — в конец блока фидов, порядок не критичен)
for sid, raw in fresh:
    assert sid not in seen_sids, f"конфликт: sid {sid} уже занят ({seen_sids.get(sid)})"
    seen_sids[sid] = SPAMHAUS_NAME
    lines_out.append(("# [" + SPAMHAUS_NAME + "]", raw))

print(f"Старых правил Spamhaus удалено: {replaced}; свежих вставлено: {len(fresh)}")
print(f"Битых правил исключено: {len(dropped_bad)}")
for src, why, prev in dropped_bad:
    print(f"  - [{src}] {why}: {prev}...")

# запись
with open(SRC, "w", encoding="utf-8") as f:
    f.write("# ─────────────────────────────────────────────────────────────\n")
    f.write(f"# Объединённый набор правил для Clear NDR / Suricata — исправленная сборка\n")
    f.write(f"# Правил: {len(lines_out)}\n")
    f.write("# ─────────────────────────────────────────────────────────────\n")
    for c, r in lines_out:
        f.write(c + "\n" + r + "\n")

total = len(lines_out)
print(f"\nИтог: {total} правил записано в {SRC}")
assert total > 100000, "слишком мало правил — что-то пошло не так"
