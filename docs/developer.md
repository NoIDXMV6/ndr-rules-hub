# NDR Rules Hub — документация разработчика

> Сборка, архитектура, модель безопасности, редакции, тесты и релизный процесс.
> Для интеграции с Clear NDR см. [clearndr-integration.md](clearndr-integration.md);
> REST-спецификация — [openapi.json](../openapi.json); архитектурные диаграммы (C4,
> PlantUML) — [diagrams/](diagrams/).

## 1. Обзор и редакции

| | **Community** (по умолчанию) | **Enterprise** |
|---|---|---|
| Переключатель | `NDR_EDITION=community` (или не задан) | `NDR_EDITION=enterprise` |
| Аутентификация | нет — интерфейс работает как раньше | сессии (cookie `ndrh_sid`), пароли scrypt |
| Регистрация/верификация | нет | страница регистрации; первый пользователь → **администратор** (bootstrap), остальные — `pending` до верификации админом |
| Личный кабинет | — | Обзор, Источники (свои + общие), Категории, Правила, Сборка и экспорт, Обновление Clear NDR, Дашборды OpenSearch, Помощь, О системе |
| Админ-дополнение | весь UI | + Пользователи (верификация, отключение, роли), VPN, Настройки, Журнал |
| Токены скачивания | глобальный ключ `serveToken` | глобальный ключ + **персональные токены** `ndrt_…` на пользователя |
| API `/api/auth/*`, `/api/tokens*` | 404 | доступны |

Редакция определяется в `src/lib/edition.ts` (`edition()`, `multiUserEnabled()`); один и тот же образ разворачивается в обеих редакциях — переключение через env.

## 2. Структура репозитория

```
src/
  app/
    page.tsx                 # гейт аутентификации + вкладки по роли
    api/                     # Route Handlers (все с guard(), см. §4)
      auth/                  # register, login, logout, me, users[/id], events
      tokens/                # GET/POST /api/tokens, DELETE /api/tokens/{id}
      export/                # PULL-отдача: очередь + троттлинг + токены
      build|sources|...      # конвейер
  lib/
    edition.ts               # редакции Community/Enterprise
    security/                # слой защиты (§4) — единственное место с auth-логикой
    engine/                  # fetcher, parser, build, serve, exporter, scheduler...
    db.ts                    # Prisma (SQLite WAL, connection_limit=1)
    i18n/                    # ru.ts (канон) → en.ts типизирован как Dictionary
  components/hub/            # UI-вкладки, api.ts (клиент), auth-screen, users-tab
prisma/schema.prisma         # Source(+ownerId), Rule, Build, ..., User, Session, DownloadToken, AuthEvent
scripts/db-heal.cjs          # самовосстановление схемы БД тома при старте контейнера
docs/diagrams/*.puml         # C4 (C1/C2/C3) + sequence (PlantUML)
openapi.json                 # REST-спецификация (28 путей)
tests/                       # vitest (199 тестов)
```

## 3. Модель данных (Enterprise-таблицы)

- **User** — `email` (unique), `passwordHash` (`scrypt$N$r$p$salt$hash`), `role` (admin/user), `status` (pending/active/disabled), `verifiedAt/By`, `failedLogins`+`lockedUntil` (анти-брутфорс), `lastLoginAt`.
- **Session** — `tokenHash` = SHA-256 cookie-токена (256 бит base64url), `ip`, `userAgent`, `expiresAt` (слайдинг-TTL, настройка `sessionTtlHours`).
- **DownloadToken** — персональный токен скачивания: `tokenHash` (SHA-256; полный токен показывается один раз), `prefix` (12 символов для UI), `expiresAt`, `revokedAt`, статистика `downloadCount/bytesServed/lastUsedAt/lastIp`.
- **AuthEvent** — журнал безопасности (register, login_*, verify, download*, ratelimit…), подрезается до 20 000 строк.
- **Source.ownerId** — владелец источника (null = общий/каталог). Удаление пользователя переводит его источники в общие.

