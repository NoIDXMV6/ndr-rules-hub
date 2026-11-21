# ─────────────────────────────────────────────────────────────────────────────
# NDR&DNS Rules HUB — сборка образа
# Многоэтапная сборка: deps → build → runtime (Next.js standalone + WireGuard)
# ─────────────────────────────────────────────────────────────────────────────

# ── Этап 1: зависимости ───────────────────────────────────────────────────────
# Устойчивая установка bun install — scripts/bun-install.sh (COPY ниже,
# подробности в шапке скрипта). История инцидентов:
#   v1.27.0 — bun install на registry.npmjs.org висел 23196 с БЕЗ вывода
#             (сеть хоста сборки: DNS/IPv6/MTU/троттлинг; у bun install нет
#             своего таймаута) → добавлены предохранитель timeout и NPM_REGISTRY;
#   v1.36.1 — зеркало npm-mirror.gitverse.ru деградировало: манифест /next
#             (~31 МБ) отдаётся ~16 с (npmjs — 0.4 с), установка не укладывалась
#             в 2700 с и молча убивалась timeout'ом (bun в non-TTY не печатает
#             прогресс). Один реестр больше не судьба сборки:
#   1) ПРЕДПРОВЕРКА зеркал лёгким GET /ms (15 с): не ответившие исключаются
#      сразу, деградировавшие (медленнее BUN_SLOW_MS = 3000 мс) — в конец очереди;
#   2) порядок попыток — по возрастанию времени ответа: npmjs.org →
#      npmmirror.com → npm-mirror.gitverse.ru (NPM_REGISTRY, если задан,
#      проверяется первым, но в очередь встаёт по скорости);
#   3) предохранитель BUN_INSTALL_TIMEOUT — секунды НА ПОПЫТКУ (дефолт 900,
#      kill-after 30 с; до v1.36.1 — общий на шаг 2700 с), --verbose виден
#      в логе сборки: на каком пакете остановились;
#   4) cache-mount кэша bun сохраняется между сборками (bump версии не
#      пере-скачивает пакеты), --network-concurrency 16 — устойчивее на слабых
#      сетях.
# bun.lock НЕ содержит URL реестра (только integrity-хэши) — установка с
# любого зеркала детерминирована. Быстрые проверки при проблемах (на хосте):
#   curl -o /dev/null -sS -w 'total %{time_total}s\n' https://registry.npmjs.org/ms
#   docker build --network=host .   # на хосте быстро, в сборке висит → DNS/MTU bridge
FROM oven/bun:1.2 AS deps
# Основное зеркало (проверяется первым); пусто = авто-выбор самого быстрого
ARG NPM_REGISTRY=
# Предохранитель НА ОДНУ ПОПЫТКУ bun install (секунды). Всего попыток — до
# числа доступных зеркал (дефолт 3): худший случай ограничен, но сборка
# получает несколько независимых шансов вместо одного.
ARG BUN_INSTALL_TIMEOUT=900
ARG BUN_REGISTRIES=
ARG BUN_SLOW_MS=3000
WORKDIR /app

COPY scripts/bun-install.sh /usr/local/bin/bun-install.sh
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    chmod +x /usr/local/bin/bun-install.sh && \
    /usr/local/bin/bun-install.sh

# ── Этап 2: сборка приложения + шаблон БД ────────────────────────────────────
# Сборка идёт под Node.js, а НЕ под Bun. Причина: undici 8 (зависимость
# уведомлений Telegram/Gotify, экспорта abuse.ch и автоочистки) в
# lib/web/webidl/index.js делает
#   const { markAsUncloneable } = require('node:worker_threads')
# БЕЗ fallback-защиты и зовёт webidl.util.markAsUncloneable(this) в
# конструкторах Headers/Request/Response/FormData/CacheStorage. В Bun эта
# функция worker_threads не реализована, и при «Collecting page data»
# next build падал с фатальной ошибкой
#   TypeError: s.util.markAsUncloneable is not a function (ERR_NOT_IMPLEMENTED)
# — оценка модуля undici, вшитого Turbopack в серверный чанк (первой падала
# страница /api/auth/events). В Node.js markAsUncloneable есть с v22.14.0,
# поэтому сборка и рантайм (см. этап 3) под Node 22. Попутно уходят давние
# НЕ-фатальные предупреждения Bun «worker_threads.Worker option
# "stdout"/"stderr"/"resourceLimits" is not yet implemented» (шум jest-worker
# Next.js под Bun) и warning Prisma про libssl/openssl (пакет openssl ниже).
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# openssl нужен Prisma для определения варианта query engine
# (иначе «Prisma failed to detect the libssl/openssl version», дефолт 1.1.x)
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV DATABASE_URL="file:/app/db-template/hub.db"
ENV NEXT_TELEMETRY_DISABLED=1

