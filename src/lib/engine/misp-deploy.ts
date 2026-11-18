// ─────────────────────────────────────────────────────────────────────────────
// Автоматическое развёртывание собственного сервера MISP (threat intelligence
// platform) по образцу развёртывания Gotify (gotify-deploy.ts).
//
// MISP — это НЕ одиночный контейнер: официальный образ ghcr.io/misp/misp-docker
// (бывший ostefano/docker-misp) состоит из стека misp-core + misp-nginx +
// misp-modules + MariaDB + Valkey(Redis). Поэтому хаб генерирует
// docker-compose.misp.yml + .env (случайные пароли, ADMIN_KEY = API-ключ) в
// томе данных (./data/misp на хосте) и запускает стек через
//   docker compose -f docker-compose.misp.yml -p ndr-misp --env-file .env up -d
// docker compose-плагин входит в образ хаба (скопирован из docker:cli в
// Dockerfile). Для запуска руками на хосте — файлы остаются в ./data/misp.
//
// После деплоя хаб автоматически подставляет адрес (mispUrl) и API-ключ
// (mispAuthKey, тот же, что читают источники-фиды MISP) — коннекторы и
// источник MISP начинают работать сразу, без ручного копирования ключа.
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { accessSync, constants as fsConstants } from 'fs'
import path from 'path'
import { request, Agent } from 'undici'
import { db } from '@/lib/db'
import { log } from './service'
import { DATA_DIR } from './fetcher'

const execFileP = promisify(execFile)
export const MISP_PROJECT = 'ndr-misp'
const CORE_CONTAINER = 'ndr-misp-core'
const COMPOSE_FILE = 'docker-compose.misp.yml'
const ENV_FILE = '.env'
export const MISP_DEFAULT_PORT = 8408
const DOCKER_SOCKET = '/var/run/docker.sock'

export interface MispDeployResult {
  ok: boolean
  error?: string
  alreadyRunning?: boolean
  url?: string
  port?: number
  adminKey?: string
  adminPassword?: string
  files?: string[]
  healthy?: boolean
  instructions: string[]
}

const insecure = () => new Agent({ connect: { rejectUnauthorized: false } })

/** GET-проверка URL с коротким таймаутом */
async function probe(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await request(url, { dispatcher: insecure(), headersTimeout: timeoutMs, bodyTimeout: timeoutMs })
    await res.body.dump()
    return res.statusCode >= 200 && res.statusCode < 500 // 404 тоже «живой» сервер
  } catch {
    return false
  }
}

async function dockerOk(): Promise<{ ok: boolean; error?: string }> {
  try {
    accessSync(DOCKER_SOCKET, fsConstants.F_OK)
  } catch {
    return { ok: false, error: '/var/run/docker.sock не смонтирован в контейнер хаба — MISP можно развернуть вручную по инструкции (файлы окружения записываются при каждом деплое)' }
  }
  try {
    await execFileP('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 })
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    return { ok: false, error: (err.stderr || err.message || 'docker недоступен').trim() }
  }
  // compose-плагин обязателен (стек из 5 контейнеров)
  try {
    const v = await execFileP('docker', ['compose', 'version', '--format', '{{.Version}}'], { timeout: 15_000 })
    if (!v.stdout.trim()) throw new Error('пустой вывод')
    return { ok: true }
  } catch {
    return { ok: false, error: 'docker compose недоступен в контейнере хаба (нужен образ с cli-plugins; пересоберите: docker compose build && docker compose up -d --force-recreate)' }
  }
}

async function containerState(): Promise<{ exists: boolean; running: boolean }> {
  try {
    const r = await execFileP('docker', ['ps', '-a', '--filter', `name=^/${CORE_CONTAINER}$`, '--format', '{{.State}}'], { timeout: 10_000 })
    const state = r.stdout.trim()
    return { exists: !!state, running: state === 'running' }
  } catch {
    return { exists: false, running: false }
  }
}

/** Основной адрес сервера MISP с точки зрения хаба (шлюз docker-моста) */
async function detectMispUrl(port: number): Promise<string | undefined> {
  for (const host of ['172.17.0.1', 'host.docker.internal', '127.0.0.1']) {
    const url = `http://${host}:${port}/`
    if (await probe(url, 2000)) return `http://${host}:${port}`
  }
  return undefined
}

// ── Валидация ввода ──────────────────────────────────────────────────────────

function normalizeBaseUrl(raw: string | undefined, port: number): string {
  const v = (raw ?? '').trim().replace(/\/+$/, '')
  if (!v) return `http://127.0.0.1:${port}`
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return `http://127.0.0.1:${port}`
  }
}