Докатка схемы на существующих БД тома выполняется автоматически `scripts/db-heal.cjs` (сравнение с манифестом из шаблона) — новые таблицы/колонки появляются без потери данных.

## 4. Слой безопасности (`src/lib/security/`)

Каждый API-роут начинается с шлюза:

```ts
const g = await guard(req, { admin: true, rate: { key: 'settings', rule: { limit: 60, windowMs: 60_000 } } })
if (g instanceof NextResponse) return g   // 401/403/429 уже сформированы
const { user, role, ip } = g
```

Порядок проверок в `guard()`: **rate limit** (до аутентификации — перебор отсекается сразу) → **CSRF** (`sameOriginOk`: Sec-Fetch-Site/Origin; curl и scirius без заголовков не ограничиваются — они аутентифицируются токенами) → **сессия** (в Community — пропуск всех, как раньше) → **роль** (`admin: true`). Гейт редакции для auth/tokens-эндпоинтов — `requireMultiUser()` (в Community 404).

| Модуль | Назначение |
|---|---|
| `password.ts` | scrypt (N=16384, r=8, p=1, соль 16Б), `timingSafeEqual`; политика: ≥8 символов, буквы+цифры. Для несуществующих email — проверка против фиктивного хеша (выравнивание времени ответа) |
| `ids.ts` | `randomToken` (32 Б base64url), `sha256hex`, `safeEqual` (константное сравнение) |
| `ratelimit.ts` | скользящее окно в памяти + кара `blockMs`; `peekBlocked`/`recordFailure` для анти-брутфорса; `clientIp` из `X-Forwarded-For` (ставит Caddy) |
| `session.ts` | cookie HttpOnly + SameSite=Lax + Secure(при HTTPS), в БД только SHA-256; слайдинг-TTL; сессия недействительна при `status != active` |
| `queue.ts` | очереди с лимитом параллельности: `download` 2/16/20с, `build` 1/4/5с, `fetch` 1/4/5с; переполнение/таймаут → `QueueFullError` → 429 + Retry-After |
| `throttle.ts` | глобальное ведёрко `Bandwidth` (настройка `downloadBandwidthKbps`, 0 = выкл) + `throttledStream` — суммарная скорость отдачи `/api/export` ограничена |
| `download-token.ts` | выдача/проверка/отзыв персональных токенов; анти-перебор `dlfail:<ip>` (10 неудач/5 мин → блок 15 мин); владелец должен быть `active` |
| `audit.ts` | AuthEvent fire-and-forget (журнал не ломает основной сценарий) |

**Анти-брутфорс входа** (`/api/auth/login`, диаграмма [seq-login-bruteforce](diagrams/seq-login-bruteforce.png)): лимит IP (10/5 мин → блок 15 мин) + лимит email (против распределённой атаки) + блок учётной записи (5 неудач подряд → `lockedUntil` +15 мин). Единый текст ошибки — не раскрываем наличие email.

**Санитизация секретов**: `SECRET_SETTING_KEYS` (serveToken, oinkcode, abusechAuthKey, clearndrExportToken) вырезаются из `/api/dashboard` и `/api/settings` для не-администраторов; VPN-статус тоже отдаётся только админу.

## 5. Отдача правил по URL (`/api/export`)

Порядок аутентификации в `serveBuild()` (см. [seq-download-flow](diagrams/seq-download-flow.png)):

1. `ndrt_…` → персональный токен (`verifyDownloadToken`, обновляет статистику);
2. глобальный `serveToken` (константное сравнение);
3. сессия веб-интерфейса (скачивание из кабинета без ключа);
4. `serveToken` пуст и токен не предъявлен → отдача открыта (совместимость; UI предупреждает);
5. отказ: 403 (неверный ключ) / 429 (перебор).

Роут оборачивает вызов в `withQueue('download', …)` и при `downloadBandwidthKbps > 0` отдаёт тело через `throttledStream`. Тексты ошибок внятные, т.к. scirius не проверяет HTTP-статус и пишет тело в файл.

## 6. Права и скоупинг

