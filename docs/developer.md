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
    db.ts                    # Prisma (SQLite WAL; db — интерфейс, dbHeavy — сборки)
    i18n/                    # ru.ts (канон) → en.ts типизирован как Dictionary
  components/hub/            # UI-вкладки, api.ts (клиент), auth-screen, users-tab
prisma/schema.prisma         # Source(+ownerId), Rule, Build, ..., User, Session, DownloadToken, AuthEvent
scripts/db-heal.cjs          # самовосстановление схемы БД тома при старте контейнера
docs/diagrams/*.puml         # C4 (C1/C2/C3) + sequence (PlantUML)
openapi.json                 # REST-спецификация (44 пути, вкл. DNS-модуль)
tests/                       # vitest (199 тестов)
```

## 3. Модель данных (Enterprise-таблицы)

- **User** — `email` (unique), `passwordHash` (`scrypt$N$r$p$salt$hash`), `role` (admin/user), `status` (pending/active/disabled), `verifiedAt/By`, `failedLogins`+`lockedUntil` (анти-брутфорс), `lastLoginAt`.
- **Session** — `tokenHash` = SHA-256 cookie-токена (256 бит base64url), `ip`, `userAgent`, `expiresAt` (слайдинг-TTL, настройка `sessionTtlHours`).
- **DownloadToken** — персональный токен скачивания: `tokenHash` (SHA-256; полный токен показывается один раз), `prefix` (12 символов для UI), `expiresAt`, `revokedAt`, статистика `downloadCount/bytesServed/lastUsedAt/lastIp`.
- **AuthEvent** — журнал безопасности (register, login_*, verify, download*, ratelimit…), подрезается до 20 000 строк.
- **Source.ownerId** — владелец источника (null = системный каталог). Удаление пользователя переводит его источники в общие.

### Рабочие пространства (v1.27.0)

Ключевые сущности (`src/lib/engine/workspace.ts` — чистые функции, покрыты тестами):

- **Source.visibility** (`private | published`) — видимость источника владельца: опубликованный виден другим пользователям (вкл/выкл у себя), приватный — только владельцу.
- **Source.adminOnly** — источник только для администратора (ET Pro, MISP Suricata Export, MISP Attributes — секреты уровня системы): в пользовательских пространствах скрыт и в персональные сборки не попадает.
- **SourceState** (`userId`, `sourceId`, `enabled`, unique-пара) — состояние источника В РАБОЧЕМ ПРОСТРАНСТВЕ пользователя. Без строки состояние наследуется от `Source.enabled` (новый пользователь видит системный набор как есть).
- **Build.userId** — null = системная сборка (админ, PULL-набор Clear NDR); cuid пользователя = его персональная сборка (файл `personal-<slug>.rules`). Отдача: токен/сессия пользователя → его персональная сборка, без неё — фолбэк на системную (аудит `system-fallback`).
- **LogEntry.userId / messageEn** — события рабочего пространства: пользователь видит ТОЛЬКО свои; системные (null) — только админ. Английский текст события — `messageEn`, интерфейс выбирает по языку.

Выборка источников (`isSourceVisible` / `effectiveEnabled` / `selectWorkspaceSources`):

- админ видит всё не удалённое; его состояние — `Source.enabled` (системное);
- пользователь видит: системные (кроме adminOnly) + свои + опубликованные другими; эффективное включение = `SourceState` ?? `Source.enabled`;
- система (cron) обновляет только источники каталога (`ownerId IS NULL`) — пользовательские обновляют их владельцы; пользователь «Обновить все» обновляет только свои;
- cron после системной сборки пересобирает персональные наборы только у тех, чья подпись рабочего пространства (`workspaceSignature`: состав/состояния/priority/ruleCount/updatedAt) изменилась с прошлой персональной сборки (`stats.workspaceSignature`).

Права PATCH/POST `/api/sources`: admin — любой источник (в т.ч. бейджи, adminOnly); пользователь — свои (в т.ч. бейджи и visibility), чужие/системные — только вкл/выкл (в SourceState). Открытие/закрытие источника пользователем — `SourceState.upsert`, не `Source.enabled`.

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

**Санитизация секретов**: `SECRET_SETTING_KEYS` (serveToken, oinkcode, etProOinkcode, abusechAuthKey, mispAuthKey, openNrdLicense, rstApiKey, clearndrExportToken) вырезаются из `/api/dashboard` и `/api/settings` для не-администраторов; VPN-статус тоже отдаётся только админу. Сущность «глобальный ключ отдачи списка доменов» (dnsServeToken) удалена (v1.34.0): `GET /api/dns/export` работает только по персональному токену со scope «domains»/«both» или из сессии кабинета.

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

`page.tsx` опрашивает `/api/auth/me` (30 с): Community → обычный UI; Enterprise без сессии/pending → `AuthScreen` (вход/регистрация/экран ожидания верификации с автообновлением); активный пользователь → вкладки по роли. Токены скачивания — раздел «Аккаунт» → «Токены и доступ» (v1.31.0; раньше карточка в «Сборке и экспорте»; `TokensCard` в `tokens-card.tsx`, вкладка `account-tokens-tab.tsx`): создание (полный токен показывается один раз, готовые Uri — БЕЗ токена: токен вставляется в поле authkey источника Clear NDR), область (scope: правила/домены/оба списка), отзыв (`Ban`), возврат отозванного (`RotateCcw`), удаление (`Trash2`), статистика. Сборка — асинхронная: `POST /api/build` возвращает jobId, `GET /api/build/progress` опрашивается раз в секунду — прогрессбар + журнал фаз (`build-progress.ts`, singleton в памяти процесса; cron-сборки тоже видны). Копирование в буфер — `copyToClipboard()` (utils.ts): secure-context API + фолбэк `execCommand` для http. i18n: новые секции `auth`, `users`, `tokens` добавлены и в `ru.ts`, и в `en.ts` (тип Dictionary enforced).

Навигация — меню-бар (`MenuBar` в `page.tsx`) с группами: первый уровень держит ТОЛЬКО группы (v1.30.0 — иначе меню не помещалось целиком): «Правила» (Источники/Категории/Правила/Сборка и экспорт), «DNS списки» (зеркальная группа, админ), «Интеграции» (уведомления/обновление Clear NDR/OSD/MISP/VPN — только админ), «Администрирование» (настройки/журнал/+пользователи в Enterprise), «Аккаунт» (Профиль и 2FA / Токены и доступ — Enterprise, v1.31.0) и «Справка» (помощь, о системе); прямая кнопка — «Обзор». Пункты распределены по всей ширине строки (`flex-1`, вес `grow` по длине подписи), активная группа подсвечена, активная вкладка отмечена галочкой в выпадающем меню. Структура меню — `buildMenu(t, isAdmin, showUsers)`, подписи групп — секция `menu` словаря; при смене роли вкладка вне списка разрешённых автоматически сбрасывается на «Обзор». Бейдж редакции в шапке берётся из `me.edition` (/api/auth/me), а не из `editionLabel()` — клиентский бандл не видит `process.env.NDR_EDITION`.

Липкость (v1.18.2): шапка и меню-бар — ОДИН `sticky top-0 z-40` блок в `page.tsx`; меню всегда видно под шапкой у любой роли и при любой высоте шапки. Раньше top меню считался из JS-измерения (`useState(68)` + `useEffect` с пустыми deps + ResizeObserver), но эффект срабатывал на сплэше (шапки ещё нет) и не перезапускался — `top` навсегда оставался 68px: у пользователя с однострочным хидером (64px) выглядело нормально, у администратора хидер выше (бейджи переносятся, 113px) и меню уезжало под шапку. Баннеры сообщений — вне липкого блока.

Кабинет «Аккаунт» (v1.18.2): коды подтверждения Telegram и TOTP — РАЗДЕЛЬНЫЕ состояния (`tgCode`/`totpCode`) — раньше одно общее состояние привязывалось к обоим инпутам и ввод «зеркалился» в соседнее поле. TOTP-QR: `show-totp-qr` возвращает QR/ключ ТЕКУЩЕГО секрета БЕЗ перевыпуска (потеря картинки при смене вкладки/перезагрузке больше не ломает привязку), `setup-totp` — явный перевыпуск («Пересоздать ключ», старый QR недействителен). Тесты — `tests/mfa-captcha.test.ts`, блок «аккаунт (route)» (4).

## 8. Тесты

```bash
npx vitest run              # все 250
npx vitest run tests/security-core.test.ts tests/auth-flow.test.ts tests/serve-tokens.test.ts
npm run lint && bunx tsc --noEmit   # 3 предсуществующих warning/ошибки в engine — известные
```

Новые наборы: `security-core` (22: scrypt, ids, rate limit, очередь, ведёрко/поток, редакции, CSRF-хелпер), `auth-flow` (15: bootstrap-админ, pending→verify, блокировки, сессии, токены, AuthEvent), `serve-tokens` (9: PULL с токенами, отзыв/срок/блок, статистика). Каждый тест — временный каталог + `prisma db push` (как `serve-url.test.ts`).

## 9. Сборка и релиз

```bash
bunx prisma generate && bunx prisma db push   # dev-БД
npx next build                                # standalone + шаблон БД + манифест схемы — строго под Node.js
```

`next build` и Docker-стадия builder выполняются под **Node.js 22** (в образе — `node:22-bookworm-slim` + пакет `openssl`), не под Bun: undici 8 в `lib/web/webidl/index.js` берёт `markAsUncloneable` из `node:worker_threads` без fallback и зовёт его в конструкторах Headers/Request/Response/FormData/CacheStorage — в Bun эта функция не реализована, и на этапе «Collecting page data» сборка падала с `TypeError: s.util.markAsUncloneable is not a function` (оценка модуля undici, вшитого Turbopack в серверный чанк). В Node.js функция есть с v22.14.0. Под Node также исчезают не-фатальные предупреждения Bun «worker_threads.Worker option "stdout"/"stderr"/"resourceLimits" is not yet implemented» (шум jest-worker Next.js) и warning Prisma про libssl/openssl. Рантайм контейнера и раньше был Node 22 (`node server.js`) — сборка теперь на той же платформе; bun остаётся на этапе deps (`bun install --frozen-lockfile`) и в dev-скриптах.

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
