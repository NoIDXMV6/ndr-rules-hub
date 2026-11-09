#!/bin/sh
set -e

# ── Инициализация каталога данных ────────────────────────────────────────────
mkdir -p /app/data/exports /app/data/cache /app/data/archives /app/data/wireguard
# метаданные прогонов обновления Clear NDR (раздел «Обновление Clear NDR»)
mkdir -p /app/data/clearndr-update/runs

# ── БД: самовосстановление схемы ─────────────────────────────────────────────
# Шаблон создаётся при сборке образа (prisma db push) и помечается версией
# схемы (sha256 prisma/schema.prisma). Если БД в томе отсутствует или её
# версия схемы отличается от шаблона — старый файл бэкапится и копируется
# свежий шаблон. Без этого устаревшая БД от прошлых запусков давала
# PrismaClientKnownRequestError P2022 ("column does not exist") и HTTP 500
# на всех API-роутах.
TEMPLATE_VER=$(cat /app/db-template/.schema-version 2>/dev/null || echo unknown)
DATA_VER=$(cat /app/data/.schema-version 2>/dev/null || echo none)

if [ ! -f /app/data/hub.db ]; then
  echo "[entrypoint] инициализация БД /app/data/hub.db (схема ${TEMPLATE_VER})"
  cp /app/db-template/hub.db /app/data/hub.db
  echo "$TEMPLATE_VER" > /app/data/.schema-version
elif [ "$DATA_VER" != "$TEMPLATE_VER" ]; then
  BAK="/app/data/hub.db.bak-$(date +%Y%m%d-%H%M%S)"
  echo "[entrypoint] схема БД (v:${DATA_VER}) не совпадает с образцом образа (v:${TEMPLATE_VER})"
  echo "[entrypoint] бэкап старой БД -> ${BAK}, создаётся новая (источники перекачиваются, oinkcode восстановится из OINKCODE)"
  mv /app/data/hub.db "$BAK"
  cp /app/db-template/hub.db /app/data/hub.db
  echo "$TEMPLATE_VER" > /app/data/.schema-version
else
  echo "[entrypoint] БД соответствует схеме образа (v:${TEMPLATE_VER})"
fi

# Каталог для локальных архивов правил: пользователь кладёт сюда tar.gz
if [ -z "$(ls -A /app/data/archives 2>/dev/null)" ]; then
  echo "[entrypoint] подсказка: положите архивы правил в ./data/archives (будут доступны как локальные источники)"
fi

# Разрешения для WireGuard-конфигов
chmod 700 /app/data/wireguard 2>/dev/null || true

echo "[entrypoint] запуск NDR Rules Hub на порту ${PORT:-3000}"
exec "$@"
