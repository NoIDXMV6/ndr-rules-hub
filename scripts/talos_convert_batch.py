#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пакетная конвертация + валидация Suricata 7.0.10:
 1. Talos Snort 2.9 (29200) — 61.5K правил, только мелкие фиксы
 2. Talos Snort 3-only (SIDs из 3200, которых нет в 29200) — полный конвертер s2x
 3. Результат: work/talos-converted.rules + отчёт по отброшенным
"""
import os, sys, re, subprocess, json
sys.path.insert(0, "/home/z/my-project/scripts")
from s2x_convert import convert_rule

S29_DIR = "/tmp/s2/rules"
S32_DIR = "/home/z/my-project/work/unpacked/snortrules-snapshot-3200"
OUT_DIR = "/home/z/my-project/work/convert"
os.makedirs(OUT_DIR, exist_ok=True)

SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
REV_RE = re.compile(r"\brev\s*:\s*(\d+)\s*;")
RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")

def collect_rules(paths, skip_files=(), uncomment=False):
    """[(raw, file)] из файлов .rules; uncomment=True раскомментирует '# alert ...' (упаковка Talos 29200)."""
    out = []
    for p in paths:
        base = os.path.basename(p)
        if base in skip_files:
            continue
        for line in open(p, encoding="utf-8", errors="replace"):
            line = line.strip()
            if line.startswith("#") and uncomment:
                line = line.lstrip("#").strip()
            if RULE_RE.match(line):
                out.append((line, base))
    return out

# ── 1. Snort 2.9 ─────────────────────────────────────────────────────────────
s29_files = sorted(os.path.join(S29_DIR, f) for f in os.listdir(S29_DIR) if f.endswith(".rules"))
s29 = collect_rules(s29_files, skip_files={"deleted.rules"}, uncomment=True)
print(f"Snort 2.9: {len(s29)} правил из {len(s29_files)-1} файлов (без deleted.rules)")

# ── 2. Snort 3-only ─────────────────────────────────────────────────────────
s29_sids = {int(SID_RE.search(r).group(1)) for r, _ in s29 if SID_RE.search(r)}
s32_files = sorted(os.path.join(S32_DIR, "rules", f) for f in os.listdir(os.path.join(S32_DIR, "rules")) if f.endswith(".rules"))
s32_all = collect_rules(s32_files)
s32_only = [(r, f) for r, f in s32_all if (m := SID_RE.search(r)) and int(m.group(1)) not in s29_sids]
print(f"Snort 3: {len(s32_all)} всего; snort3-only (нет в 29200): {len(s32_only)}")

# ── 3. Конвертация ───────────────────────────────────────────────────────────
out_lines = []          # финальные правила (дедуп по sid внутри Talos)
by_sid = {}
stats = {"s29_total": len(s29), "s32_total": len(s32_only), "converted": 0, "dropped": 0}
drop_reasons = {}
notes_counter = {}

def add_rule(raw, sid, rev, tag):
    prev = by_sid.get(sid)
    if prev and prev[1] >= rev:
        return
    by_sid[sid] = (raw, rev, tag)

for raw, fname in s29:
    m = SID_RE.search(raw)
    if not m:
        stats["dropped"] += 1; drop_reasons["нет sid"] = drop_reasons.get("нет sid", 0) + 1; continue
    sid = int(m.group(1)); rev = int(REV_RE.search(raw).group(1)) if REV_RE.search(raw) else 0
    res = convert_rule(raw)
    if res.dropped:
        stats["dropped"] += 1
        key = res.notes[0] if res.notes else "?"
        drop_reasons[key] = drop_reasons.get(key, 0) + 1
        continue
    stats["converted"] += 1
    for n in res.notes:
        key = re.sub(r"\d+", "N", n)
        notes_counter[key] = notes_counter.get(key, 0) + 1
    add_rule(res.raw, sid, rev, f"Talos Snort 2.9 [{fname.replace('.rules','')}]")

for raw, fname in s32_only:
    m = SID_RE.search(raw)
    if not m:
        stats["dropped"] += 1; continue
    sid = int(m.group(1)); rev = int(REV_RE.search(raw).group(1)) if REV_RE.search(raw) else 0
    res = convert_rule(raw)
    if res.dropped:
        stats["dropped"] += 1
        key = res.notes[0] if res.notes else "?"
        drop_reasons[key] = drop_reasons.get(key, 0) + 1
        continue
    stats["converted"] += 1
    for n in res.notes:
        key = re.sub(r"\d+", "N", n)
        notes_counter[key] = notes_counter.get(key, 0) + 1
    add_rule(res.raw, sid, rev, "Talos Snort 3 (конвертировано)")

print(f"Конвертировано: {stats['converted']}, отброшено: {stats['dropped']}")
print("Причины отбраковки:")
for k, v in sorted(drop_reasons.items(), key=lambda x: -x[1]):
    print(f"  {v:5d}  {k}")
print("Применённые преобразования (топ):")
for k, v in sorted(notes_counter.items(), key=lambda x: -x[1])[:12]:
    print(f"  {v:5d}  {k}")

final = sorted(by_sid.items())
with open(os.path.join(OUT_DIR, "talos-converted.rules"), "w", encoding="utf-8") as f:
    for sid, (raw, rev, tag) in final:
        f.write(f"# [{tag}]\n{raw}\n")
print(f"Итог Talos: {len(final)} уникальных SID → {OUT_DIR}/talos-converted.rules")

# ── 4. Валидация Suricata ────────────────────────────────────────────────────
env = dict(os.environ, LD_LIBRARY_PATH="/tmp/suri/root/usr/lib/x86_64-linux-gnu")
flat = os.path.join(OUT_DIR, "talos-flat.rules")
with open(flat, "w", encoding="utf-8") as f:
    for sid, (raw, rev, tag) in final:
        f.write(raw + "\n")
r = subprocess.run(["/tmp/suri/root/usr/bin/suricata", "-T", "-c", "/tmp/suri/root/etc/suricata/suricata.yaml",
                    "-S", flat, "-l", "/tmp/suri/logs"],
                   capture_output=True, text=True, env=env, timeout=280)
out = r.stdout + r.stderr
errs = [l for l in out.splitlines() if "error parsing signature" in l]
print(f"\n=== Валидация Suricata: exit={r.returncode}, битых правил: {len(errs)} ===")
for l in errs[:10]:
    print(l[:200])
# причины
causes = [l for l in out.splitlines() if "detect-parse" in l]
from collections import Counter
cc = Counter(re.sub(r"[0-9]+", "N", c.split("E: detect-parse:")[1][:110].strip()) for c in causes)
for k, v in cc.most_common(10):
    print(f"  {v:5d}  {k}")