- **Источники**: пользователь создаёт источники со `ownerId = user.id` и управляет только своими; общие (ownerId=null, каталог builtin) — только вкл/выкл и загрузка; удаление/восстановление — только свои. Админ — всё.
- **Секреты и операции**: `PUT /api/settings`, `/api/vpn`, `/api/logs`, `/api/auth/users*`, `PUT /api/clearndr-update` — только администратор.
- **Общий конвейер** (категории, правила, сборка, экспорт, обновление, OSD) — доступен верифицированным пользователям (вкладки кабинета).
- Защиты `PATCH/DELETE /api/auth/users/{id}`: нельзя отключить/разжаловать/удалить себя; в системе остаётся минимум один активный администратор; disable немедленно сносит сессии пользователя.

## 7. UI

`page.tsx` опрашивает `/api/auth/me` (30 с): Community → обычный UI; Enterprise без сессии/pending → `AuthScreen` (вход/регистрация/экран ожидания верификации с автообновлением); активный пользователь → вкладки по роли. Токены скачивания — карточка в «Сборка и экспорт» (`TokensCard`): создание (полный токен показывается один раз), готовые URL-шаблоны, отзыв, статистика. i18n: новые секции `auth`, `users`, `tokens` добавлены и в `ru.ts`, и в `en.ts` (тип Dictionary enforced).

## 8. Тесты

```bash
npx vitest run              # все 199
npx vitest run tests/security-core.test.ts tests/auth-flow.test.ts tests/serve-tokens.test.ts
npm run lint && bunx tsc --noEmit   # 3 предсуществующих warning/ошибки в engine — известные
```

Новые наборы: `security-core` (22: scrypt, ids, rate limit, очередь, ведёрко/поток, редакции, CSRF-хелпер), `auth-flow` (15: bootstrap-админ, pending→verify, блокировки, сессии, токены, AuthEvent), `serve-tokens` (9: PULL с токенами, отзыв/срок/блок, статистика). Каждый тест — временный каталог + `prisma db push` (как `serve-url.test.ts`).

## 9. Сборка и релиз

```bash
bunx prisma generate && bunx prisma db push   # dev-БД
bunx --bun next build                          # standalone + шаблон БД + манифест схемы
```

Релизный чеклист: тесты → lint → build → версия в `package.json` → коммит с подробным описанием → push (origin, gitverse) → тег `vX.Y.Z`. Обновление на сервере: `cd /opt/ndr-rules-hub && git pull && docker compose up -d --build` (db-heal докатит схему тома автоматически).

## 10. Диаграммы (C4 + PlantUML)

| Файл | Содержание |
|---|---|
| [c1-context.puml](diagrams/c1-context.puml) / [png](diagrams/c1-context.png) | C1: акторы (админ, пользователь), Clear NDR, интернет-источники, OpenSearch, WireGuard |
| [c2-containers.puml](diagrams/c2-containers.puml) / [png](diagrams/c2-containers.png) | C2: UI, API, слой безопасности, движок, SQLite, скрипты, каталоги данных, Caddy |
| [c3-security.puml](diagrams/c3-security.puml) / [png](diagrams/c3-security.png) | C3: компоненты `src/lib/security` и их связи |
| [seq-registration-verification](diagrams/seq-registration-verification.png) | регистрация → pending → верификация → вход |
| [seq-download-flow](diagrams/seq-download-flow.png) | PULL: rate limit → очередь → токен → троттлинг |
| [seq-login-bruteforce](diagrams/seq-login-bruteforce.png) | анти-брутфорс входа (IP/email/lockedUntil) |

Перерендер: `java -jar plantuml.jar -tpng -charset UTF-8 docs/diagrams/*.puml` (или plantuml.com).

## 11. Известные ограничения (честно)

- Rate limit/очереди живут в памяти процесса: перезапуск контейнера сбрасывает счётчики (для сетевого экранирования при реальном DDoS — Caddy rate_limit/nftables перед контейнером, см. README «Защита»).
- `clientIp` доверяет `X-Forwarded-For`: порт приложения не выставлять наружу мимо прокси.
- Сессии в SQLite: масштаб до десятков пользователей; LDAP/OIDC — направление развития.
