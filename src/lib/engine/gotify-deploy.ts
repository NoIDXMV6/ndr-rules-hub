// ─────────────────────────────────────────────────────────────────────────────
// Автоматическое развёртывание собственного сервера Gotify.
// Контейнер хаба (с монтированием docker.sock) сам запускает официальный образ
// gotify/server рядом на хосте: docker run -d -p PORT:80 -v ndr-gotify-data:/app/data gotify/server,
// дожидается /health и складывает в data/gotify/ готовый набор для окружения:
// docker-compose.gotify.yml, примеры реверс-прокси (Caddy/nginx) и README
// с настройкой домена, DNS и TLS.
// Для запуска на хосте руками (без docker.sock в хабе) — scripts/gotify-deploy.sh.
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { accessSync, constants as fsConstants } from 'fs'
import path from 'path'
import { request, Agent } from 'undici'
import { log } from './service'
import { DATA_DIR } from './fetcher'

const execFileP = promisify(execFile)
const CONTAINER = 'ndr-gotify'
// Официальные образы Gotify (https://gotify.net/docs/install) публикуются ПОРОВНО:
// gotify/server — amd64, gotify/server-arm64 — arm64, gotify/server-armv7 — armv7.
// Мультиарх-манифеста у gotify/server нет, поэтому образ выбирается по архитектуре
// хаб-процесса (контейнер хаба живёт на том же хосте, что и контейнер Gotify).
// Историческая ошибка «gotify/android» — несуществующий образ, docker run падал с
// «pull access denied for gotify/android, repository does not exist».
const GOTIFY_IMAGE: Record<string, string> = {
  arm64: 'gotify/server-arm64',
  arm: 'gotify/server-armv7',
  x64: 'gotify/server',
}
const IMAGE = GOTIFY_IMAGE[process.arch] ?? 'gotify/server'
const DOCKER_SOCKET = '/var/run/docker.sock'

export interface GotifyDeployResult {
  ok: boolean
  error?: string
  /** уже запущен ранее */
  alreadyRunning?: boolean
  url?: string
  port?: number
  container?: string
  files?: string[]
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
    return { ok: false, error: '/var/run/docker.sock не смонтирован в контейнер хаба (docker compose up -d --force-recreate после добавления тома) или запустите скрипт scripts/gotify-deploy.sh на хосте' }
  }
  try {
    await execFileP('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 })
    return { ok: true }
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    return { ok: false, error: (err.stderr || err.message || 'docker недоступен').trim() }
  }
}

async function containerState(): Promise<{ exists: boolean; running: boolean }> {
  try {
    const r = await execFileP('docker', ['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.State}}'], { timeout: 10_000 })
    const state = r.stdout.trim()
    return { exists: !!state, running: state === 'running' }
  } catch {
    return { exists: false, running: false }
  }
}

/** Основной адрес сервера Gotify с точки зрения хаба (шлюз docker-моста) */
async function detectGotifyUrl(port: number): Promise<string | undefined> {
  for (const host of ['172.17.0.1', 'host.docker.internal', '127.0.0.1']) {
    const url = `http://${host}:${port}/health`
    if (await probe(url, 2000)) return `http://${host}:${port}`
  }
  return undefined
}

// ── Файлы окружения (data/gotify/) ───────────────────────────────────────────

function composeYaml(port: number): string {
  return `# Gotify — сервер уведомлений для NDR Rules Hub (сгенерировано автоматически)
# Запуск: docker compose -f docker-compose.gotify.yml up -d
# Документация: https://gotify.net/docs/install
services:
  gotify:
    image: ${IMAGE}
    container_name: ${CONTAINER}
    restart: unless-stopped
    ports:
      - "${port}:80"
    environment:
      # пароль администратора при первом старте (дефолт admin/admin — СМЕНИТЕ после входа)
      - GOTIFY_DEFAULTUSER_PASS=\${GOTIFY_PASSWORD:-admin}
      # отключить регистрацию открытых учётных записей не требуется: доступ только к web UI
    volumes:
      - gotify-data:/app/data
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:80/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  gotify-data:
`
}

