# Уведомления: Telegram и Gotify (включая свой сервер)

NDR Rules Hub умеет отправлять события в **Telegram** (с поддержкой прокси) и
**Gotify**. События настраиваются по отдельности: конвейер правил (полный цикл и cron),
WireGuard (поднятие/остановка/ошибки туннеля), диск (пороги занятости и результаты
автоочистки). Настройка: вкладка **«Настройки» → «Уведомления»**; проверка — кнопка
«Тест» после сохранения.

---

## 1. Telegram

1. Создайте бота у [@BotFather](https://t.me/BotFather): `/newbot` → получите токен вида
   `123456789:AA…`.
2. Узнайте chat id: напишите боту любое сообщение, затем откройте
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates` — в ответе найдите `chat.id`.
   Для группы/канала: добавьте бота администратором и используйте id с минусом
   (`-100…`).
3. Заполните в настройках: **Токен бота**, **Chat ID** → «Сохранить настройки» → «Тест».
4. Если Telegram недоступен напрямую (сеть без доступа к api.telegram.org) — укажите
   **прокси**: `http://user:pass@host:port`, `https://…` или
   `socks5://user:pass@host:1080` (поддерживаются socks4/4a/5/5h).
5. Свой Bot API Server (локальный сервер Telegram API) — в поле «API Telegram».

## 2. Gotify: подключение к существующему серверу

[Gotify](https://gotify.net/) — self-hosted сервер push-уведомлений
([API](https://gotify.net/api-docs), [установка](https://gotify.net/docs/install)).

1. В web-интерфейсе Gotify: **Apps → Create Application** → скопируйте **Token**
   приложения (это не клиентский токен).
2. В хабе: **Настройки → Уведомления → Gotify** → включите, заполните
   **URL сервера** (например `https://gotify.example.com`) и **App-токен**,
   при желании — приоритет (0–10; 5+ часто включает вибрацию на телефоне).
3. «Сохранить настройки» → «Тест» → сообщение придёт в приложение Gotify
   (Android/iOS/desktop-клиенты: см. сайт проекта).

Формат запроса хаба: `POST {url}/message` с заголовком `X-Gotify-Key` и JSON
`{title, message, priority}` — совместимо с любым сервером Gotify ≥ 2.0.

## 3. Свой сервер Gotify: автоматическое развёртывание

### Вариант 1 — из web UI (нужен docker.sock в контейнере хаба)

`docker-compose.yml` репозитория уже монтирует сокет
(`/var/run/docker.sock:/var/run/docker.sock:ro`). Нажмите
**«Настройки → Уведомления → Gotify → Свой сервер → Развернуть Gotify»**:

- хаб запустит контейнер `ndr-gotify` (образ `gotify/android`, порт хоста 8085 —
  настраивается, данные в named-volume `ndr-gotify-data`);
- дождётся готовности (`GET /health`);
- сохранит файлы окружения в **`data/gotify/`** (на хосте — `./data/gotify/`):
  - `docker-compose.gotify.yml` — самостоятельный compose-файл Gotify;
  - `CADDY.example` — реверс-прокси с автоматическим TLS (Let's Encrypt);
  - `NGINX.example` — реверс-прокси nginx + certbot;
  - `README.md` — инструкция по окружению;
- повторное нажатие не создаёт второй контейнер (уже запущен → вернётся URL),
  есть кнопка «Удалить контейнер» (данные тома сохраняются).

### Вариант 2 — скрипт на хосте (без docker.sock)

```bash
sudo bash scripts/gotify-deploy.sh --port 8085 --domain gotify.example.com
```

Скрипт делает то же самое на хосте: контейнер + health + файлы окружения
в `scripts/gotify/`.

### Первый вход и токен

1. Откройте `http://<адрес-сервера>:8085` (или домен после настройки прокси).
2. Дефолтные учётные данные — **admin / admin**: смените пароль сразу
   (Users → admin → Change Password; [docs: first-login](https://gotify.net/docs/first-login)).
3. **Apps → Create Application** → скопируйте токен → вставьте в настройки хаба → «Тест».

## 4. Настройка окружения: домен, DNS, реверс-прокси, TLS

Чтобы Gotify был доступен снаружи по имени и HTTPS:

1. **DNS**: A/AAAA-запись на IP сервера (например `gotify.example.com → 203.0.113.10`).
2. **Файрвол**: порт 8085 наружу НЕ публикуйте — наружу только 80/443 реверс-прокси.
3. **Caddy** (проще всего — TLS автоматически):
   ```caddyfile
   gotify.example.com {
       reverse_proxy 127.0.0.1:8085
   }
   ```
   Положите в `/etc/caddy/Caddyfile`, `systemctl reload caddy` — сертификат
   выпускается сам.
4. **nginx** + certbot:
   ```nginx
   server {
       listen 443 ssl;
       server_name gotify.example.com;
       ssl_certificate     /etc/letsencrypt/live/gotify.example.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/gotify.example.com/privkey.pem;
       location / {
           proxy_pass http://127.0.0.1:8085;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   server { listen 80; server_name gotify.example.com; return 301 https://$host$request_uri; }
   ```
   Сертификат: `sudo certbot --nginx -d gotify.example.com`.
5. В настройках хаба укажите `https://gotify.example.com` как URL Gotify.

Шаблоны обоих прокси генерируются автоматически (UI или скрипт) с вашим доменом
и портом.

## 5. Управление контейнером

```bash
docker logs -f ndr-gotify                    # логи
docker stop ndr-gotify && docker start ndr-gotify
docker rm -f ndr-gotify                      # удалить контейнер (том данных остаётся)
docker volume rm ndr-gotify-data             # удалить и данные
```

## 6. Что приходит в уведомления

| Событие | Содержание |
|---|---|
| Конвейер правил | итог полного цикла / cron: сколько источников загрузилось, сколько правил собрано, ошибки по именам |
| WireGuard | туннель поднят / остановлен / не поднялся (с причиной) |
| Диск | занятость ≥ порога предупреждения/критического; результат автоочистки (было → стало %, освобождено, что удалено) |

Включаются по отдельности: «Настройки → Уведомления → События».
