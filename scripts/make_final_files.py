#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборка итоговых файлов для тестирования на реальном Clear NDR
из ВАЛИДИРОВАННОГО набора (data/exports/clearndr-import-validated.rules).
Каждый файл уже прошёл suricata -T; здесь только группировка + контроль уникальности SID.
"""
import re, os, sys, hashlib, zipfile, datetime
from collections import defaultdict, OrderedDict

SRC = "/home/z/my-project/data/exports/clearndr-import-validated.rules"
OUT = "/home/z/my-project/download/rules"
DATE = datetime.date.today().strftime("%Y%m%d")
os.makedirs(OUT, exist_ok=True)
os.makedirs(os.path.join(OUT, "by-category"), exist_ok=True)
os.makedirs(os.path.join(OUT, "by-source"), exist_ok=True)

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SRC_RE = re.compile(r"^# \[(.+)\]$")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
CT_RE = re.compile(r"\bclasstype\s*:\s*([a-zA-Z0-9_-]+)\s*;")

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

rules, cur_src = [], "unknown"
for line in open(SRC, encoding="utf-8"):
    line = line.rstrip("\n")
    m = SRC_RE.match(line)
    if m:
        cur_src = m.group(1); continue
    if RULE_RE.match(line):
        sid = int(SID_RE.search(line).group(1)) if SID_RE.search(line) else None
        ct = CT_RE.search(line).group(1) if CT_RE.search(line) else None
        rules.append({"source": cur_src, "raw": line, "sid": sid, "classtype": ct})

assert len(rules) > 100000, f"подозрительно мало правил: {len(rules)}"
sys.stderr.write(f"Разобрано: {len(rules)} правил из {len({r['source'] for r in rules})} источников\n")

FEED_SOURCES = {"Blocklist.de (атакующие IP)", "CINS Army List (плохие IP)",
                "Spamhaus DROP (угнанные сети)", "Feodo Tracker Botnet C2 (IP list → правила)"}
CAT_MAP = {
    "malware-cnc": ["trojan-activity", "command-and-control", "domain-c2", "credential-theft",
                    "coin-mining", "malware", "pup-activity", "botnet"],
    "exploits-web": ["attempted-user", "attempted-admin", "web-application-attack", "exploit-kit",
                     "misc-attack", "shellcode-detect", "successful-admin", "file-format"],
    "recon-dos": ["attempted-recon", "attempted-dos", "denial-of-service", "successful-recon-limited",
                  "successful-recon-fileserver", "rpc-portmap-decode", "scan", "snoopy-attack"],
}
CT2CAT = {ct: c for c, cts in CAT_MAP.items() for ct in cts}
CAT_DESC = {
    "malware-cnc": "Вредоносное ПО, C&C-каналы, C2-домены, кража учётных данных, криптомайнеры",
    "exploits-web": "Эксплуатация уязвимостей, веб-атаки, exploit-kit'ы, шеллкоды",
    "recon-dos": "Сканирование, разведка, DoS/DDoS",
    "policy-info": "Политики, информационные события, фишинг, прочая активность",
    "ip-feeds": "Динамические IP-фиды: Blocklist.de, CINS Army, Spamhaus DROP, Feodo Tracker",
}
for r in rules:
    r["cat"] = "ip-feeds" if r["source"] in FEED_SOURCES else CT2CAT.get(r["classtype"], "policy-info")

def header(purpose, items, extra=""):
    srcs = sorted({r["source"] for r in items})
    h = ["# ─────────────────────────────────────────────────────────────",
         f"# Clear NDR: {purpose}",
         f"# Сгенерировано: {datetime.datetime.now().isoformat(timespec='seconds')}",
         f"# Правил: {len(items)} (все прошли валидацию Suricata 7.0.10)",
         f"# Источники: {', '.join(srcs) if srcs else '-'}"]
    if extra:
        h.append(f"# Примечание: {extra}")
    h += ["# Переменные $HOME_NET / $EXTERNAL_NET должны быть определены в конфигурации Clear NDR",
          "# ─────────────────────────────────────────────────────────────", ""]
    return "\n".join(h) + "\n"

def write_file(path, purpose, items, extra=""):
    with open(path, "w", encoding="utf-8") as f:
        f.write(header(purpose, items, extra))
        last = None
        for r in items:
            if r["source"] != last:
                f.write(f"# [{r['source']}]\n"); last = r["source"]
            f.write(r["raw"] + "\n")

created = OrderedDict()
created[f"clearndr-full-{DATE}.rules"] = ("Полный валидированный набор (все источники)", rules, "")

starter_small = {"Abuse.ch SSL Blacklist (SSL certificates)", "Phishing Army (антифишинг)",
                 "Positive Technologies Attack Detection Team", "Quadrant Suricata Ruleset",
                 "Suricata Traffic ID Ruleset (OISF)"} | FEED_SOURCES
STARTER_CT = {"trojan-activity", "command-and-control", "domain-c2", "exploit-kit",
              "credential-theft", "coin-mining", "shellcode-detect", "botnet", "malware"}
starter = [r for r in rules if r["source"] in starter_small or r["classtype"] in STARTER_CT]
created[f"clearndr-starter-{DATE}.rules"] = ("Рекомендуемый стартовый набор (высокий сигнал)",
                                             starter, "malware/C&C/exploit-kit/фишинг/IP-фиды")

smoke, per = [], defaultdict(int)
for r in rules:
    if r["source"] in FEED_SOURCES:
        smoke.append(r); per[r["source"]] += 1
for r in rules:
    if r["source"] not in FEED_SOURCES and per[r["source"]] < 4:
        smoke.append(r); per[r["source"]] += 1
created[f"clearndr-smoke-{DATE}.rules"] = ("Быстрая проверка импорта", smoke, "")

by_cat = defaultdict(list)
for r in rules:
    by_cat[r["cat"]].append(r)
for cat, items in sorted(by_cat.items()):
    created[f"by-category/clearndr-cat-{cat}-{DATE}.rules"] = (f"Категория: {cat} — {CAT_DESC.get(cat,'')}", items, "")

SLUG = {
    "ET Open Ruleset (Emerging Threats)": "et-open",
    "Talos Snort 2.9 (конвертировано в Suricata)": "talos-snort2-converted",
    "Talos Snort 3 (конвертировано в Suricata)": "talos-snort3-converted",
    "Abuse.ch SSL Blacklist (SSL certificates)": "abusech-sslbl",
    "Phishing Army (антифишинг)": "phishing-army",
    "Positive Technologies Attack Detection Team": "pt-attack-detection",
    "Quadrant Suricata Ruleset": "quadrant",
    "Suricata Traffic ID Ruleset (OISF)": "oisf-traffic-id",
    "Blocklist.de (атакующие IP)": "blocklistde",
    "CINS Army List (плохие IP)": "cins-army",
    "Spamhaus DROP (угнанные сети)": "spamhaus-drop",
    "Feodo Tracker Botnet C2 (rules)": "feodo-rules",
    "Feodo Tracker Botnet C2 (IP list → правила)": "feodo-iplist",
}
by_src = defaultdict(list)
for r in rules:
    by_src[r["source"]].append(r)
for src, items in sorted(by_src.items()):
    slug = SLUG.get(src) or re.sub(r"[^a-z0-9]+", "-", src.lower()).strip("-")[:40]
    created[f"by-source/clearndr-src-{slug}-{DATE}.rules"] = (f"Источник: {src}", items, "")

fail = False
stats = []
for rel, spec in created.items():
    purpose, items = spec[0], spec[1]
    extra = spec[2] if len(spec) > 2 else ""
    sids, dup, bad = set(), 0, 0
    for r in items:
        if not RULE_RE.match(r["raw"]) or not balanced(r["raw"]):
            bad += 1
        if r["sid"] is not None:
            if r["sid"] in sids: dup += 1
            sids.add(r["sid"])
    write_file(os.path.join(OUT, rel), purpose, items, extra)
    ok = dup == 0 and bad == 0
    if not ok: fail = True
    stats.append((rel, len(items), dup, bad, ok))
    print(f"{'OK ' if ok else 'FAIL'} {rel}: правил={len(items)}, дубликатов SID={dup}, битых={bad}")

if fail:
    sys.exit("ВАЛИДАЦИЯ НЕ ПРОЙДЕНА")

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

sums = [f"{sha256(os.path.join(OUT, rel))}  {rel}" for rel in created]
with open(os.path.join(OUT, "SHA256SUMS.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(sums) + "\n")

readme = f"""# Итоговые наборы правил для Clear NDR — валидированный пакет