# node_modules установлены bun'ом на этапе deps; бины в .bin — симлинки с
# шебангом #!/usr/bin/env node, под Node исполняются напрямую.
RUN mkdir -p /app/db-template && \
    ./node_modules/.bin/prisma generate && \
    ./node_modules/.bin/prisma db push --skip-generate --accept-data-loss && \
    # версия схемы БД считается только по моделям (генератор исключён):
    # изменения binaryTargets и прочего в generator не должны стирать БД тома
    awk '/^generator/{g=1} g&&/^}/{g=0;next} !g' prisma/schema.prisma | sha256sum | cut -c1-12 > /app/db-template/.schema-version && \
    # манифест схемы для db-heal.cjs (runtime): докатка недостающих таблиц/
    # колонок в БД тома без потери данных — см. docker-entrypoint.sh
    node scripts/gen-schema-manifest.mjs /app/db-template/hub.db /app/db-template/schema-manifest.json && \
    ./node_modules/.bin/next build

# ── Этап 3: runtime — Next.js standalone + WireGuard-утилиты ─────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# WireGuard (wg + wg-quick), iptables, iproute2, tar — для загрузки/распаковки правил
# openresolv обязателен: wg-quick вызывает resolvconf для строк «DNS =» в конфиге,
# без него wg-quick up падает с «resolvconf: command not found»
# procps (sysctl) обязателен для full-tunnel конфигов (AllowedIPs 0.0.0.0/0)
# openssh-client — режим SSH раздела «Обновление Clear NDR» (скрипт запускается на хосте)
# python3 — скрипты OSD-аналитики (clearndr-osd-*.sh) в режиме local:
#   разбор ответов OpenSearch, генерация мониторов/детекторов — stdlib only
RUN apt-get update && apt-get install -y --no-install-recommends \
      wireguard-tools \
      iptables \
      iproute2 \
      openresolv \
      procps \
      tar \
      gzip \
      curl \
      openssh-client \
      python3 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # Патчим wg-quick как в upstream wireguard-tools (коммит ac74ed6):
    # bookworm-версия (1.0.20210914) пишет sysctl net.ipv4.conf.all.src_valid_mark=1
    # БЕЗУСЛОВНО, а /proc/sys в контейнере read-only (особенно на ядрах 6.8+) —
    # up падает с «permission denied on key» даже когда значение уже 1
    # (выставлено через sysctls в docker-compose.yml). Условие «-ne 1»
    # пропускает запись, если docker уже выставил значение.
    && sed -i 's|\[\[ \$proto == -4 \]\] \&\& cmd sysctl -q net\.ipv4\.conf\.all\.src_valid_mark=1|[[ $proto == -4 ]] \&\& [[ $(sysctl -n net.ipv4.conf.all.src_valid_mark) -ne 1 ]] \&\& cmd sysctl -q net.ipv4.conf.all.src_valid_mark=1|' /usr/bin/wg-quick \
    && grep -q 'src_valid_mark) -ne 1' /usr/bin/wg-quick \
    || { echo 'FAIL: wg-quick src_valid_mark patch did not apply'; exit 1; }

