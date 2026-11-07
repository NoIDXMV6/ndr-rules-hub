#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Перенумерация SID правил в зарезервированный clearndr-блок.

Проблема: правила, полученные из Snort/Talos/ET и сгенерированные фиды, несут
«чужие» SID, гарантированно занятые штатными источниками Clear NDR:
  - 0 .. 999 999      — зарезервировано дистрибутивом Snort (docs.snort.org),
  - 1 000 000 .. 2.2M — Emerging Threats Open / Pro (наш ET-корпус: 2 000 015..2 103 461),
  - 2 200 000 .. 2 299 999 — события движка Suricata (docs.suricata.io),
  - 10 .. 11M (PT), 20M/81M (Quadrant), 300M (OISF Traffic ID), ~900M (abuse.ch).
  Итог: импорт в прод падал на «SID 3 уже занят».

Решение: детерминированное отображение всего набора в свободный блок
    1 000 000 000 .. 1 099 999 999   (100 млн слотов, заведомо uint32)
  new_sid = 1e9 + md5("source|orig_sid") % 1e8, коллизии — линейный пробинг.
Карта хранится в data/sidmap.json: повторные сборки выдают те же sid для
неизменённых правил (обновления не «плавают» и не ломают уже установленный сет).
"""
import csv
import hashlib
import json
import os
import re

BLOCK_START = 1_000_000_000
BLOCK_SIZE = 100_000_000
BLOCK_END = BLOCK_START + BLOCK_SIZE - 1
MAP_PATH = "/home/z/my-project/data/sidmap.json"

MSG_RE = re.compile(r'\bmsg\s*:\s*"([^"]{0,90})')


class SidMapper:
    """Детерминированная, стабильная карта source|orig_sid -> new_sid в clearndr-блоке."""

    def __init__(self, path: str = MAP_PATH):
        self.path = path
        self.map: dict[str, int] = {}
        self.used: set[int] = set()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            self.map = d["map"]
            self.used = set(d.get("used", self.map.values()))

    def get(self, source: str, orig_sid: int) -> int:
        key = f"{source}|{orig_sid}"
        if key in self.map:
            return self.map[key]
        h = int(hashlib.md5(key.encode("utf-8")).hexdigest()[:8], 16)
        cand = BLOCK_START + h % BLOCK_SIZE
        while cand in self.used:
            cand += 1
            if cand > BLOCK_END:
                raise RuntimeError("clearndr SID block исчерпан")
        self.used.add(cand)
        self.map[key] = cand
        return cand

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"block": [BLOCK_START, BLOCK_END], "map": self.map}, f, separators=(",", ":"))
        os.replace(tmp, self.path)

    def write_csv(self, path: str, rules) -> None:
        """rules: объекты с полями source / orig_sid / sid / raw."""
        rows = {}
        for r in rules:
            key = f"{r['source']}|{r['orig_sid']}"
            if key in rows:
                continue
            m = MSG_RE.search(r["raw"])
            msg = (m.group(1) if m else "").replace('"', "'")
            rows[key] = (r["sid"], r["orig_sid"], r["source"], msg)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["clearndr_sid", "original_sid", "source", "msg"])
            for key in sorted(rows, key=lambda k: rows[k][0]):
                w.writerow(rows[key])


def replace_sid(raw: str, new_sid: int) -> str:
    """Заменить значение опции sid (первое вхождение), не трогая остальной текст правила."""
    out, cnt = re.subn(r"\bsid\s*:\s*\d+\s*;", f"sid:{new_sid};", raw, count=1)
    if cnt != 1:
        raise ValueError(f"опция sid не найдена: {raw[:120]}")
    return out


if __name__ == "__main__":
    m = SidMapper()
    print(f"Загружено отображений: {len(m.map)}; занято слотов: {len(m.used)}")
    print(f"Блок: {BLOCK_START:,} .. {BLOCK_END:,}")
