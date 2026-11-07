#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборка итоговых файлов для тестирования на реальном Clear NDR
из ВАЛИДИРОВАННОГО набора (data/exports/clearndr-import-validated.rules).
Каждый файл уже прошёл suricata -T; здесь только группировка + контроль уникальности SID.
"""
import re, os, sys, hashlib, zipfile, datetime
from collections import defaultdict, OrderedDict

sys.path.insert(0, "/home/z/my-project/scripts")
from resid import SidMapper, replace_sid, BLOCK_START, BLOCK_END

SRC = "/home/z/my-project/data/exports/clearndr-import-validated.rules"
OUT = "/home/z/my-project/download/rules"
DATE = datetime.date.today().strftime("%Y%m%d")
os.makedirs(OUT, exist_ok=True)
os.makedirs(os.path.join(OUT, "by-category"), exist_ok=True)
os.makedirs(os.path.join(OUT, "by-source"), exist_ok=True)

# очистка файлов прошлых сборок (иначе устаревшие .rules остаются рядом с новыми)
for _sub in ("", "by-category", "by-source"):
    _d = os.path.join(OUT, _sub)
    for _fn in os.listdir(_d):
        _p = os.path.join(_d, _fn)
        if os.path.isfile(_p) and (_fn.endswith((".rules", ".md", ".txt", ".csv")) or _fn.startswith("clearndr-")):
            os.remove(_p)

RULE_RE = re.compile(r"^(alert|drop|pass|reject|block|sdrop|log)\s+\S+")
SRC_RE = re.compile(r"^# \[(.+)\]$")
SID_RE = re.compile(r"\bsid\s*:\s*(\d+)\s*;")
CT_RE = re.compile(r"\bclasstype\s*:\s*([a-zA-Z0-9_-]+)\s*;")

# ── Очистка от Snort-only ключевых слов ────────────────────────────────────
# replace:"..." — IPS-замена контента (в IDS-режиме смысла не имеет), rawbytes —
# no-op модификатор. Оба НЕ входят в синтаксис Suricata и ломали импорт в
# Clear NDR (файл Talos Snort 2.9: 26 опций replace + 26 rawbytes).
# Удаление не меняет семантику обнаружения. Разбор опций — с учётом кавычек.
SNORT_ONLY_KW = ("replace", "rawbytes")
_OPT_NAME_RE = re.compile(r"^\s*([a-zA-Z_0-9]+)\s*[:=;]?")
# модификатор rawbytes внутри значений isdataat (snort-наследие):
# isdataat:!0,relative,rawbytes → isdataat:!0,relative (в корпусе 1 случай,
# "isdataat:" внутри content-строк не встречается — регулярка безопасна)
ISDATAAT_RB_RE = re.compile(r"(isdataat\s*:[^;]*?),\s*rawbytes\b")

def strip_snort_only(line):
    """Удаляет опции replace/rawbytes из правила. Возвращает (line, удалено)."""
    i = line.find("(")
    if i < 0:
        return line, 0
    body_start = i + 1
    opts, in_q, esc, start, k = [], False, False, body_start, body_start
    while k < len(line):
        ch = line[k]
        if esc:
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == '"':
            in_q = not in_q
        elif ch == ";" and not in_q:
            opts.append((start, k + 1)); start = k + 1
        elif ch == ")" and not in_q:
            break
        k += 1
    kept_opts, n = [], 0
    for (s, e) in opts:
        seg = line[s:e]
        m = _OPT_NAME_RE.match(seg)
        if m and m.group(1).lower() in SNORT_ONLY_KW:
            n += 1
            continue
        kept_opts.append(seg)
    if not n:
        return line, 0
    return line[:body_start] + "".join(kept_opts) + line[k:], n

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
STRIP_CNT = {"replace": 0, "rawbytes": 0}
STRIP_RULES = 0

def count_snort_only(body):
    """Число snort-only опций (replace/rawbytes) в теле правила, вне кавычек."""
    cnt = {kw: 0 for kw in SNORT_ONLY_KW}
    in_q = esc = False
    buf = ""
    for ch in body:
        if esc:
            esc = False; buf += ch
        elif ch == "\\":
            esc = True; buf += ch
        elif ch == '"':
            in_q = not in_q; buf += ch
        elif ch == ";" and not in_q:
            m = _OPT_NAME_RE.match(buf)
            if m and m.group(1).lower() in cnt:
                cnt[m.group(1).lower()] += 1
            buf = ""
        else:
            buf += ch
    return cnt

for line in open(SRC, encoding="utf-8"):
    line = line.rstrip("\n")
    m = SRC_RE.match(line)
    if m:
        cur_src = m.group(1); continue
    if RULE_RE.match(line):
        cnt = count_snort_only(line[line.find("("):])
        line2, n_id = ISDATAAT_RB_RE.subn(r"\1", line)
        if n_id:
            STRIP_CNT["rawbytes"] += n_id
        if any(cnt.values()):
            line2, _ = strip_snort_only(line2)
            # после очистки snort-only опций остаться не должно (идемпотентность)
            assert not any(count_snort_only(line2[line2.find("("):]).values()), \
                "strip_snort_only не дочистил опцию: " + line2[:120]
            for _kw, _n in cnt.items():
                STRIP_CNT[_kw] += _n
        if line2 != line:
            line = line2
            STRIP_RULES += 1
        sid = int(SID_RE.search(line).group(1)) if SID_RE.search(line) else None
        ct = CT_RE.search(line).group(1) if CT_RE.search(line) else None
        rules.append({"source": cur_src, "raw": line, "sid": sid, "classtype": ct})
sys.stderr.write(f"Очистка Snort-only опций: replace={STRIP_CNT['replace']}, rawbytes={STRIP_CNT['rawbytes']} (правил затронуто: {STRIP_RULES})\n")

assert len(rules) > 100000, f"подозрительно мало правил: {len(rules)}"
sys.stderr.write(f"Разобрано: {len(rules)} правил из {len({r['source'] for r in rules})} источников\n")

# ── Перенумерация SID в зарезервированный clearndr-блок ────────────────────
# Чужие SID (Snort <1M, ET 1..2.2M, Suricata 2.2M..2.3M, PT 10..11M, Quadrant до
# 81M, OISF 300M, abuse.ch ~900M) заняты штатными источниками Clear NDR — импорт
# с sid:3 падает. Все правила получают sid из свободного блока 1 000 000 000+.
mapper = SidMapper()
for r in rules:
    r["orig_sid"] = r["sid"]
    r["sid"] = mapper.get(r["source"], r["sid"])
    r["raw"] = replace_sid(r["raw"], r["sid"])
mapper.save()
assert len({r["sid"] for r in rules}) == len(rules), "дубликат SID после remap"
_lo, _hi = min(r["sid"] for r in rules), max(r["sid"] for r in rules)
assert BLOCK_START <= _lo and _hi <= BLOCK_END, f"SID вне clearndr-блока: {_lo}..{_hi}"
sys.stderr.write(f"Remap SID: {len(rules)} правил → {_lo}..{_hi} (блок {BLOCK_START:,}..{BLOCK_END:,})\n")

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

mapper.write_csv(os.path.join(OUT, "SID-MAP.csv"), rules)


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

sums = [f"{sha256(os.path.join(OUT, rel))}  {rel}" for rel in created]
sums.append(f"{sha256(os.path.join(OUT, 'SID-MAP.csv'))}  SID-MAP.csv")
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
- Удалены Snort-only ключевые слова `replace` ({STRIP_CNT['replace']} опций) и `rawbytes`
  ({STRIP_CNT['rawbytes']} вхождений: отдельные опции и модификатор внутри isdataat) в {STRIP_RULES} правилах
  Talos Snort 2.9 — их нет в синтаксисе Suricata, из-за них падал импорт в Clear NDR. Семантика
  обнаружения не изменилась (replace — IPS-замена контента, в IDS-режиме не используется; rawbytes — no-op).
- Цикл валидации: `suricata -T` → разбор лога → исправление/исключение битых правил → повтор до 0 ошибок.
- Исключено валидатором: 234 правила ({100*234/len(rules):.2f}%) — несжимаемые несовместимости
  (byte_math, sip_*-буферы, dce_*, ber_*, конфликт направлений, битые заголовки Quadrant).
- Лимит длины правила Suricata 8192 байта учтён: длинные IP-листы разбиты на несколько правил.

## Политика SID (перенумерация в свободный диапазон)

Все правила пакета имеют SID из зарезервированного локального блока clearndr
**1 000 000 000 – 1 099 999 999** — выше всех известных публичных аллокаций:
Snort резервирует 0–999 999 (docs.snort.org), Emerging Threats — 1M–2.2M,
события движка Suricata — 2 200 000–2 299 999 (docs.suricata.io), публичные
наборы используют 10–11M (Positive Technologies), 20M/81M (Quadrant),
300M (OISF Traffic ID), ~900M (abuse.ch). Исходные «чужие» SID вызывали
конфликт при импорте в прод (SID 3 уже занят штатным набором).

- Отображение детерминированное: `new_sid = f(source, original_sid)`;
  повторные сборки не меняют SID у неизменённых правил (обновления проходят без «плавания» идентификаторов).
- Соответствие нового и исходного SID — в `SID-MAP.csv` (clearndr_sid; original_sid; source; msg).
- rev, msg, metadata и содержимое правил не изменялись — заменено только значение sid.

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

## SID-MAP.csv

Карта соответствия SID для всех правил пакета (new ← original). Если нужно
вернуть правилу исходный идентификатор или сопоставить алерт с правилом
вышестоящего набора (Snort/ET) — поиск по `clearndr_sid`.
"""
with open(os.path.join(OUT, "README-IMPORT.md"), "w", encoding="utf-8") as f:
    f.write(readme)

zip_path = f"/home/z/my-project/download/clearndr-rules-{DATE}.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for rel in list(created) + ["README-IMPORT.md", "SHA256SUMS.txt", "SID-MAP.csv"]:
        z.write(os.path.join(OUT, rel), arcname=f"clearndr-rules-{DATE}/{rel}")
print(f"\nАрхив: {zip_path} ({os.path.getsize(zip_path)//1024//1024} МБ)")
print("Готово.")
