#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборка итоговых файлов правил для тестирования на реальном Clear NDR.

Вход:  /home/z/my-project/data/exports/clearndr-import.rules  (сборка сервиса, 120k правил)
Выход: /home/z/my-project/download/rules/
  clearndr-full-<date>.rules          — полный набор как есть
  clearndr-starter-<date>.rules       — строгий Suricata-совместимый высокосигнальный набор
  clearndr-smoke-<date>.rules         — ~50 правил для быстрой проверки импорта
  by-category/clearndr-cat-*.rules    — разбивка по категориям (каждое правило ровно в одном файле)
  by-source/clearndr-src-*.rules      — разбивка по источникам
  README-IMPORT.md, SHA256SUMS.txt
  + zip-архив всего пакета
"""
import re, os, sys, hashlib, zipfile, datetime
from collections import defaultdict, OrderedDict

SRC = "/home/z/my-project/data/exports/clearndr-import.rules"
OUT = "/home/z/my-project/download/rules"
DATE = datetime.date.today().strftime("%Y%m%d")

os.makedirs(OUT, exist_ok=True)
os.makedirs(os.path.join(OUT, "by-category"), exist_ok=True)
os.makedirs(os.path.join(OUT, "by-source"), exist_ok=True)

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log|activate|dynamic)\s+\S+")
SRC_RE = re.compile(r"^# \[(.+)\]$")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
REV_RE = re.compile(r"\brev\s*:\s*(\d+)\s*;")
CLASSTYPE_RE = re.compile(r"\bclasstype\s*:\s*([a-zA-Z0-9_-]+)\s*;")
# Ключевые слова Snort 3, которых нет в Suricata 7 (движок Clear NDR)
SNORT3_ONLY = re.compile(
    r"\b(bufferlen|byte_math|http_header_test|http_num_headers|to_utf6|pkt_trace|sniff_interval|keystorage)\b"
    r"|http_header\s*:\s*field|http_uri\s*:\s*field|app-layer\s*:"
)
BAL_PAREN = None  # вычисляем ниже

def balanced(line: str) -> bool:
    in_q = False
    p = 0
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\":
            i += 2
            continue
        if ch == '"':
            in_q = not in_q
        elif not in_q:
            if ch == "(":
                p += 1
            elif ch == ")":
                p -= 1
                if p < 0:
                    return False
        i += 1
    return p == 0 and not in_q

# ── 1. Разбор исходного файла ────────────────────────────────────────────────
header_lines = []          # строки заголовка исходного файла
rules = []                 # [{source, raw, sid, rev, classtype}]
cur_src = None
cur_raw = None

def flush():
    global cur_raw
    if cur_raw is not None:
        sid_m = SID_RE.search(cur_raw)
        rev_m = REV_RE.search(cur_raw)
        ct_m = CLASSTYPE_RE.search(cur_raw)
        rules.append({
            "source": cur_src or "unknown",
            "raw": cur_raw.rstrip("\n"),
            "sid": int(sid_m.group(1)) if sid_m else None,
            "rev": int(rev_m.group(1)) if rev_m else 0,
            "classtype": ct_m.group(1) if ct_m else None,
        })
    cur_raw = None

with open(SRC, encoding="utf-8") as f:
    for line in f:
        if line.startswith("# ─") or line.startswith("# Сгенерировано") or line.startswith("# Источники") \
           or line.startswith("# Всего правил") or line.startswith("# Дубликатов") or line.startswith("# Отброшено"):
            header_lines.append(line.rstrip("\n"))
            continue
        m = SRC_RE.match(line)
        if m:
            flush()
            cur_src = m.group(1)
            continue
        if RULE_RE.match(line):
            flush()
            cur_raw = line
            continue
        if cur_raw is not None and line.strip() and not line.startswith("#"):
            cur_raw += line  # многострочное правило (не должно встречаться, но на всякий случай)
flush()

sys.stderr.write(f"Разобрано правил: {len(rules)}\n")
assert len(rules) > 100000, "неожиданно мало правил — проверьте исходный файл"

# ── 2. Классификация ─────────────────────────────────────────────────────────
FEED_SOURCES = {"Blocklist.de (атакующие IP)", "CINS Army List (плохие IP)",
                "Spamhaus DROP (угнанные сети)", "Feodo Tracker Botnet C2 (IP list → правила)"}
CAT_MAP = {
    "malware-cnc": ["trojan-activity", "command-and-control", "domain-c2", "credential-theft",
                    "coin-mining", "malware", "pup-activity", "botnet"],
    "exploits-web": ["attempted-user", "attempted-admin", "web-application-attack", "exploit-kit",
                     "misc-attack", "shellcode-detect", "successful-admin", "file-format"],
    "recon-dos": ["attempted-recon", "attempted-dos", "denial-of-service", "successful-recon-limited",
                  "successful-recon-fileserver", "rpc-portmap-decode", "scan", "snoopy-attack"],
    "policy-info": ["policy", "policy-violation", "misc-activity", "bad-unknown", "unknown",
                    "social-engineering", "targeted-activity", "protocol-command-decode",
                    "web-application-activity", "external-ip-check", "not-suspicious",
                    "suspicious-filename-detect", "suspicious-login", "non-standard-protocol",
                    "default-login-attempt", "inappropriate-content", "tcp-connection", "udp-connection"],
}
CT2CAT = {}
for cat, cts in CAT_MAP.items():
    for ct in cts:
        CT2CAT[ct] = cat
CAT_DESC = {
    "malware-cnc": "Вредоносное ПО, C&C-каналы, C2-домены, кража учётных данных, криптомайнеры",
    "exploits-web": "Эксплуатация уязвимостей, веб-атаки, exploit-kit'ы, шеллкоды",
    "recon-dos": "Сканирование, разведка, DoS/DDoS",
    "policy-info": "Политики, информационные события, фишинг/социальная инженерия, прочая активность",
    "ip-feeds": "Динамические IP-фиды: Blocklist.de, CINS Army, Spamhaus DROP, Feodo Tracker",
}

def rule_cat(r):
    if r["source"] in FEED_SOURCES:
        return "ip-feeds"
    return CT2CAT.get(r["classtype"], "policy-info")

for r in rules:
    r["cat"] = rule_cat(r)

# ── 2.5 Контроль целостности: отбрасываем структурно битые правила ──────────
malformed = [r for r in rules if not balanced(r["raw"]) or not RULE_RE.match(r["raw"]) or r["sid"] is None]
rules = [r for r in rules if balanced(r["raw"]) and RULE_RE.match(r["raw"]) and r["sid"] is not None]
sys.stderr.write(f"После контроля целостности: {len(rules)} правил (исключено битых: {len(malformed)})\n")
for r in malformed:
    sys.stderr.write(f"  битое: [{r['source']}] {r['raw'][:80]}...\n")

# ── 3. Строгий Suricata-фильтр ───────────────────────────────────────────────
def suricata_strict(r):
    return not SNORT3_ONLY.search(r["raw"]) and balanced(r["raw"])

# ── 4. Формирование наборов ──────────────────────────────────────────────────
def header(purpose, items, extra=""):
    n = len(items)
    srcs = sorted({r["source"] for r in items})
    h = [
        "# ─────────────────────────────────────────────────────────────",
        f"# Clear NDR: {purpose}",
        f"# Сгенерировано: {datetime.datetime.now().isoformat(timespec='seconds')}",
        f"# Правил: {n}",
        f"# Источники: {', '.join(srcs) if srcs else '-'}",
    ]
    if extra:
        h.append(f"# Примечание: {extra}")
    h.append("# Переменные $HOME_NET / $EXTERNAL_NET должны быть определены в конфигурации Clear NDR")
    h.append("# ─────────────────────────────────────────────────────────────")
    h.append("")
    return "\n".join(h) + "\n"

def write_file(path, purpose, items, extra=""):
    with open(path, "w", encoding="utf-8") as f:
        f.write(header(purpose, items, extra))
        last = None
        for r in items:
            if r["source"] != last:
                f.write(f"# [{r['source']}]\n")
                last = r["source"]
            f.write(r["raw"] + "\n")
    return len(items)

created = OrderedDict()

# 4.1 Полный набор — как есть
created["clearndr-full-%s.rules" % DATE] = ("Полный объединённый набор (все источники)", rules)

# 4.2 Строгий starter: SSLBL + Phishing + фиды + малые источники + ET Open malware/exploit
starter_sources_full = {"Abuse.ch SSL Blacklist (SSL certificates)", "Phishing Army (антифишинг)",
                        "Positive Technologies Attack Detection Team", "Quadrant Suricata Ruleset",
                        "Suricata Traffic ID Ruleset (OISF)"} | FEED_SOURCES
STARTER_CT = {"trojan-activity", "command-and-control", "exploit-kit", "credential-theft",
              "coin-mining", "shellcode-detect", "botnet", "malware"}
starter = []
for r in rules:
    if r["source"] in starter_sources_full:
        starter.append(r)
    elif r["source"] == "ET Open Ruleset (Emerging Threats)" and r["classtype"] in STARTER_CT and suricata_strict(r):
        starter.append(r)
created["clearndr-starter-%s.rules" % DATE] = (
    "Рекомендуемый стартовый набор (строгая Suricata-совместимость)",
    starter,
    "без правил со Snort 3-специфичным синтаксисом; Snort Registered Ruleset входит в полный файл")

# 4.3 Smoke: по 4 правила из каждого крупного источника + все фиды
smoke = []
per = defaultdict(int)
for r in rules:
    if r["source"] in FEED_SOURCES:
        smoke.append(r); per[r["source"]] += 1
for r in rules:
    if r["source"] not in FEED_SOURCES and per[r["source"]] < 4 and suricata_strict(r):
        smoke.append(r); per[r["source"]] += 1
created["clearndr-smoke-%s.rules" % DATE] = (
    "Быстрая проверка импорта (по несколько правил из каждого источника)", smoke)

# 4.4 По категориям
by_cat = defaultdict(list)
for r in rules:
    by_cat[r["cat"]].append(r)
for cat, items in sorted(by_cat.items()):
    created["by-category/clearndr-cat-%s-%s.rules" % (cat, DATE)] = (
        "Категория: %s — %s" % (cat, CAT_DESC.get(cat, "")), items)

# 4.5 По источникам
SLUG = {
    "ET Open Ruleset (Emerging Threats)": "et-open",
    "Snort Registered Ruleset (Snort 3, snapshot-3200)": "snort-registered-snort3",
    "[локальный архив] snortrules-snapshot-3200.tar.gz": "snort-snapshot-3200-local",
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
    created["by-source/clearndr-src-%s-%s.rules" % (slug, DATE)] = ("Источник: %s" % src, items)

# ── 5. Валидация и запись ────────────────────────────────────────────────────
stats = []
fail = False
for rel, spec in created.items():
    purpose, items = spec[0], spec[1]
    extra = spec[2] if len(spec) > 2 else ""
    sids = set()
    dup = 0
    bad_struct = 0
    for r in items:
        if not RULE_RE.match(r["raw"]) or not balanced(r["raw"]):
            bad_struct += 1
        if r["sid"] is not None:
            if r["sid"] in sids:
                dup += 1
            sids.add(r["sid"])
    path = os.path.join(OUT, rel)
    n = write_file(path, purpose, items, extra)
    ok = dup == 0 and bad_struct == 0 and n == len(items)
    if not ok:
        fail = True
        # диагностика: первые проблемные правила
        seen = set()
        shown = 0
        for r in items:
            if shown >= 3:
                break
            if (not RULE_RE.match(r["raw"]) or not balanced(r["raw"])) and shown < 3:
                print(f"  BAD-STRUCT [{rel}]: {r['raw'][:160]}", flush=True)
                shown += 1
            elif r["sid"] is not None and r["sid"] in seen and shown < 3:
                print(f"  DUP-SID [{rel}]: sid={r['sid']} src={r['source']}: {r['raw'][:120]}", flush=True)
                shown += 1
            seen.add(r["sid"] if r["sid"] is not None else -1)
    stats.append((rel, n, dup, bad_struct, ok))
    print(f"{'OK ' if ok else 'FAIL'} {rel}: правил={n}, дубликатов SID={dup}, битых={bad_struct}", flush=True)

if fail:
    sys.exit("ВАЛИДАЦИЯ НЕ ПРОЙДЕНА")

# ── 6. README + SHA256 ───────────────────────────────────────────────────────
def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

sums = []
for rel, *_ in created.items():
    digest = sha256(os.path.join(OUT, rel))
    sums.append(f"{digest}  {rel}")

readme = f"""# Итоговые наборы правил для Clear NDR — пакет для тестирования

