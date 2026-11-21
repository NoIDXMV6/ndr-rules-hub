#!/usr/bin/env python3
"""Pack all NDR&DNS Rules HUB diagrams into one archive in download/."""
import json
import zipfile
from pathlib import Path

ROOT = Path("/home/z/my-project")
OUT = ROOT / "download/ndr-hub-diagrams-v1.40.0-20261121.zip"
OUT.parent.mkdir(parents=True, exist_ok=True)

GROUPS = [
    ("PlantUML — C4/sequence, исходники и PNG-рендеры (docs/diagrams)", "docs/diagrams", [
        "docs/diagrams/c1-context.puml", "docs/diagrams/c1-context.png",
        "docs/diagrams/c2-containers.puml", "docs/diagrams/c2-containers.png",
        "docs/diagrams/c3-security.puml", "docs/diagrams/c3-security.png",
        "docs/diagrams/seq-download-flow.puml", "docs/diagrams/seq-download.png",
        "docs/diagrams/seq-login-bruteforce.puml", "docs/diagrams/seq-login-bruteforce.png",
        "docs/diagrams/seq-registration-verification.puml", "docs/diagrams/seq-registration.png",
    ]),
    ("Mermaid — standalone .mmd и PNG-рендеры всех 32 схем (docs/diagrams/mermaid)", "docs/diagrams/mermaid", None),  # все файлы каталога
    ("Archify — отрендеренные интерактивные схемы, 8 standalone HTML (docs/diagrams/interactive)", "docs/diagrams/interactive", None),
    ("Clear NDR — схемы интеграции/обновления для UI-справки (public/diagrams)", "public/diagrams", None),
    ("Archify — блюпринты интерактивных схем (8 шт., .archify/*/candidate.json)", ".archify", None),
    ("Archify — отрендеренный HTML workflow (examples)", "examples", [
        "examples/workflow-agent-tool-call-rendered.html",
    ]),
]

README_TEXT = """\
# Диаграммы NDR&DNS Rules HUB — v1.40.0 (срез 2026-11-21)

Единый архив всех схем системы. Полностью синхронизирован с веткой main
(GitHub: NoIDXMV6/ndr-rules-hub, GitVerse: noid/ndr-hub, коммит d7bf31c).

## Состав

1. docs/diagrams/*.puml + *.png — PlantUML:
   - c1-context — C1 контекст (Hub и окружение);
   - c2-containers — C2 контейнеры (компоненты и БД);
   - c3-security — C3 слой безопасности (src/lib/security);
   - seq-download — скачивание правил Clear NDR через /api/export;
   - seq-login-bruteforce — вход и защита от перебора;
   - seq-registration — регистрация и верификация (Enterprise).

2. docs/diagrams/mermaid/*.mmd + *.png — 32 standalone mermaid-схемы (RU+EN),
   извлечённые из architecture.md / architecture.en.md / README / clearndr-доков.
   Имя файла: <документ>-<номер блока>-<заголовок раздела>.mmd|.png.
   registry.json — связь каждого .mmd с файлом-источником и заголовком.
   Ключевые схемы:
   - architecture-04-8-1-proverka-zhivosti-domenov-v1-37-0 — живость доменов
     (делегирование): DomainRecord → dns-alive.ts (батчи, пул 50 DNS, NS/A/AAAA/CNAME)
     → DomainAlive (alive/dead/error) → исключение dead при следующей сборке
     (droppedDead) → blocked-domains.txt;
   - architecture-02 — конвейер обработки правил; architecture-03 — конвейер качества;
   - architecture-01 — компонентная схема; architecture-07 — жизненный цикл запроса;
   - architecture-08..10 / clearndr-integration / clearndr-update — интеграция Clear NDR
     (PULL/PUSH, автообновление); architecture-05/06 — WireGuard up/down.

3. docs/diagrams/interactive/*.html — 8 отрендеренных интерактивных схем (archify,
   standalone HTML, тёмная/светлая тема, экспорт PNG/SVG/WebP, открываются без сервера):
   dns-alive-workflow (живость доменов), component-map, dns-domain-pipeline,
   rules-pipeline, rules-quality-gates, clearndr-delivery, request-lifecycle, cron-cycle.
   Блюпринты-исходники этих схем — в п. 5 (.archify/*/candidate.json).

4. public/diagrams/*.png — схемы Clear NDR (PULL/PUSH/автообновление, RU+EN),
   используемые справкой UI.

5. .archify/*/candidate.json — блюпринты интерактивных схем (archify):
   architecture-components, dataflow-dns-pipeline, dataflow-rules,
   sequence-clearndr, sequence-request, workflow-cron, workflow-dns-alive,
   workflow-quality (срез 2026-11-21).

6. examples/workflow-agent-tool-call-rendered.html — отрендеренный интерактивный
   workflow (standalone HTML).

## Как перегенерировать

- Извлечение .mmd из markdown: python3 scripts/extract-mermaid.py
- PNG-рендеры: python3 scripts/render-mermaid.py [фильтры по имени]
"""


def main() -> int:
    plan: list[tuple[str, Path]] = []  # (arcname, abs_path)
    for label, base, files in GROUPS:
        if files:
            for rel in files:
                p = ROOT / rel
                if not p.exists():
                    print(f"MISSING: {rel}")
                    return 1
                plan.append((rel, p))
        else:
            for p in sorted((ROOT / base).rglob("*")):
                if p.is_file() and "__pycache__" not in p.parts:
                    plan.append((str(p.relative_to(ROOT)), p))

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("diagrams/README.md", README_TEXT)
        for arc, p in plan:
            z.write(p, f"diagrams/{arc}")
        bad = z.testzip()
        if bad:
            print(f"CORRUPT ENTRY: {bad}")
            return 1

    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
        infos = z.infolist()
        total_uncompressed = sum(i.file_size for i in infos)
    print(f"Archive: {OUT}")
    print(f"Size: {OUT.stat().st_size / 1024 / 1024:.1f} MB (uncompressed {total_uncompressed / 1024 / 1024:.1f} MB)")
    print(f"Entries: {len(names)}")
    groups_count = {
        "puml": sum(1 for n in names if n.endswith(".puml")),
        "mmd": sum(1 for n in names if n.endswith(".mmd")),
        "png": sum(1 for n in names if n.endswith(".png")),
        "json_archify": sum(1 for n in names if n.endswith(".json") and "archify" in n),
        "html": sum(1 for n in names if n.endswith(".html")),
    }
    print("By type:", json.dumps(groups_count, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
