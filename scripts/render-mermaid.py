#!/usr/bin/env python3
"""Render every .mmd in docs/diagrams/mermaid to PNG via mermaid.ink (natural size, trimmed margins)."""
import base64
import json
import sys
import time
import urllib.request
from io import BytesIO
from pathlib import Path

from PIL import Image

MERMAID_DIR = Path("/home/z/my-project/docs/diagrams/mermaid")
PNG_HEAD = b"\x89PNG"


def render(mmd_path: Path, scale: int) -> Image.Image:
    code = mmd_path.read_text(encoding="utf-8")
    payload = json.dumps({"code": code, "mermaid": {"theme": "default"}})
    b64 = base64.urlsafe_b64encode(payload.encode()).decode()
    url = f"https://mermaid.ink/img/{b64}?type=png&width=1600&scale={scale}"
    req = urllib.request.Request(url, headers={"User-Agent": "ndr-hub-diagrams/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return Image.open(BytesIO(resp.read()))


def trim(img: Image.Image, margin: int = 24) -> Image.Image:
    rgb = img.convert("RGB")
    bg = rgb.getpixel((2, 2))
    w, h = rgb.size
    px = rgb.load()
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if px[x, y] != bg:
                xs.append(x)
                ys.append(y)
    if not xs:
        return img
    box = (
        max(min(xs) - margin, 0),
        max(min(ys) - margin, 0),
        min(max(xs) + margin, w),
        min(max(ys) + margin, h),
    )
    return rgb.crop(box)


def main() -> int:
    filters = [a for a in sys.argv[1:] if a]
    mmds = sorted(MERMAID_DIR.glob("*.mmd"))
    if filters:
        mmds = [p for p in mmds if any(f in p.name for f in filters)]
    failed: list[str] = []
    for n, mmd in enumerate(mmds, 1):
        out = mmd.with_suffix(".png")
        ok = False
        for attempt, scale in enumerate((2, 2, 1, 1), 1):
            try:
                img = render(mmd, scale)
                if img.width < 10 or img.height < 10:
                    raise RuntimeError(f"bad image: {img.size}")
                final = trim(img)
                final.save(out, "PNG")
                print(f"[{n}/{len(mmds)}] OK  {out.name}  {final.width}x{final.height}  {out.stat().st_size//1024} KB")
                ok = True
                break
            except Exception as exc:  # noqa: BLE001
                print(f"[{n}/{len(mmds)}] attempt {attempt} FAILED {mmd.name}: {exc}")
                time.sleep(8 * attempt)
        if not ok:
            failed.append(mmd.name)
        time.sleep(0.4)
    print(f"\nDone: {len(mmds) - len(failed)}/{len(mmds)} rendered")
    if failed:
        print("FAILED:", *failed, sep="\n  ")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