Дата сборки: {datetime.date.today().isoformat()}
Полная сборка: {len(rules):,} уникальных правил из {len(by_src)} источников (дедупликация по SID и содержимому выполнена сервисом).

## Контроль качества перед выпуском

- Все правила прошли структурную валидацию: закрытые кавычки и скобки, наличие `sid`, уникальность SID внутри каждого файла.
- Исключены 2 правила ET Open с некорректным синтаксисом в оригинале (sid:2029732 — неэкранированная кавычка в pcre; sid:2052831 — лишняя скобка): движок Suricata отверг бы их при загрузке.
- Исправлен дефект обрезки длинных правил (лимит 8000 символов в сервисе): правила Spamhaus DROP (до 8.2 КБ) теперь полные.
- Правила Snort 3 со специфичным синтаксисом (`bufferlen`, `byte_math`, `http_header:field`…) оставлены только в full/by-* файлах (~1200 шт.); движок Suricata пропустит их с записью в лог — это штатно. В starter они отфильтрованы.

## Состав пакета

| Файл | Правил | Назначение |
|---|---|---|
"""
for rel, n, dup, bad, ok in stats:
    purpose = created[rel][0]
    readme += f"| `{rel}` | {n:,} | {purpose} |\n"

readme += """
## Рекомендуемый порядок тестирования на реальном Clear NDR

