#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка v1.4.0: пакеты с sid-first (фикс «conflicting SID (33)»).

- clearndr-rules-20261107-sidfirst.zip: 21 .rules (sid-first) + SID-MAP.csv + SHA256SUMS.txt + README-IMPORT.md
- clearndr-snort2-import-kit-20261108-v3.zip: 10 кусков (sid-first) + SHA256SUMS-v3.txt + README-IMPORT-KIT-v3.md
"""
import hashlib, os, zipfile, glob

BASE = "/home/z/my-project"


def sha256(p: str) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def zip_dir(zf: zipfile.ZipFile, src_dir: str, arc_root: str, skip=()):
    for root, _, files in os.walk(src_dir):
        for fn in sorted(files):
            p = os.path.join(root, fn)
            arc = os.path.join(arc_root, os.path.relpath(p, src_dir))
            zf.write(p, arc)


README_RULES = """# Итоговые наборы правил для Clear NDR — sid-first пакет (v1.4.0)

Дата сборки: 2026-11-08. Полная сборка: 113,832 уникальных правила из 13 источников.

## Что нового в v1.4.0 — исправление «conflicting SID (33)»

Clear NDR (Scirius) извлекает SID правила регэкспом `sid *: * (\\d+)` — ПЕРВОЕ
совпадение в строке. В правилах Talos BROWSER-IE / BROWSER-PLUGINS внутри
`content:"clsid:33FD63B1-..."` есть подстрока `sid:33...` (cl**sid:**33FD...):
GUID из контента принимается за SID правила. У HTTP- и SMTP-вариантов таких
правил ложный SID совпадает (33, 3, 8, 18, 52, 67, 83863, 7849596, ...), и
Scirius прерывает импорт: `The source contains conflicting SID (33) in same
source` — с каким бы числом правил ни импортировался файл.

Исправление: во всех правилах пакета опция `sid:...;` перенесена в начало
списка опций (порядок опций в Snort/Suricata свободный, семантика правила
не меняется). Первое совпадение регэкспа — теперь настоящий SID из блока
1 000 000 000+. Контент, msg, rev, classtype не менялись; SID-MAP.csv
остаётся валидным.

Проверка на живом Scirius (движок правил Clear NDR, код `rules/models.py`):
все 21 файл пакета и все 10 кусков импорт-набора импортируются без ошибок
(113,832 / 45,985 правил соответственно). До исправления те же файлы падали
с ошибкой `conflicting SID (33)` — воспроизведено и устранено.

## Контроль качества (наследие v1.2/v1.3)

- Дедупликация по SID (приоритет более высокого rev) и по содержимому:
  удалено 11 правил-близнецов Talos (7 пар Snort 2.9 + 4 кросс-дубликата
  Snort 2 ↔ Snort 3), потеря детекта — ноль.
- Правила Snort 2/3 конвертированы в Suricata 7 (s2x: sticky-буферы, inline-
  модификаторы, bufferlen→bsize); удалены Snort-only `replace`/`rawbytes`.
- Полный цикл `suricata -T` до 0 ошибок; исключено валидатором 234 правила
  (0.21%) с несжимаемыми несовместимостями (byte_math, sip_*, dce_*, ber_*).
- Лимит длины правила 8192 байта учтён.

## Политика SID (перенумерация в свободный диапазон)

Все правила имеют SID из блока **1 000 000 000 – 1 099 999 999**, выше всех
публичных аллокаций. Отображение детерминированное: `new_sid = f(source,
original_sid)`; соответствие — в `SID-MAP.csv` (clearndr_sid; original_sid;
source; msg). rev, msg, metadata и содержимое правил не изменялись.

## Состав пакета

- `clearndr-full-20261107.rules` — все правила одним файлом (113,832);
- `clearndr-starter-20261107.rules` — стартовый набор (53,673);
- `clearndr-smoke-20261107.rules` — контрольный дымовой набор (123);
- `by-source/` — 13 файлов по источникам (Talos Snort 2.9: 45,985);
- `by-category/` — 5 файлов по категориям;
- `SID-MAP.csv`, `SHA256SUMS.txt`, `README-IMPORT.md`.

## Импорт в Clear NDR

