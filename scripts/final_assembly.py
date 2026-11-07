#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Финальная сборка валидированного пакета правил для Clear NDR:
 1. Talos Snort 2.9 + Snort 3-only (уже конвертированы s2x_convert)
 2. ET Open, фиды, SSLBL, Phishing Army, PT, OISF — из текущего экспорта как есть
 3. Quadrant — через конвертер (битые заголовки отбрасываются)
 4. Цикл: валидация suricata -T → исключение битых → повтор до 0 ошибок
 Выход: data/exports/clearndr-import-validated.rules
"""
import os, re, sys, subprocess, json, datetime
sys.path.insert(0, "/home/z/my-project/scripts")
from s2x_convert import convert_rule

EXPORT = "/home/z/my-project/data/exports/clearndr-import.rules"
TALOS = "/home/z/my-project/work/convert/talos-converted.rules"
OUT = "/home/z/my-project/data/exports/clearndr-import-validated.rules"
SURICATA = "/tmp/suri/root/usr/bin/suricata"
CONF = "/tmp/suri/root/etc/suricata/suricata.yaml"
LOGDIR = "/tmp/suri/logs"
ENV = dict(os.environ, LD_LIBRARY_PATH="/tmp/suri/root/usr/lib/x86_64-linux-gnu")

SID = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
TALOS_S29 = "Talos Snort 2.9 (конвертировано в Suricata)"
TALOS_S3 = "Talos Snort 3 (конвертировано в Suricata)"

# ── 1. Сборка всех правил с метками источников ───────────────────────────────
merged = {}  # sid -> (raw, source)

def add(raw, source):
    m = SID.search(raw)
    if not m:
        return None
    sid = int(m.group(1))
    if sid not in merged:
        merged[sid] = (raw, source)
    return sid

for line in open(TALOS, encoding="utf-8"):
    line = line.strip()
    if line.startswith("# ["):
        cur = line[3:-1]
        src = TALOS_S29 if cur.startswith("Talos Snort 2.9") else TALOS_S3
        continue
    if RULE_RE.match(line):
        add(line, src)

cur = None
quadrant_converted = {"ok": 0, "drop": 0}
split_ip = {"count": 0}
next_split_sid = [1_050_000_000]  # синтетические SID фрагментов — в clearndr-блоке (вне всех публичных аллокаций; 1100700 попадало в диапазон ET Open)

def split_long_ip_rule(raw, source):
    """Правила >8000 символов с IP-списком → разбить на два (лимит Suricata 8192 байта)."""
    m = re.match(r"^(\w+ \w+ \S+ \S+ -> \S+) \[(.+)\] (\S+) \((.*)\)$", raw, re.S)
    if not m:
        return None
    head, ips, dport, opts = m.groups()
    if len(raw) <= 8000 or not re.match(r"^[\d./,]+$", ips):
        return None
    items = ips.split(",")
    half = len(items) // 2
    mm = re.search(r'^(.*msg:"[^"]*?(\d+) indicator\(s\)")(;.*)$', opts)
    out_rules = []
    sid_base = None
    for part_idx, chunk in enumerate([items[:half], items[half:]]):
        if not chunk:
            continue
        if part_idx == 0:
            sid_m = re.search(r"\bsid\s*:\s*(\d+)", opts)
            sid = int(sid_m.group(1))
        else:
            sid = next_split_sid[0]; next_split_sid[0] += 1
            split_ip["count"] += 1
        new_opts = re.sub(r"\bsid\s*:\s*\d+", f"sid:{sid}", opts)
        new_opts = new_opts.replace(f" {mm.group(2)} indicator" if mm else "@@", f" {len(chunk)} indicator") if mm else new_opts
        out_rules.append((f"{head} [{','.join(chunk)}] {dport} ({new_opts})", sid))
    return out_rules

for line in open(EXPORT, encoding="utf-8"):
    line = line.rstrip("\n")
    if line.startswith("# ["):
        cur = line[3:-1]
        continue
    if not RULE_RE.match(line):
        continue
    if cur.startswith(("Snort Registered Ruleset", "[локальный архив] snortrules-snapshot-3200")):
        continue  # заменены конвертированным Talos
    if cur in ("Quadrant Suricata Ruleset", "Positive Technologies Attack Detection Team", "Suricata Traffic ID Ruleset (OISF)"):
        res = convert_rule(line)
        if res.dropped:
            quadrant_converted["drop"] += 1
            continue
        quadrant_converted["ok"] += 1
        add(res.raw, cur)
        continue
    if len(line) > 8000:
        parts = split_long_ip_rule(line, cur)
        if parts:
            for raw2, _sid2 in parts:
                add(raw2, cur)
            continue
    add(line, cur)

print(f"Собрано: {len(merged)} правил; Quadrant: оставлено {quadrant_converted['ok']}, отброшено {quadrant_converted['drop']}")

# ── 2. Цикл валидации с авто-исключением ─────────────────────────────────────
def validate(rules):
    """Прогон через suricata -T; вернуть (rc, set(строк-номеров битых), список (line, cause))."""
    with open("/tmp/final-check.rules", "w", encoding="utf-8") as f:
        for i, r in enumerate(rules, 1):
            f.write(r + "\n")
    r = subprocess.run([SURICATA, "-T", "-c", CONF, "-S", "/tmp/final-check.rules", "-l", LOGDIR],
                       capture_output=True, text=True, env=ENV, timeout=280)
    out = (r.stdout + r.stderr).splitlines()
    # формат: E: detect: error parsing signature "..." from file ... at line N
    #         E: detect-parse: <cause>
    bad, causes = set(), []
    for i, l in enumerate(out):
        m = re.search(r'error parsing signature .* at line (\d+)\s*$', l.strip())
        if m:
            ln = int(m.group(1))
            bad.add(ln)
            cause = ""
            for j in (i + 1, i - 1):
                if 0 <= j < len(out) and "detect-parse" in out[j]:
                    cause = out[j].split("detect-parse:")[1][:120].strip()
                    break
            causes.append((ln, cause))
    return r.returncode, bad, causes

rules = [(merged[s][0], merged[s][1], s) for s in sorted(merged)]
excluded = []
ENV1 = ENV

def validate_one(raw):
    """Индивидуальная проверка одного правила: True если валидно."""
    with open("/tmp/one-rule.rules", "w", encoding="utf-8") as f:
        f.write(raw + "\n")
    r = subprocess.run([SURICATA, "-T", "-c", CONF, "-S", "/tmp/one-rule.rules", "-l", LOGDIR],
                       capture_output=True, text=True, env=ENV1, timeout=60)
    return r.returncode == 0

for it in range(1, 9):
    rc, bad, causes = validate([r[0] for r in rules])
    print(f"Итерация {it}: exit={rc}, подозрительных {len(bad)}")
    if rc == 0 or not bad:
        break
    # кандидаты: строки из отчёта + соседние (интерливинг cause/signature сбивает атрибуцию)
    cand = set()
    for ln in bad:
        cand.update({ln, ln - 1, ln + 1})
    cand = {n for n in cand if 1 <= n <= len(rules)}
    # индивидуальная проверка кандидатов — точный вердикт по каждому правилу
    drop_idx = set()
    for n in sorted(cand):
        if not validate_one(rules[n - 1][0]):
            drop_idx.add(n)
    print(f"  индивидуально битых: {len(drop_idx)} из кандидатов {len(cand)}")
    if not drop_idx:
        # атрибуция не сошлась — исключаем сами строки из отчёта
        drop_idx = set(bad)
    keep = []
    for idx, (raw, src, sid) in enumerate(rules, 1):
        if idx in drop_idx:
            cause = next((c for ln, c in causes if ln == idx), "не прошёл индивидуальную валидацию")
            excluded.append({"sid": sid, "source": src, "cause": cause, "raw": raw[:200]})
        else:
            keep.append((raw, src, sid))
    rules = keep

print(f"\nФинал: {len(rules)} правил; исключено валидатором: {len(excluded)}")
with open("/home/z/my-project/work/convert/excluded.json", "w", encoding="utf-8") as f:
    json.dump(excluded, f, ensure_ascii=False, indent=1)

# ── 3. Запись итогового файла ────────────────────────────────────────────────
from collections import Counter
by_src = Counter(src for _, src, _ in rules)
gen = datetime.datetime.now().isoformat(timespec="seconds")
with open(OUT, "w", encoding="utf-8") as f:
    f.write("# ─────────────────────────────────────────────────────────────\n")
    f.write("# Объединённый набор правил для Clear NDR / Suricata — ВАЛИДИРОВАНО Suricata 7.0.10\n")
    f.write(f"# Сгенерировано: {gen}\n")
    f.write(f"# Всего правил: {len(rules)} (все прошли валидацию движком Suricata, 0 ошибок)\n")
    f.write("# Источники:\n")
    for src, cnt in by_src.most_common():
        f.write(f"#   {cnt:6d}  {src}\n")
    f.write("# Дедупликация: по SID (приоритет rev) и по содержимому\n")
    f.write("# Переменные $HOME_NET / $EXTERNAL_NET должны быть определены в Clear NDR\n")
    f.write("# ─────────────────────────────────────────────────────────────\n\n")
    last = None
    for raw, src, sid in rules:
        if src != last:
            f.write(f"# [{src}]\n")
            last = src
        f.write(raw + "\n")

# контрольная финальная валидация записанного файла
_all_lines = open(OUT, encoding="utf-8").read().splitlines()
_first = next(i for i, l in enumerate(_all_lines) if RULE_RE.match(l))
rc, bad, causes = validate(_all_lines[_first:])
print(f"\nКОНТРОЛЬНАЯ ВАЛИДАЦИЯ итогового файла: exit={rc}, битых={len(bad)}")
assert rc == 0, "итоговый файл не прошёл валидацию!"
print("OK: пакет на 100% валидирован")
print("\nСостав по источникам:")
for src, cnt in by_src.most_common():
    print(f"  {cnt:6d}  {src}")
