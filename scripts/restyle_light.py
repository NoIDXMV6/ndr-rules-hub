#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Перекраска UI из тёмной zinc-темы в светлый стиль оригинального Clear NDR.

Палитра оригинала (vendor/scirius):
  ui/app/config/theme.js: colorPrimary #005792, siderBg #fff, radius 4
  scss/_variables.scss:   #005792 (brand), #0297A9 (teal), #dcddde (light border),
                          #414042 (dark gray), #fbde00 (warn), #923b00 (danger)

Замены применяются по порядку: сначала контекстные пары, потом одиночные
токены. Затрагиваются только hub-компоненты и page.tsx; shadcn/ui-компоненты
уже используют семантические токены.
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project')
FILES = [
    'src/app/page.tsx',
    'src/components/hub/sources-tab.tsx',
    'src/components/hub/build-tab.tsx',
    'src/components/hub/vpn-tab.tsx',
    'src/components/hub/settings-tab.tsx',
    'src/components/hub/rules-tab.tsx',
    'src/components/hub/logs-tab.tsx',
]

# порядок важен: сначала более длинные/контекстные
REPL: list[tuple[str, str]] = [
    # ── контекстные пары ────────────────────────────────────────────────────
    ('bg-zinc-950 text-zinc-100', 'bg-background text-foreground'),           # корень страницы
    ('bg-zinc-950 border-zinc-800', 'bg-card border-input'),                  # поля ввода
    ('bg-zinc-900 border-zinc-800', 'bg-card border-border'),                 # карточки/диалоги/дропдауны
    ('bg-zinc-900/60', 'bg-card/95'),                                          # шапка
    ('bg-zinc-900/40', 'bg-card'),                                             # подвал
    ('bg-zinc-950/60', 'bg-muted'),                                            # sticky-шапка таблицы
    ('border-zinc-500 text-zinc-400', 'border-zinc-300 text-muted-foreground'),
    ('border-zinc-700 text-zinc-200', 'border-input text-foreground'),
    ('border-zinc-700 text-zinc-300', 'border-input text-foreground'),
    ('data-[state=active]:bg-emerald-600 data-[state=active]:text-white',
     'data-[state=active]:bg-primary data-[state=active]:text-primary-foreground'),
    ('bg-emerald-600 hover:bg-emerald-500 text-white', 'bg-primary hover:bg-primary/90 text-primary-foreground'),
    ('bg-emerald-600/20 border border-emerald-600/40', 'bg-primary/10 border border-primary/30'),  # логотип
    ('h-5 w-5 text-emerald-400', 'h-5 w-5 text-primary'),                      # иконка в логотипе
    ('h-4 w-4 text-emerald-400', 'h-4 w-4 text-primary'),                      # иконки заголовков
    ('text-emerald-500/80', 'text-emerald-600'),
    # ── одиночные токены ────────────────────────────────────────────────────
    ('bg-zinc-950', 'bg-card'),          # остатки: поля ввода без пары
    ('bg-zinc-900', 'bg-card'),
    ('border-zinc-800/70', 'border-border/60'),
    ('border-zinc-800', 'border-border'),
    ('border-zinc-700', 'border-input'),
    ('border-zinc-500', 'border-zinc-300'),
    ('text-zinc-100', 'text-foreground'),
    ('text-zinc-50', 'text-foreground'),
    ('text-zinc-200', 'text-foreground'),
    ('text-zinc-300', 'text-foreground'),
    ('text-zinc-400', 'text-muted-foreground'),
    ('text-zinc-500', 'text-muted-foreground'),
    # success / error / warn в светлых тонах (стиль antd-бейджей)
    ('bg-emerald-950/60', 'bg-emerald-50'),
    ('bg-emerald-950/30', 'bg-emerald-50'),
    ('bg-emerald-950', 'bg-emerald-50'),
    ('bg-red-950/60', 'bg-red-50'),
    ('bg-red-950/20', 'bg-red-50'),
    ('bg-red-950', 'bg-red-50'),
    ('bg-amber-950/20', 'bg-amber-50'),
    ('bg-amber-950', 'bg-amber-50'),
    ('border-emerald-800/50', 'border-emerald-300'),
    ('border-emerald-700', 'border-emerald-300'),
    ('border-emerald-800', 'border-emerald-300'),
    ('border-emerald-600/60', 'border-emerald-500'),
    ('border-emerald-600/50', 'border-emerald-400'),
    ('border-red-700/60', 'border-red-300'),
    ('border-red-800', 'border-red-300'),
    ('border-red-900', 'border-red-300'),
    ('border-red-700', 'border-red-300'),
    ('border-amber-800/50', 'border-amber-300'),
    ('border-amber-700/60', 'border-amber-300'),
    ('border-amber-700', 'border-amber-300'),
    ('border-amber-600/60', 'border-amber-500'),
    ('border-amber-600/50', 'border-amber-400'),
    ('border-violet-600/60', 'border-violet-400'),
    ('border-sky-600/60', 'border-sky-400'),
    ('border-lime-600/60', 'border-lime-400'),
    ('text-emerald-400', 'text-emerald-700'),
    ('text-emerald-300', 'text-emerald-800'),
    ('text-red-400', 'text-red-600'),
    ('text-red-300', 'text-red-700'),
    ('text-amber-400', 'text-amber-700'),
    ('text-amber-300', 'text-amber-800'),
    ('text-sky-400', 'text-sky-700'),
    ('text-violet-400', 'text-violet-700'),
    ('text-lime-400', 'text-lime-700'),
]

total = 0
for rel in FILES:
    p = ROOT / rel
    src = p.read_text()
    n = 0
    for old, new in REPL:
        c = src.count(old)
        if c:
            src = src.replace(old, new)
            n += c
    # схлопнуть двойные пробелы в className, если замены оставили пустоты
    src = re.sub(r'(className="[^"]*?)\s{2,}([^"]*")', r'\1 \2', src)
    p.write_text(src)
    print(f'{rel}: {n} замен')
    total += n

print(f'итого: {total}')
