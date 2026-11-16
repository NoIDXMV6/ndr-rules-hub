#!/bin/sh
set -e

# ── Инициализация каталога данных ────────────────────────────────────────────
mkdir -p /app/data/exports /app/data/cache /app/data/archives /app/data/wireguard
# метаданные прогонов обновления Clear NDR (раздел «Обновление Clear NDR»)
mkdir -p /app/data/clearndr-update/runs

# ── БД: самовосстановление схемы БЕЗ потери данных ──────────────────────────
# Шаблон БД (пустая, со схемой образа) и манифест схемы создаются при сборке
# образа (prisma db push + scripts/gen-schema-manifest.mjs).
# Если БД в томе отсутствует — копируется шаблон. Если БД есть — db-heal.cjs
# сравнивает её структуру с манифестом и ДОКАТЫВАЕТ недостающие таблицы/
# колонки/индексы, не трогая данные: обновление образа больше не требует
# перекачки источников и не стирает настройки (oinkcode, abuse.ch Auth-Key,
# историю сборок, категории, переопределения правил).
# Раньше здесь сравнивался sidecar-файл .schema-version с шаблоном и БД
# целиком заменялась: при рассинхроне самих версий (БД старой схемы с
# «актуальным» маркером) проверка молча пропускалась, и Prisma падал с
# P2022 «The column … does not exist in the current database» на всех API.
TEMPLATE_VER=$(cat /app/db-template/.schema-version 2>/dev/null || echo unknown)

# Хвостовые файлы WAL принадлежат КОНКРЕТНОМУ файлу БД: оставленный -wal
# поверх другого файла (шаблона/снимка) — типичная причина ошибки
# «database disk image is malformed» (SQLITE_CORRUPT): SQLite прикладывает
# кадры старого журнала к чужим страницам. Поэтому при ЛЮБОЙ подмене
# hub.db (шаблон, снимок) -wal/-shm уезжают вместе с бэкапом.
clean_db_sidecars() {
  rm -f /app/data/hub.db-wal /app/data/hub.db-shm
}

if [ ! -f /app/data/hub.db ]; then
  clean_db_sidecars
  echo "[entrypoint] инициализация БД /app/data/hub.db (схема ${TEMPLATE_VER})"
  cp /app/db-template/hub.db /app/data/hub.db
  echo "$TEMPLATE_VER" > /app/data/.schema-version
elif node /app/db-heal.cjs /app/data/hub.db /app/db-template/schema-manifest.json; then
  echo "$TEMPLATE_VER" > /app/data/.schema-version
else
  # БД повреждена (db-heal не смог: integrity_check не прошёл даже на снимках)
  # или лечение не удалось — бэкап старого файла (вместе с -wal/-shm, они
  # содержат несброшенные страницы именно этого файла и пригодятся для
  # ручного разбора) и свежий шаблон (источники перекачиваются, oinkcode
  # восстановится из OINKCODE, ключ abuse.ch нужно ввести заново)
  BAK="/app/data/hub.db.bak-$(date +%Y%m%d-%H%M%S)"
  echo "[entrypoint] БД не читается или лечение не удалось — бэкап -> ${BAK}, создаётся новая из шаблона (v:${TEMPLATE_VER})"
  mv /app/data/hub.db "$BAK"
  [ -f /app/data/hub.db-wal ] && mv /app/data/hub.db-wal "${BAK}-wal"
  [ -f /app/data/hub.db-shm ] && mv /app/data/hub.db-shm "${BAK}-shm"
  clean_db_sidecars
  cp /app/db-template/hub.db /app/data/hub.db
  echo "$TEMPLATE_VER" > /app/data/.schema-version
fi

# Каталог для локальных архивов правил: пользователь кладёт сюда tar.gz
if [ -z "$(ls -A /app/data/archives 2>/dev/null)" ]; then
  echo "[entrypoint] подсказка: положите архивы правил в ./data/archives (будут доступны как локальные источники)"
fi

# Разрешения для WireGuard-конфигов
chmod 700 /app/data/wireguard 2>/dev/null || true

echo "[entrypoint] запуск NDR Rules Hub на порту ${PORT:-3000}"
exec "$@"