function caddyExample(domain: string): string {
  return `# Caddy — реверс-прокси с автоматическим TLS (Let's Encrypt).
# Установите Caddy на хосте, замените домен и перезапустите: systemctl reload caddy
${domain || 'gotify.example.com'} {
    reverse_proxy 127.0.0.1:8085
    # базовая защита от перебора — при желании добавьте basic_auth или fail2ban
}
`
}

function nginxExample(domain: string): string {
  return `# nginx — реверс-прокси для Gotify (TLS-сертификат: certbot --nginx -d ${domain || 'gotify.example.com'})
server {
    listen 443 ssl;
    server_name ${domain || 'gotify.example.com'};
    ssl_certificate     /etc/letsencrypt/live/${domain || 'gotify.example.com'}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain || 'gotify.example.com'}/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8085;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

server {
    listen 80;
    server_name ${domain || 'gotify.example.com'};
    return 301 https://$host$request_uri;
}
`
}

function readme(port: number, url?: string): string {
  return `# Собственный сервер Gotify — инструкция по окружению

Запущен контейнер \`${CONTAINER}\` (образ \`${IMAGE}\`, порт хоста ${port}).
${url ? `Адрес из контейнера хаба: ${url}\n` : ''}
## 1. Первый вход
- Откройте web-интерфейс: \`http://<адрес-сервера>:${port}\` (или ваш домен после настройки реверс-прокси).
- Дефолтные учётные данные: **admin / admin** — смените пароль сразу после входа
  (Users → admin → Change Password, https://gotify.net/docs/first-login).

## 2. Создание приложения и токена
- Web UI → Apps → Create Application → скопируйте **Token** приложения.
- Токен вставьте в NDR Rules Hub: Настройки → Уведомления → Gotify (URL + токен), включите канал и нажмите «Тест».

## 3. Домен и DNS
- Заведите A/AAAA-запись DNS на IP сервера (например \`gotify.example.com → 203.0.113.10\`).
- Порт ${port} должен быть закрыт снаружи файрволом — наружу публикуется только 80/443 реверс-прокси.

## 4. Реверс-прокси и TLS
- **Caddy** (проще всего, TLS автоматически): шаблон в \`CADDY.example\` — замените домен,
  положите блок в \`/etc/caddy/Caddyfile\`, \`systemctl reload caddy\`.
- **nginx**: шаблон в \`NGINX.example\`, сертификат: \`certbot --nginx -d ваш-домен\`.
- После настройки используйте \`https://ваш-домен\` как URL Gotify в настройках хаба.

## 5. Управление контейнером
- Логи: \`docker logs -f ${CONTAINER}\`
- Стоп/старт: \`docker stop ${CONTAINER} && docker start ${CONTAINER}\`
- Удалить: \`docker rm -f ${CONTAINER}\` (данные — том \`ndr-gotify-data\`).

Документация Gotify: https://gotify.net/docs/install · API: https://gotify.net/api-docs
`
}

// ── Деплой ───────────────────────────────────────────────────────────────────

