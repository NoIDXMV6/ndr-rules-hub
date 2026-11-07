#!/bin/sh
set -e

# ── Инициализация каталога данных ────────────────────────────────────────────
mkdir -p /app/data/exports /app/data/cache /app/data/archives /app/data/wireguard

# БД: при первом запуске копируем пустой шаблон со схемой Prisma
if [ ! -f /app/data/hub.db ]; then
  echo "[entrypoint] инициализация БД /app/data/hub.db"
  cp /app/db-template/hub.db /app/data/hub.db
fi

# Каталог для локальных архивов правил: пользователь кладёт сюда tar.gz
if [ -z "$(ls -A /app/data/archives 2>/dev/null)" ]; then
  echo "[entrypoint] подсказка: положите архивы правил в ./data/archives (будут доступны как локальные источники)"
fi

# Разрешения для WireGuard-конфигов
chmod 700 /app/data/wireguard 2>/dev/null || true

echo "[entrypoint] запуск NDR Rules Hub на порту ${PORT:-3000}"
exec "$@"
