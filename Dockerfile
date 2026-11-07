# ─────────────────────────────────────────────────────────────────────────────
# NDR Rules Hub — сборка образа
# Многоэтапная сборка: deps → build → runtime (Next.js standalone + WireGuard)
# ─────────────────────────────────────────────────────────────────────────────

# ── Этап 1: зависимости ───────────────────────────────────────────────────────
FROM oven/bun:1.2 AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ── Этап 2: сборка приложения + шаблон БД ────────────────────────────────────
FROM oven/bun:1.2 AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV DATABASE_URL="file:/app/db-template/hub.db"
ENV NEXT_TELEMETRY_DISABLED=1

RUN mkdir -p /app/db-template && \
    bunx prisma generate && \
    bunx prisma db push --skip-generate --accept-data-loss && \
    # версия схемы БД считается только по моделям (генератор исключён):
    # изменения binaryTargets и прочего в generator не должны стирать БД тома
    awk '/^generator/{g=1} g&&/^}/{g=0;next} !g' prisma/schema.prisma | sha256sum | cut -c1-12 > /app/db-template/.schema-version && \
    bunx --bun next build

# ── Этап 3: runtime — Next.js standalone + WireGuard-утилиты ─────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# WireGuard (wg + wg-quick), iptables, iproute2, tar — для загрузки/распаковки правил
# openresolv обязателен: wg-quick вызывает resolvconf для строк «DNS =» в конфиге,
# без него wg-quick up падает с «resolvconf: command not found»
# procps (sysctl) обязателен для full-tunnel конфигов (AllowedIPs 0.0.0.0/0)
RUN apt-get update && apt-get install -y --no-install-recommends \
      wireguard-tools \
      iptables \
      iproute2 \
      openresolv \
      procps \
      tar \
      gzip \
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

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL="file:/app/data/hub.db"
ENV RULES_DATA_DIR=/app/data
ENV WG_CONFIG_DIR=/app/data/wireguard
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/db-template ./db-template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /app/data/exports /app/data/cache /app/data/archives /app/data/wireguard

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/dashboard').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