Дата сборки: {datetime.date.today().isoformat()}
**Весь пакет прошёл валидацию движком Suricata 7.0.10 (`suricata -T`): 0 ошибок загрузки.**
Полная сборка: {len(rules):,} уникальных правил из {len(by_src)} источников.

## Контроль качества

- Дедупликация по SID (приоритет более высокого rev) и по содержимому.
- Правила Snort 2/3 конвертированы в Suricata 7 конвертером s2x (sticky-буферы → dot-формы,
  inline-модификаторы content → отдельные ключевые слова, bufferlen → bsize и т.д.).
- Цикл валидации: `suricata -T` → разбор лога → исправление/исключение битых правил → повтор до 0 ошибок.
- Исключено валидатором: 234 правила ({100*234/len(rules):.2f}%) — несжимаемые несовместимости
  (byte_math, sip_*-буферы, dce_*, ber_*, конфликт направлений, битые заголовки Quadrant).
- Лимит длины правила Suricata 8192 байта учтён: длинные IP-листы разбиты на несколько правил.

## Состав пакета

| Файл | Правил | Назначение |
|---|---|---|
"""
for rel, n, dup, bad, ok in stats:
    readme += f"| `{rel}` | {n:,} | {created[rel][0]} |\n"
readme += f"""
## Рекомендуемый порядок тестирования

1. **smoke** — `clearndr-smoke-*.rules` ({len(smoke)} правил): проверка механизма импорта.
2. **starter** — `clearndr-starter-*.rules` ({len(starter):,} правил): высокий сигнал — основной файл для пилота.
3. **by-category** — выборочные категории под профиль сети.
4. **full** — полный набор ({len(rules):,} правил).

## Импорт в Clear NDR

1. UI Clear NDR → **Sources** → **Import** → загрузить выбранный `.rules` файл.
2. Переменные `$HOME_NET`/`$EXTERNAL_NET` — стандартные значения Suricata.
3. Перезагрузить правила и сверить количество загруженных с таблицей (должно совпасть — все правила валидированы).

## Проверка целостности

`sha256sum -c SHA256SUMS.txt`
"""
with open(os.path.join(OUT, "README-IMPORT.md"), "w", encoding="utf-8") as f:
    f.write(readme)

zip_path = f"/home/z/my-project/download/clearndr-rules-{DATE}.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for rel in list(created) + ["README-IMPORT.md", "SHA256SUMS.txt"]:
        z.write(os.path.join(OUT, rel), arcname=f"clearndr-rules-{DATE}/{rel}")
print(f"\nАрхив: {zip_path} ({os.path.getsize(zip_path)//1024//1024} МБ)")
print("Готово.")
