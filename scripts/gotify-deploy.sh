#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# gotify-deploy.sh — свой сервер Gotify на хосте, без docker.sock в хабе.
# Тот же результат, что и кнопка «Развернуть Gotify» в web UI:
#   контейнер ndr-gotify (официальный образ по архитектуре) + ожидание /health
#   + файлы окружения (docker-compose.gotify.yml, CADDY.example, NGINX.example,
#   README.md) в каталог вывода (по умолчанию ./data/gotify).
# Идемпотентен: повторный запуск поднимает существующий контейнер/ничего не ломает.
#
# Использование:
#   sudo bash scripts/gotify-deploy.sh [--port 8085] [--domain gotify.example.com]
#                                      [--out ./data/gotify] [--name ndr-gotify]
# Архитектура образа (у Gotify нет мультиарх-манифеста):
#   x86_64 → gotify/server, aarch64 → gotify/server-arm64, armv7* → gotify/server-armv7
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PORT=8085
DOMAIN=""
OUT="./data/gotify"
NAME="ndr-gotify"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)  PORT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --out)   OUT="$2"; shift 2 ;;
    --name)  NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Неизвестный аргумент: $1 (см. --help)" >&2; exit 2 ;;
  esac
done

# docker без прав → пробуем sudo
DOCKER="docker"
if ! docker info >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi
command -v docker >/dev/null 2>&1 || { echo "FAIL: docker не найден на хосте" >&2; exit 1; }

# Образ по архитектуре хоста
case "$(uname -m)" in
  x86_64)  IMAGE="gotify/server" ;;
  aarch64) IMAGE="gotify/server-arm64" ;;
  armv7*|armhf) IMAGE="gotify/server-armv7" ;;
  *) echo "FAIL: неизвестная архитектура $(uname -m) — выберите образ вручную (gotify/server, gotify/server-arm64, gotify/server-armv7)" >&2; exit 1 ;;
esac

# Контейнер: уже запущен → старт существующий → создать новый
STATE="$($DOCKER ps -a --filter "name=^/${NAME}$" --format '{{.State}}' 2>/dev/null || true)"
if [ "$STATE" = "running" ]; then
  echo "Контейнер ${NAME} уже запущен — пропускаю создание."
elif [ -n "$STATE" ]; then
  echo "Контейнер ${NAME} существует, но остановлен — запускаю."
  $DOCKER start "$NAME"
else
  echo "Создаю контейнер ${NAME} (образ ${IMAGE}, порт хоста ${PORT})."
  $DOCKER run -d --name "$NAME" --restart unless-stopped \
    -p "${PORT}:80" -v "${NAME}-data:/app/data" "$IMAGE"
fi

# Ожидание /health (до 45 с)
HEALTHY=0
for _ in $(seq 1 45); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
    HEALTHY=1; break
  fi
  sleep 1
done
if [ "$HEALTHY" = "1" ]; then
  echo "Gotify готов: http://127.0.0.1:${PORT} (health ok)"
else
  echo "ВНИМАНИЕ: /health не ответил за 45 с — проверьте: ${DOCKER} logs ${NAME}" >&2
fi

# Файлы окружения
mkdir -p "$OUT"
cat > "${OUT}/docker-compose.gotify.yml" <<EOF
# Gotify — сервер уведомлений для NDR Rules Hub (сгенерировано scripts/gotify-deploy.sh)
# Запуск: docker compose -f docker-compose.gotify.yml up -d
# Документация: https://gotify.net/docs/install
services:
  gotify:
    image: ${IMAGE}
    container_name: ${NAME}
    restart: unless-stopped
    ports:
      - "${PORT}:80"
    environment:
      # пароль администратора при первом старте (дефолт admin/admin — СМЕНИТЕ после входа)
      - GOTIFY_DEFAULTUSER_PASS=\${GOTIFY_PASSWORD:-admin}
    volumes:
      - gotify-data:/app/data
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:80/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  gotify-data:
EOF

cat > "${OUT}/CADDY.example" <<EOF
# Caddy — реверс-прокси с автоматическим TLS (Let's Encrypt).
# Установите Caddy на хосте, замените домен и перезапустите: systemctl reload caddy
${DOMAIN:-gotify.example.com} {
    reverse_proxy 127.0.0.1:${PORT}
    # базовая защита от перебора — при желании добавьте basic_auth или fail2ban
}
EOF

cat > "${OUT}/NGINX.example" <<EOF
# nginx — реверс-прокси для Gotify (TLS-сертификат: certbot --nginx -d ${DOMAIN:-gotify.example.com})
server {
    listen 443 ssl;
    server_name ${DOMAIN:-gotify.example.com};
    ssl_certificate     /etc/letsencrypt/live/${DOMAIN:-gotify.example.com}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN:-gotify.example.com}/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}

server {
    listen 80;
    server_name ${DOMAIN:-gotify.example.com};
    return 301 https://\$host\$request_uri;
}
EOF

cat > "${OUT}/README.md" <<EOF
# Собственный сервер Gotify — инструкция по окружению

Контейнер \`${NAME}\` (образ \`${IMAGE}\`, порт хоста ${PORT}).

## 1. Первый вход
- Web-интерфейс: \`http://<адрес-сервера>:${PORT}\` (или ваш домен после настройки реверс-прокси).
- Дефолтные учётные данные: **admin / admin** — смените пароль сразу после входа
  (Users → admin → Change Password, https://gotify.net/docs/first-login).

## 2. Создание приложения и токена
- Web UI → Apps → Create Application → скопируйте **Token** приложения.
- Токен вставьте в NDR Rules Hub: Интеграции → Уведомления и сервисы → Gotify (URL + токен), включите канал и нажмите «Тест».

## 3. Домен и DNS
- Заведите A/AAAA-запись DNS на IP сервера (например \`gotify.example.com → 203.0.113.10\`).
- Порт ${PORT} должен быть закрыт снаружи файрволом — наружу публикуется только 80/443 реверс-прокси.

## 4. Реверс-прокси и TLS
- **Caddy** (проще всего, TLS автоматически): шаблон в \`CADDY.example\` — замените домен,
  положите блок в \`/etc/caddy/Caddyfile\`, \`systemctl reload caddy\`.
- **nginx**: шаблон в \`NGINX.example\`, сертификат: \`certbot --nginx -d ваш-домен\`.
- После настройки используйте \`https://ваш-домен\` как URL Gotify в настройках хаба.

## 5. Управление контейнером
- Логи: \`${DOCKER} logs -f ${NAME}\`
- Стоп/старт: \`${DOCKER} stop ${NAME} && ${DOCKER} start ${NAME}\`
- Удалить: \`${DOCKER} rm -f ${NAME}\` (данные — том \`${NAME}-data\`).

Документация Gotify: https://gotify.net/docs/install · API: https://gotify.net/api-docs
EOF

echo "Файлы окружения записаны: ${OUT}/ (docker-compose.gotify.yml, CADDY.example, NGINX.example, README.md)"
echo "Дальше: Интеграции → Уведомления и сервисы → Gotify → URL + App-токен (Apps → Create Application) → «Тест»."
