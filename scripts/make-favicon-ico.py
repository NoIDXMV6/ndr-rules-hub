#!/usr/bin/env python3
"""Собрать public/favicon.ico из PNG-слайдов (scripts/make-favicon.mjs).

Формат ICO с PNG-записями (Vista+): заголовок 6 байт, по 16 байт на запись,
далее блобы PNG. Проверка — PIL открывает все размеры.
"""
import struct
import sys
from pathlib import Path

SRC = Path('/tmp/favicon-png')
DST = Path(__file__).resolve().parent.parent / 'public' / 'favicon.ico'
SIZES = [16, 32, 48, 64, 128, 256]

pngs = []
for s in SIZES:
    p = SRC / f'icon-{s}.png'
    data = p.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', f'{p}: не PNG'
    pngs.append((s, data))

header = struct.pack('<HHH', 0, 1, len(pngs))
entries = b''
offset = 6 + 16 * len(pngs)
blobs = b''
for s, data in pngs:
    w = h = 0 if s >= 256 else s  # 0 означает 256
    entries += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
    blobs += data

DST.write_bytes(header + entries + blobs)
print(f'ok {DST} ({DST.stat().st_size} байт)')

# самопроверка: PIL должен прочитать все размеры
from PIL import Image  # noqa: E402
ico = Image.open(DST)
sizes = sorted(ico.info.get('sizes') or ())
print('PIL sizes:', sizes)
assert ico.format == 'ICO', ico.format
print('OK')