1. **smoke** — импортируйте `clearndr-smoke-*.rules` (~124 правила): проверка, что импорт проходит, ошибки парсинга отсутствуют.
2. **starter** — импортируйте `clearndr-starter-*.rules` (~{starter_n:,} правил): строгая Suricata-совместимость, высокий сигнал (C&C, малварь, exploit-kit'ы, фишинг, IP-фиды). Основной файл для пилота.
3. **by-category** — подключайте категории выборочно в зависимости от профиля сети.
4. **full** — полный набор. Часть правил Snort 3 (~1%) использует синтаксис, которого нет в Suricata (`bufferlen`, `byte_math`, `http_header:field`…): движок пропустит эти правила с сообщением в логе — это штатное поведение, остальные правила загрузятся.

## Как импортировать в Clear NDR

1. UI Clear NDR → **Sources** → **Import** → загрузить выбранный `.rules` файл (replace).
2. Убедитесь, что переменные `$HOME_NET` / `$EXTERNAL_NET` определены в конфигурации (стандартные значения Suricata подходят: `HOME_NET: [192.168.0.0/16,10.0.0.0/8,172.16.0.0/12]`).
3. Перезагрузите правила (Rules → Reload / перезапуск сенсора) и проверьте лог загрузки: количество загруженных правил должно совпадать с числом в таблице (минус единичные несовместимые в full).

## Автоматическое обновление

Сервис (Docker-контейнер этого проекта) ежедневно обновляет источники, выполняет дедупликацию
и экспортирует свежий файл: вручную через Web UI → Build, или автоматически (cron) в каталог
Clear NDR / по HTTP. Файл этого же формата генерирует `GET /api/export` работающего сервиса.

## Проверка целостности

`SHA256SUMS.txt` содержит контрольные суммы всех файлов. Проверка: `sha256sum -c SHA256SUMS.txt`
""".format(starter_n=len(starter))

with open(os.path.join(OUT, "README-IMPORT.md"), "w", encoding="utf-8") as f:
    f.write(readme)
with open(os.path.join(OUT, "SHA256SUMS.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(sums) + "\n")

# ── 7. Zip ───────────────────────────────────────────────────────────────────
zip_path = f"/home/z/my-project/download/clearndr-rules-{DATE}.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for rel in list(created) + ["README-IMPORT.md", "SHA256SUMS.txt"]:
        z.write(os.path.join(OUT, rel), arcname=f"clearndr-rules-{DATE}/{rel}")

print("\nАрхив:", zip_path, os.path.getsize(zip_path), "байт")
print("Готово.")