// ── Генерация файлов окружения (экспортированы для тестов) ───────────────────

export interface MispEnvOpts {
  baseUrl: string
  adminEmail: string
  adminPassword: string
  adminKey: string
  dbPassword: string
  dbRootPassword: string
  redisPassword: string
  port: number
  tz?: string
}

export function mispEnvFile(o: MispEnvOpts): string {
  return [
    '# Окружение MISP — сгенерировано NDR Rules Hub автоматически.',
    '# Измените и перезапустите стек: docker compose -f docker-compose.misp.yml -p ndr-misp --env-file .env up -d',
    '# ВНИМАНИЕ: ADMIN_KEY применяетcя при ПЕРВОЙ инициализации БД — после этого',
    '# ключ хранится в самой MISP и правится только в её web-интерфейсе.',
    `BASE_URL=${o.baseUrl}`,
    `NGINX_HTTP_PORT=${o.port}`,
    `TZ=${o.tz || 'UTC'}`,
    '',
    `ADMIN_EMAIL=${o.adminEmail}`,
    `ADMIN_PASSWORD=${o.adminPassword}`,
    `ADMIN_KEY=${o.adminKey}`,
    `ADMIN_ORG=NDR Rules Hub`,
    '',
    `MYSQL_USER=misp`,
    `MYSQL_PASSWORD=${o.dbPassword}`,
    `MYSQL_ROOT_PASSWORD=${o.dbRootPassword}`,
    `MYSQL_DATABASE=misp`,
    '',
    `REDIS_PASSWORD=${o.redisPassword}`,
    '',
    'CORE_RUNNING_TAG=latest',
    'MODULES_RUNNING_TAG=latest',
    '',
  ].join('\n')
}

/** compose-файл стека MISP. Именованные тома вместо bind-каталогов: compose
 *  запускается из контейнера хаба, а bind-пути резолвятся на хосте —
 *  /app/data/misp/... на хосте не существует. Именованные тома управляются
 *  демоном и переживают пересоздание. */