1. Один файл = **один новый** источник («Sources» → Add source → Upload,
   Individual Signatures file). Не импортируйте файл повторно в источник,
   где его правила уже есть, и не смешивайте файлы, содержащие одни и те же
   правила (full ∩ by-source ∩ by-category = 100%).
2. Целостность: `sha256sum -c SHA256SUMS.txt`.
3. Импорт Talos Snort 2.9 по частям — использовать
   `clearndr-snort2-import-kit-20261108-v3.zip` (10 кусков ≤4,600 правил).
"""

README_KIT = """# Импорт-набор v3: Talos Snort 2.9 → Clear NDR (sid-first, 10 кусков)

Дата: 2026-11-08. Заменяет v2. Правил: 45,985 (10 кусков ≤4,600, ≤3,4 МБ).

## Причина всех падений импорта (финальный диагноз, воспроизведён на живом Scirius)

Scirius (движок правил Clear NDR) берёт SID регэкспом `sid *: *(\\d+)` — первое
совпадение в строке. В правилах Talos BROWSER-IE / BROWSER-PLUGINS контент
`content:"clsid:33FD63B1-..."` содержит подстроку `sid:33...`, GUID принимается
за SID. У пар HTTP/SMTP-вариантов ложный SID совпадает →
`The source contains conflicting SID (33) in same source`. Отсюда же все
странности бисекции: любой файл, содержащий оба BROWSER-правила одного
clsid, падал; «по одному импортируется» — потому что в коротких срезах
пары не встречались.

В v3 во всех правилах `sid:...;` перенесён в начало опций (порядок опций
свободный, семантика не меняется). Первое совпадение регэкспа — настоящий
SID из блока 1 000 000 000+. Проверено импортом в живой Scirius: все 10
кусков импортируются без ошибок.

Наследие v2 (остаётся в силе): из набора удалены 7 пар правил-дубликатов
Talos и 4 кросс-дубликата Snort 2 ↔ Snort 3 (45,992 → 45,985).

## Протокол импорта

1. **Один кусок = один НОВЫЙ источник** Clear NDR (`talos2-kit-01` … `talos2-kit-10`).
   Не импортировать повторно в непустой источник.
2. Не смешивать куски с другими файлами пакета (full/by-source содержат
   те же правила).
3. Целостность: `sha256sum -c SHA256SUMS-v3.txt`.
"""


def build_package():
    out = os.path.join(BASE, "dist", "clearndr-rules-20261107-sidfirst.zip")
    src_root = os.path.join(BASE, "download", "rules-v14")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        root = "clearndr-rules-20261107"
        for p in sorted(glob.glob(os.path.join(src_root, "**", "*.rules"), recursive=True)):
            zf.write(p, os.path.join(root, os.path.relpath(p, src_root)))
        zf.write(os.path.join(BASE, "download", "rules", "SID-MAP.csv"), os.path.join(root, "SID-MAP.csv"))
        # SHA256SUMS по фактическим файлам архива
        lines = []
        for p in sorted(glob.glob(os.path.join(src_root, "**", "*.rules"), recursive=True)):
            lines.append(f"{sha256(p)}  {os.path.relpath(p, src_root)}")
        zf.writestr(os.path.join(root, "SHA256SUMS.txt"), "\n".join(lines) + "\n")
        zf.writestr(os.path.join(root, "README-IMPORT.md"), README_RULES)
    print("пакет:", out, f"{os.path.getsize(out):,}B")
    return out


def build_kit():
    out = os.path.join(BASE, "dist", "clearndr-snort2-import-kit-20261108-v3.zip")
    src_root = os.path.join(BASE, "download", "kit-v14")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        root = "clearndr-snort2-import-kit-v3"
        paths = sorted(glob.glob(os.path.join(src_root, "*.rules")))
        lines = []
        for p in paths:
            zf.write(p, os.path.join(root, os.path.basename(p)))
            lines.append(f"{sha256(p)}  {os.path.basename(p)}")
        zf.writestr(os.path.join(root, "SHA256SUMS-v3.txt"), "\n".join(lines) + "\n")
        zf.writestr(os.path.join(root, "README-IMPORT-KIT-v3.md"), README_KIT)
    print("кит:", out, f"{os.path.getsize(out):,}B")
    return out


if __name__ == "__main__":
    os.makedirs(os.path.join(BASE, "dist"), exist_ok=True)
    build_package()
    build_kit()
