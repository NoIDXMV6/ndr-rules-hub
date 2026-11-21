#!/usr/bin/env python3
"""Extract all mermaid blocks from project docs into standalone .mmd files.

Output: docs/diagrams/mermaid/<doc>-<nn>-<slug>.mmd  (+ registry JSON for render step)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path("/home/z/my-project")
OUT = ROOT / "docs/diagrams/mermaid"
OUT.mkdir(parents=True, exist_ok=True)

# ASCII slug transliteration for Russian headings
TR = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}

DOCS = [
    ROOT / "architecture.md",
    ROOT / "architecture.en.md",
    ROOT / "README.md",
    ROOT / "README.en.md",
    ROOT / "docs/clearndr-update.md",
    ROOT / "docs/clearndr-update.en.md",
    ROOT / "docs/clearndr-integration.md",
    ROOT / "docs/clearndr-integration.en.md",
]


def slugify(text: str, limit: int = 48) -> str:
    text = text.strip().lower()
    out = []
    for ch in text:
        if ch in TR:
            out.append(TR[ch])
        elif ch.isascii() and (ch.isalnum() or ch in " -_"):
            out.append(ch.replace(" ", "-"))
        else:
            out.append("-")
    slug = re.sub(r"-+", "-", "".join(out)).strip("-")
    return slug[:limit].strip("-") or "diagram"


def main() -> int:
    registry = []
    for doc in DOCS:
        if not doc.exists():
            print(f"SKIP (missing): {doc}")
            continue
        src = doc.read_text(encoding="utf-8")
        stem = doc.stem if doc.stem not in ("README",) else "readme"
        # normalize doc label: architecture, architecture.en, clearndr-update(.en)...
        label = stem.lower().replace(".", "-")
        lines = src.splitlines()
        # find mermaid blocks
        i = 0
        idx = 0
        last_heading = ""
        while i < len(lines):
            line = lines[i]
            m = re.match(r"^(#{1,6})\s+(.*)$", line)
            if m:
                last_heading = m.group(2).strip()
            if re.match(r"^```mermaid\s*$", line):
                idx += 1
                body: list[str] = []
                i += 1
                while i < len(lines) and not re.match(r"^```\s*$", lines[i]):
                    body.append(lines[i])
                    i += 1
                if i >= len(lines):
                    print(f"ERROR: unterminated mermaid block in {doc.name} (#{idx})")
                    return 1
                name = f"{label}-{idx:02d}-{slugify(last_heading)}"
                (OUT / f"{name}.mmd").write_text("\n".join(body) + "\n", encoding="utf-8")
                registry.append({
                    "file": f"{name}.mmd",
                    "source": str(doc.relative_to(ROOT)),
                    "index": idx,
                    "heading": last_heading,
                    "lines": len(body),
                })
                print(f"OK {name}.mmd  <- {doc.name} block#{idx}  heading='{last_heading}'")
            i += 1
    (OUT / "registry.json").write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nTotal: {len(registry)} mermaid blocks -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