export function mispComposeFile(o: MispEnvOpts): string {
  return `# MISP — threat intelligence platform для NDR Rules Hub (сгенерировано автоматически)
# Запуск: docker compose -f docker-compose.misp.yml -p ndr-misp --env-file .env up -d
# Документация: https://github.com/MISP/misp-docker · https://www.misp-project.org
services:
  db:
    image: ghcr.io/mariadb/mariadb:10.11
    container_name: ndr-misp-db
    restart: unless-stopped
    # буфер 512M вместо дефолтных 2048M: MISP работает и так, а стек влезает на
    # небольшой сервер; для больших инстансов поднимите через правку файла
    command: "--innodb-buffer-pool-size=512M --innodb-change-buffering=none --innodb-log-file-size=600M --innodb-read-io-threads=4 --innodb-write-io-threads=4"
    environment:
      - "MYSQL_USER=\${MYSQL_USER}"
      - "MYSQL_PASSWORD=\${MYSQL_PASSWORD}"
      - "MYSQL_ROOT_PASSWORD=\${MYSQL_ROOT_PASSWORD}"
      - "MYSQL_DATABASE=\${MYSQL_DATABASE}"
      - "TZ=\${TZ}"
    volumes:
      - mysql_data:/var/lib/mysql
    cap_add:
      - SYS_NICE
    healthcheck:
      test: mysqladmin --user=$$MYSQL_USER --password=$$MYSQL_PASSWORD status
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 30s

  redis:
    image: ghcr.io/valkey-io/valkey:7.2
    container_name: ndr-misp-redis
    restart: unless-stopped
    command: valkey-server --requirepass "\${REDIS_PASSWORD}"
    environment:
      - "TZ=\${TZ}"
    volumes:
      - cache_data:/data
    healthcheck:
      test: ["CMD-SHELL", "valkey-cli -a '$$REDIS_PASSWORD' ping | grep -q PONG || valkey-cli ping | grep -q PONG"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 5s

  misp-modules:
    image: ghcr.io/misp/misp-docker/misp-modules:\${MODULES_RUNNING_TAG}
    container_name: ndr-misp-modules
    restart: unless-stopped
    environment:
      - "TZ=\${TZ}"
    healthcheck:
      test: "/bin/bash -c '</dev/tcp/localhost/6666'"
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 10s

  misp-core:
    image: ghcr.io/misp/misp-docker/misp-core:\${CORE_RUNNING_TAG}
    container_name: ndr-misp-core
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
      db:
        condition: service_healthy
      misp-modules:
        condition: service_healthy
    expose:
      - 9002
    environment:
      - "BASE_URL=\${BASE_URL}"
      - "ADMIN_EMAIL=\${ADMIN_EMAIL}"
      - "ADMIN_PASSWORD=\${ADMIN_PASSWORD}"
      - "ADMIN_KEY=\${ADMIN_KEY}"
      - "ADMIN_ORG=\${ADMIN_ORG}"
      - "MYSQL_HOST=db"
      - "MYSQL_PORT=3306"
      - "MYSQL_USER=\${MYSQL_USER}"
      - "MYSQL_PASSWORD=\${MYSQL_PASSWORD}"
      - "MYSQL_DATABASE=\${MYSQL_DATABASE}"
      - "REDIS_HOST=redis"
      - "REDIS_PORT=6379"
      - "REDIS_PASSWORD=\${REDIS_PASSWORD}"
      - "TZ=\${TZ}"
    volumes:
      - misp-config:/var/www/MISP/app/Config
      - misp-logs:/var/www/MISP/app/tmp/logs
      - misp-files:/var/www/MISP/app/files
      - misp-gnupg:/var/www/MISP/.gnupg
    cap_add:
      - AUDIT_WRITE
    healthcheck:
      test: bash -c 'echo > /dev/tcp/127.0.0.1/9002'
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 60s

  misp-nginx:
    image: ghcr.io/misp/misp-docker/misp-nginx:\${CORE_RUNNING_TAG}
    container_name: ndr-misp-nginx
    restart: unless-stopped
    depends_on:
      misp-core:
        condition: service_healthy
    ports:
      - "\${NGINX_HTTP_PORT}:8080"
    environment:
      - "TZ=\${TZ}"
      - "BASE_URL=\${BASE_URL}"
      - "FASTCGI_LISTEN=misp-core:9002"
      - "FASTCGI_LISTEN_STATUS=misp-core:9003"
    volumes:
      - misp-ssl:/etc/nginx/certs
    tmpfs:
      - /etc/nginx/conf.d:mode=0755,uid=101,gid=101
      - /var/cache/nginx:mode=0755,uid=101,gid=101
      - /tmp:mode=1777
    user: nginx
    read_only: true
    cap_drop:
      - ALL

volumes:
  mysql_data:
  cache_data:
  misp-config:
  misp-logs:
  misp-files:
  misp-gnupg:
  misp-ssl:
`
}

