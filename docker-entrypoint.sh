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
#
# ИНЦИДЕНТ v1.36.0 (продакшен): контейнер unhealthy, docker logs ПУСТЫ,
# рестарт не помогает — db-heal выполнял тяжёлые операции молча и без
# ограничения времени (integrity_check огромной БД, до 15 снапшотов подряд,
# мультигигабайтный VACUUM INTO), а всё это — ДО exec node server.js.
# Лечение здесь: РАЗМЕРЫ БД печатаются первыми (логи больше не пустые),
# db-heal запускается под `timeout`, таймаут/неопределённость = ЗАПУСК
# СЕРВЕРА с существующей БД (стирание данных — только при ДОКАЗАННОМ
# повреждении, код 1 от db-heal). Порог — DB_HEAL_TIMEOUT (секунды).
TEMPLATE_VER=$(cat /app/db-template/.schema-version 2>/dev/null || echo unknown)
HEAL_TIMEOUT="${DB_HEAL_TIMEOUT:-300}"

# Хвостовые файлы WAL принадлежат КОНКРЕТНОМУ файлу БД: оставленный -wal
# поверх другого файла (шаблона/снимка) — типичная причина ошибки
# «database disk image is malformed» (SQLITE_CORRUPT): SQLite прикладывает
# кадры старого журнала к чужим страницам. Поэтому при ЛЮБОЙ подмене
# hub.db (шаблон, снимок) -wal/-shm уезжают вместе с бэкапом.
clean_db_sidecars() {
  rm -f /app/data/hub.db-wal /app/data/hub.db-shm
}

# Размеры БД и sidecar-файлов + свободное место — ПЕРВОЙ строкой в логах:
# по ним видно разрастание (гигабайтный WAL = след зависших сборок) и
# заканчивающееся место тома ДО любых операций с БД
db_size() { ls -l "$1" 2>/dev/null | awk '{printf "%.1f MB", $5/1048576}' || echo "нет"; }
FREE_KB=$(df -k /app/data 2>/dev/null | awk 'NR==2{print $4}' || echo '?')
echo "[entrypoint] том данных /app/data: hub.db $(db_size /app/data/hub.db), hub.db-wal $(db_size /app/data/hub.db-wal), hub.db-shm $(db_size /app/data/hub.db-shm), свободно ${FREE_KB} KB; схема шаблона ${TEMPLATE_VER}"

if [ ! -f /app/data/hub.db ]; then
  clean_db_sidecars
  echo "[entrypoint] инициализация БД /app/data/hub.db (схема ${TEMPLATE_VER})"
  cp /app/db-template/hub.db /app/data/hub.db
  echo "$TEMPLATE_VER" > /app/data/.schema-version
else
  echo "[entrypoint] db-heal: проверка и докатка схемы БД (глобальный таймаут ${HEAL_TIMEOUT}s)…"
  rc=0
  timeout --kill-after=30 "${HEAL_TIMEOUT}s" node /app/db-heal.cjs /app/data/hub.db /app/db-template/schema-manifest.json || rc=$?
  # 0 — ок/докатано: фиксируем маркер схемы
  # 2, 124, 137 — НЕ УСПЕЛ (таймаут db-heal / timeout): повреждённость НЕ
  #   доказана — запускаем сервер с существующей БД как есть; повторная
  #   проверка при следующем рестарте; ошибки БД будут видны в логах и
  #   /api/health. Раньше ANY сбой здесь стирал БД — на медленном диске с
  #   большой БД это делало рестарт бесконечно молчащим или теряло данные.
  # прочее — db-heal ДОКАЗАЛ повреждение и отсутствие здоровых снимков:
  #   прежнее поведение — бэкап старого файла (вместе с -wal/-shm) и БД из
  #   шаблона (источники перекачиваются, oinkcode восстановится из OINKCODE,
  #   ключ abuse.ch нужно ввести заново)
  case "$rc" in
    0)
      echo "$TEMPLATE_VER" > /app/data/.schema-version
      ;;
    2 | 124 | 137)
      echo "[entrypoint] ВНИМАНИЕ: db-heal не завершился (код ${rc}, таймаут ${HEAL_TIMEOUT}s) — БД НЕ считается повреждённой, запускаю сервер с существующей БД"
      echo "[entrypoint]   проверка повторится при следующем рестарте; диагностика: /api/health и размеры выше (гигабайтный WAL — признак зависших сборок)"
      ;;
    *)
      BAK="/app/data/hub.db.bak-$(date +%Y%m%d-%H%M%S)"
      echo "[entrypoint] БД повреждена (код ${rc} от db-heal) — бэкап -> ${BAK}, создаётся новая из шаблона (v:${TEMPLATE_VER})"
      mv /app/data/hub.db "$BAK"
      [ -f /app/data/hub.db-wal ] && mv /app/data/hub.db-wal "${BAK}-wal"
      [ -f /app/data/hub.db-shm ] && mv /app/data/hub.db-shm "${BAK}-shm"
      clean_db_sidecars
      cp /app/db-template/hub.db /app/data/hub.db
      echo "$TEMPLATE_VER" > /app/data/.schema-version
      ;;
  esac
fi

# Каталог для локальных архивов правил: пользователь кладёт сюда tar.gz
if [ -z "$(ls -A /app/data/archives 2>/dev/null)" ]; then
  echo "[entrypoint] подсказка: положите архивы правил в ./data/archives (будут доступны как локальные источники)"
fi

# Разрешения для WireGuard-конфигов
chmod 700 /app/data/wireguard 2>/dev/null || true

echo "[entrypoint] запуск NDR Rules Hub на порту ${PORT:-3000}"
exec "$@"
