#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Живой тест импорта файла правил в Scirius (движок правил Clear NDR), развёрнутый в песочнице.

Воспроизводит ровно тот путь, что в трейсбеке пользователя:
  UploadAddSourceTask._run -> upload(source_pk, path, add=True)
    -> source.new_uploaded_file(f) -> handle_uploaded_file -> _handle_file
    -> handle_rules_file -> category.get_rules -> DuplicateSidException -> ValidationError
"""
import os, sys, traceback

BASE = "/home/z/my-project/vendor/scirius"
STUBS = "/home/z/my-project/scripts/scirius_stubs"
sys.path.insert(0, BASE)
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "scirius.settings")

import site  # noqa: E402
site.addsitedir(STUBS)
import scirius_stubs  # noqa: F401

import django  # noqa: E402
django.setup()

from rules.models import Source, Rule, Category  # noqa: E402


def import_file(path: str, source_name: str) -> str:
    """Импортирует файл в новый источник; возвращает 'OK N' или текст ошибки."""
    Source.objects.filter(name=source_name).delete()
    src = Source(name=source_name, method="local", datatype="sig")
    src.save()
    try:
        with open(path, "rb") as f:
            src.new_uploaded_file(f)
    except Exception as e:
        msg = str(e)
        if not msg:
            msg = f"{type(e).__name__} (см. traceback ниже)"
        src.delete()
        return f"FAIL: {msg}"
    n = Rule.objects.filter(category__source=src).count()
    first = Rule.objects.filter(category__source=src).order_by("sid").values_list("sid", flat=True)[:3]
    src.delete()
    return f"OK: правил в источнике {n:,}; примеры sid: {list(first)}"


if __name__ == "__main__":
    targets = sys.argv[1:]
    for p in targets:
        name = os.path.basename(p)
        print(f"== импорт {name}")
        print(f"   {import_file(p, 'NDR rules HUB')}")