function readme(o: MispEnvOpts, url?: string): string {
  return `# Собственный сервер MISP — инструкция по окружению

Стек MISP развёрнут (compose-проект \`${MISP_PROJECT}\`): ndr-misp-core, ndr-misp-nginx,
ndr-misp-modules, ndr-misp-db (MariaDB 10.11), ndr-misp-redis (Valkey 7.2).
Порт хоста: ${o.port}, BASE_URL: ${o.baseUrl}
${url ? `Адрес из контейнера хаба: ${url}\n` : ''}
## 1. Первый вход (инициализация занимает 2–5 минут)
- Web UI: \`http://<адрес-сервера>:${o.port}\` (BASE_URL=${o.baseUrl} — при другом адресе
  поправьте \`.env\` и перезапустите стек).
- Логин: **${o.adminEmail}** / пароль: \`см. .env → ADMIN_PASSWORD\` (сгенерирован, смените после входа).
- API-ключ администратора (ADMIN_KEY) уже сохранён в NDR Rules Hub
  («Интеграции → MISP»), отдельного копирования не требуется.

## 2. Требования
- RAM: рекомендуются 4+ ГБ (MariaDB буфер 512M, PHP memory_limit 2048M).
- Первый старт: миграции БД — контейнер ndr-misp-core может «стартовать» несколько минут.

## 3. Управление
- Логи: \`docker logs -f ndr-misp-core\`
- Стоп/старт: \`docker compose -f docker-compose.misp.yml -p ndr-misp --env-file .env stop\` / \`up -d\`
- Полное удаление С данными: \`docker compose -f docker-compose.misp.yml -p ndr-misp --env-file .env down -v\`
- Удаление контейнеров с сохранением данных: то же без \`-v\` (тома mysql_data и др. остаются).

## 4. Использование с NDR Rules Hub
- **Источники-фиды**: каталог уже содержит источник «MISP Feed — Events»
  (restSearch JSON) — включите его, ключ берётся тот же (Настройки → Токены источников → MISP API Key).
- **Коннекторы событий**: «Интеграции → MISP» — Clear NDR/Wazuh/Zabbix/MikroTik/webhook
  создают события в этой MISP через REST API.

Документация MISP: https://www.misp-project.org/documentation/ · API: https://www.misp-project.org/openapi/
`
}

// ── Деплой ───────────────────────────────────────────────────────────────────

export async function deployMisp(opts?: { port?: number; baseUrl?: string; adminEmail?: string }): Promise<MispDeployResult> {
  const port = Math.min(Math.max(opts?.port ?? MISP_DEFAULT_PORT, 1024), 65535)
  const baseUrl = normalizeBaseUrl(opts?.baseUrl, port)
  const adminEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((opts?.adminEmail ?? '').trim()) ? (opts?.adminEmail ?? '').trim() : 'admin@ndr.local'
  const instructions: string[] = []
  const chk = await dockerOk()
  if (!chk.ok) return { ok: false, error: chk.error, instructions }

  const st = await containerState()
  if (st.running) {
    const url = await detectMispUrl(port)
    instructions.push('Стек MISP уже запущен — повторное развёртывание не требуется.')
    instructions.push(`Web UI: ${url ?? `http://<адрес-сервера>:${port}`}; API-ключ уже в «Интеграции → MISP».`)
    return { ok: true, alreadyRunning: true, url, port, instructions }
  }

  // секреты: ADMIN_KEY = API-ключ MISP (40 hex), пароли БД/Redis/админа — случайные
  const adminKey = randomBytes(20).toString('hex')
  const adminPassword = randomBytes(12).toString('base64url')
  const dbPassword = randomBytes(16).toString('hex')
  const dbRootPassword = randomBytes(16).toString('hex')
  const redisPassword = randomBytes(16).toString('hex')
  const o: MispEnvOpts = { baseUrl, adminEmail, adminPassword, adminKey, dbPassword, dbRootPassword, redisPassword, port, tz: process.env.TZ || 'UTC' }

  // файлы окружения — в том данных, доступны с хоста (./data/misp/)
  const dir = path.join(DATA_DIR, 'misp')
  const files: string[] = []
  const put = async (name: string, content: string) => {
    await writeFile(path.join(dir, name), content)
    files.push(path.join(dir, name))
  }
  try {
    await mkdir(dir, { recursive: true })
    await put(COMPOSE_FILE, mispComposeFile(o))
    await put(ENV_FILE, mispEnvFile(o))
    await put('README.md', readme(o))
  } catch (e) {
    return { ok: false, error: `не удалось записать файлы окружения в ${dir}: ${(e as Error).message}`, instructions }
  }

  if (!st.exists) {
    // свежий стек: pull образов заранее (MISP core — ~2 ГБ), затем up -d
    try {
      await execFileP('docker', ['compose', '-f', path.join(dir, COMPOSE_FILE), '-p', MISP_PROJECT, '--env-file', path.join(dir, ENV_FILE), 'pull', '--quiet'], { timeout: 900_000 })
    } catch {
      instructions.push('Загрузка образов (pull) не завершилась — docker compose всё равно попытается скачать при запуске.')
    }
  }
  try {
    await execFileP('docker', ['compose', '-f', path.join(dir, COMPOSE_FILE), '-p', MISP_PROJECT, '--env-file', path.join(dir, ENV_FILE), 'up', '-d'], { timeout: 600_000 })
    instructions.push(`Стек MISP запущен (compose-проект ${MISP_PROJECT}, порт хоста ${port}).`)
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    return { ok: false, error: `docker compose up не удался: ${(err.stderr || err.message || '—').trim().slice(0, 800)}`, instructions }
  }

  // ждём готовность nginx (первая инициализация MISP — миграции БД — до ~3 мин)
  let healthy = false
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10_000))
    if (await probe(`http://127.0.0.1:${port}/`, 2500)) {
      healthy = true
      break
    }
  }
  const url = await detectMispUrl(port)

  // адрес и API-ключ сразу в настройки хаба: источник MISP и коннекторы
  // начинают работать без ручного копирования ключа
  try {
    await db.setting.upsert({ where: { key: 'mispUrl' }, create: { key: 'mispUrl', value: baseUrl }, update: { value: baseUrl } })
    await db.setting.upsert({ where: { key: 'mispAuthKey' }, create: { key: 'mispAuthKey', value: adminKey }, update: { value: adminKey } })
  } catch { /* БД недоступна — ключ останется только в .env */ }

  instructions.push(`Web UI MISP: ${baseUrl} (логин ${adminEmail}; пароль — .env → ADMIN_PASSWORD, смените после входа).`)
  instructions.push('API-ключ администратора (ADMIN_KEY) сохранён в «Интеграции → MISP» — нажмите «Проверить» для подтверждения связи.')
  if (!healthy) {
    instructions.push('ВНИМАНИЕ: MISP не ответил за ~5 мин — первая инициализация может длиться дольше. Проверьте docker logs ndr-misp-core и повторите «Проверить» позже.')
  }
  await log(healthy ? 'success' : 'warn', 'misp',
    `MISP развёрнут: compose-проект ${MISP_PROJECT}, порт ${port}${healthy ? ' (доступен)' : ' (инициализация)'}; файлы: ${files.join(', ') || 'не записаны'}`)
  return { ok: true, url: url ?? baseUrl, port, adminKey, adminPassword, files, healthy, instructions, alreadyRunning: false }
}