export async function deployGotify(opts?: { port?: number; domain?: string }): Promise<GotifyDeployResult> {
  const port = Math.min(Math.max(opts?.port ?? 8085, 1024), 65535)
  const instructions: string[] = []
  const chk = await dockerOk()
  if (!chk.ok) {
    return { ok: false, error: chk.error, instructions }
  }
  const st = await containerState()
  if (st.running) {
    const url = await detectGotifyUrl(port)
    instructions.push('Контейнер ndr-gotify уже запущен — повторное развёртывание не требуется.')
    instructions.push(`Откройте web-интерфейс: ${url ?? `http://<адрес-сервера>:${port}`} и войдите (дефолт admin/admin — смените пароль).`)
    instructions.push('Создайте приложение (Apps → Create Application) и вставьте токен в Настройки → Уведомления → Gotify.')
    return { ok: true, alreadyRunning: true, url, port, container: CONTAINER, instructions }
  }
  if (st.exists) {
    // контейнер есть, но не запущен — стартуем его
    try {
      await execFileP('docker', ['start', CONTAINER], { timeout: 60_000 })
      instructions.push('Существующий контейнер ndr-gotify запущен.')
    } catch (e) {
      return { ok: false, error: `контейнер ndr-gotify существует, но не стартует: ${(e as { stderr?: string }).stderr ?? (e as Error).message}`, instructions }
    }
  } else {
    try {
      await execFileP('docker', ['run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped', '-p', `${port}:80`, '-v', 'ndr-gotify-data:/app/data', IMAGE], { timeout: 300_000 })
      instructions.push(`Контейнер ${CONTAINER} создан (образ ${IMAGE}, порт хоста ${port}, данные — том ndr-gotify-data).`)
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      return { ok: false, error: `docker run не удался: ${(err.stderr || err.message || '—').trim()} (образ ${IMAGE}, архитектура процесса хаба: ${process.arch})`, instructions }
    }
  }
  // дожидаемся /health (образ содержит HEALTHCHECK, ждём до ~45 c)
  let healthy = false
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await probe(`http://127.0.0.1:${port}/health`, 1500)) {
      healthy = true
      break
    }
  }
  const url = await detectGotifyUrl(port)
  // файлы окружения — в том данных, доступны с хоста (./data/gotify/)
  const dir = path.join(DATA_DIR, 'gotify')
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  const put = async (name: string, content: string) => {
    await writeFile(path.join(dir, name), content)
    files.push(path.join(dir, name))
  }
  try {
    await put('docker-compose.gotify.yml', composeYaml(port))
    await put('CADDY.example', caddyExample(opts?.domain ?? ''))
    await put('NGINX.example', nginxExample(opts?.domain ?? ''))
    await put('README.md', readme(port, url))
  } catch { /* том только для чтения — инструкции останутся в ответе и в доке */ }

  instructions.push(`Откройте web-интерфейс Gotify: ${url ?? `http://<адрес-сервера>:${port}`} и войдите admin/admin — сразу смените пароль.`)
  instructions.push('Apps → Create Application → скопируйте токен; вставьте его и URL сервера в Настройки → Уведомления → Gotify, включите канал и нажмите «Тест».')
  instructions.push(`Для публикации в интернет: DNS A-запись на сервер + реверс-прокси с TLS. Шаблоны Caddy/nginx и полная инструкция сохранены в ${dir} (том данных хаба).`)
  if (!healthy) {
    instructions.push('ВНИМАНИЕ: /health не ответил за 45 с — проверьте docker logs ndr-gotify (контейнер запущен, возможно ещё инициализируется).')
  }
  await log(healthy ? 'success' : 'warn', 'notify',
    `Gotify развёрнут: ${CONTAINER} на порту ${port}${healthy ? ' (health ok)' : ' (health не ответил — см. docker logs)'}; файлы окружения: ${files.join(', ') || 'не записаны'}`)
  return { ok: true, url, port, container: CONTAINER, files, instructions, alreadyRunning: false }
}

/** Удалить развёрнутый контейнер (опция в UI) */
export async function removeGotify(): Promise<{ ok: boolean; error?: string }> {
  const chk = await dockerOk()
  if (!chk.ok) return { ok: false, error: chk.error }
  const st = await containerState()
  if (!st.exists) return { ok: true }
  try {
    await execFileP('docker', ['rm', '-f', CONTAINER], { timeout: 60_000 })
    await log('info', 'notify', `Контейнер ${CONTAINER} удалён (данные — том ndr-gotify-data — сохранены)`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as { stderr?: string }).stderr ?? (e as Error).message }
  }
}

/** Текущее состояние развёрнутого Gotify (для карточки в настройках) */
export async function gotifyState(): Promise<{ containerRunning: boolean; url?: string; port: number }> {
  const port = 8085
  const st = await containerState().catch(() => ({ exists: false, running: false }))
  const url = st.running ? await detectGotifyUrl(port) : undefined
  return { containerRunning: st.running, url, port }
}

/** Чтение README из data/gotify (для UI) */
export async function gotifyReadme(): Promise<string | null> {
  try {
    return await readFile(path.join(DATA_DIR, 'gotify', 'README.md'), 'utf8')
  } catch {
    return null
  }
}