# Режим «local» раздела «Обновление Clear NDR» (хаб в контейнере на хосте с
# Clear NDR): стек управляется через смонтированный /var/run/docker.sock.
# docker CLI — из официального образа (мультиарх); cli-plugins (compose) —
# развёртывание стека MISP (misp-deploy.ts): misp-core/modules/nginx + MariaDB
# + Valkey запускаются через docker compose -f data/misp/docker-compose.misp.yml
# (compose-файл и .env генерируются в том данных при деплое, см. misp-deploy.ts).
# ВАЖНО: в образе docker:cli плагин compose лежит в
# /usr/local/libexec/docker/cli-plugins (см. Dockerfile-cli.template
# docker-library/docker), путь /usr/local/lib/docker/cli-plugins в нём
# НЕ существует — COPY с ним падает «not found». Кладём плагин на один из
# стандартных путей поиска CLI-плагинов — /usr/local/lib/docker/cli-plugins.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins /usr/local/lib/docker/cli-plugins
# Проверка БЕЗ head в пайпе: «docker compose version | head -1 || ...» не
# срабатывает — статус пайпа берётся от head (0), и FAIL не выводился бы даже
# при отсутствии плагина.
RUN docker compose version || { echo 'FAIL: docker compose plugin missing'; exit 1; }
ARG TARGETARCH
# stamusctl — только amd64 (arm64-сборок upstream не публикует; на других
# архитектурах — режим SSH раздела «Обновление Clear NDR»)
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      curl -fsSL --max-time 300 -o /usr/local/bin/stamusctl \
        "https://dl.clearndr.io/stamusctl-linux-amd64" \
      && chmod +x /usr/local/bin/stamusctl \
      && stamusctl version 2>/dev/null | head -1 \
      || { echo 'FAIL: stamusctl download/execute failed'; exit 1; }; \
    else \
      echo "stamusctl: недоступен для ${TARGETARCH} — используйте режим SSH раздела обновления"; \
    fi

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL="file:/app/data/hub.db"
ENV RULES_DATA_DIR=/app/data
ENV WG_CONFIG_DIR=/app/data/wireguard
ENV NEXT_TELEMETRY_DISABLED=1
# Редакция по умолчанию — community (enterprise включается через
# docker-compose: NDR_EDITION=enterprise — многопользовательский режим)
ENV NDR_EDITION=community

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/db-template ./db-template
# скрипты обновления/восстановления/аналитики Clear NDR — источник для
# «Синхронизировать скрипты» в разделах «Обновление» и «Дашборды OpenSearch»
COPY scripts/clearndr-update.sh /app/scripts/clearndr-update.sh
COPY scripts/clearndr-repair-stack.sh /app/scripts/clearndr-repair-stack.sh
COPY scripts/clearndr-events-restore.sh /app/scripts/clearndr-events-restore.sh
COPY scripts/clearndr-osd-analytics-setup.sh /app/scripts/clearndr-osd-analytics-setup.sh
COPY scripts/clearndr-osd-dashboard-import.sh /app/scripts/clearndr-osd-dashboard-import.sh
COPY scripts/osd-packs/ /app/scripts/osd-packs/
# самовосстановление схемы БД тома (докатка таблиц/колонок без потери данных)
COPY scripts/db-heal.cjs /app/db-heal.cjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /app/db-heal.cjs /app/scripts/clearndr-update.sh /app/scripts/clearndr-repair-stack.sh /app/scripts/clearndr-events-restore.sh /app/scripts/clearndr-osd-analytics-setup.sh /app/scripts/clearndr-osd-dashboard-import.sh && \
    mkdir -p /app/data/exports /app/data/cache /app/data/archives /app/data/wireguard /app/data/clearndr-update/runs /app/data/clearndr-osd/runs

VOLUME ["/app/data"]
EXPOSE 3000

# Healthcheck — ЛЁГКИЙ (/api/ping: JSON без обращения к БД), а не /api/dashboard.
# Причина: сборка правил (с v1.24 — фоновая) занимает единственную SQLite-
# коннекцию (connection_limit=1) и нагружает event loop, /api/dashboard
# (ensureSeed + 5 запросов + wgStatus) в это окно не укладывался в таймаут —
# работающий контейнер помечался unhealthy на время сборки. Диагностика БД:
# curl http://127.0.0.1:3080/api/health (всегда 200 с отчётом).
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