/** Удалить стек (контейнеры; тома данных MISP сохраняются) */
export async function removeMisp(): Promise<{ ok: boolean; error?: string }> {
  const chk = await dockerOk()
  if (!chk.ok) return { ok: false, error: chk.error }
  const st = await containerState()
  if (!st.exists) return { ok: true }
  const dir = path.join(DATA_DIR, 'misp')
  try {
    const args = ['compose', '-p', MISP_PROJECT]
    const composePath = path.join(dir, COMPOSE_FILE)
    const envPath = path.join(dir, ENV_FILE)
    try {
      accessSync(composePath, fsConstants.F_OK)
      args.push('-f', composePath, '--env-file', envPath)
    } catch { /* файлов нет — down по имени проекта */ }
    args.push('down', '--remove-orphans')
    await execFileP('docker', args, { timeout: 180_000 })
    await log('info', 'misp', `Стек MISP (${MISP_PROJECT}) удалён; тома данных сохранены`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as { stderr?: string }).stderr ?? (e as Error).message }
  }
}

/** Порт из настройки mispDeployPort (дефолт 8408) */
async function mispPortFromSettings(): Promise<number> {
  try {
    const row = await db.setting.findUnique({ where: { key: 'mispDeployPort' } })
    const parsed = parseInt(row?.value ?? '', 10)
    if (Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535) return parsed
  } catch { /* БД недоступна — дефолт */ }
  return MISP_DEFAULT_PORT
}

/** Состояние развёрнутого MISP (карточка «Интеграции → MISP») */
export async function mispDeployState(): Promise<{ containerRunning: boolean; url?: string; port: number }> {
  const port = await mispPortFromSettings()
  const st = await containerState().catch(() => ({ exists: false, running: false }))
  const url = st.running ? await detectMispUrl(port) : undefined
  return { containerRunning: st.running, url, port }
}

/** Чтение README из data/misp (для UI) */
export async function mispReadme(): Promise<string | null> {
  try {
    return await readFile(path.join(DATA_DIR, 'misp', 'README.md'), 'utf8')
  } catch {
    return null
  }
}
