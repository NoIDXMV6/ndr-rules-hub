#!/usr/bin/env python3
"""Generate release notes md for missing releases from git commit messages."""
import subprocess
from pathlib import Path

ROOT = Path("/home/z/my-project")
OUT = ROOT / "scripts/release-notes"
OUT.mkdir(parents=True, exist_ok=True)

TAGS = ["v1.38.0", "v1.39.0", "v1.40.0"]


def commit_message(tag: str) -> str:
    r = subprocess.run(["git", "log", "--format=%B", f"{tag}^{{commit}}", "-1"],
                       capture_output=True, text=True, check=True, cwd=ROOT)
    return r.stdout.strip()


def to_notes(tag: str, msg: str) -> str:
    lines = msg.splitlines()
    # Первая строка "v1.40.0: текст" -> заголовок "## v1.40.0 — текст"
    first = lines[0].strip()
    if first.lower().startswith(tag.lower()):
        rest = first[len(tag):].lstrip(" :—-")
        head = f"## {tag} — {rest}"
        lines = lines[1:]
    else:
        head = f"## {tag}"
    body = "\n".join(lines).strip()
    # Сверхдлинные однострочные абзацы оставить как есть — GitHub отрендерит.
    return f"{head}\n\n{body}\n"


for tag in TAGS:
    path = OUT / f"{tag}.md"
    if path.exists():
        print(f"SKIP (exists): {path.name}")
        continue
    notes = to_notes(tag, commit_message(tag))
    path.write_text(notes, encoding="utf-8")
    print(f"OK {path.name}: {len(notes)} chars, head: {notes.splitlines()[0][:90]}")
