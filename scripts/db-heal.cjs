#!/usr/bin/env node
// ============================================================================
// db-heal.cjs — самовосстановление БД тома до схемы образа, БЕЗ потери данных.
// Запускается docker-entrypoint.sh ДО старта сервера.
//
//   node db-heal.cjs <файл-БД> <манифест-схемы.json>
//
// Манифест создаётся при сборке образа (scripts/gen-schema-manifest.mjs) из
// свежего шаблона hub.db. Скрипт сравнивает живую БД с манифестом и докатывает:
//   - отсутствующую таблицу  → CREATE TABLE (DDL из манифеста);
//   - отсутствующую колонку  → ALTER TABLE ADD COLUMN (тип; DEFAULT — если был;
//     NOT NULL без DEFAULT не переносится — колонка станет nullable, Prisma
//     это допускает, данные не теряются);
//   - отсутствующий индекс   → CREATE INDEX.
// Перед первым изменением — консистентная копия БД через VACUUM INTO
// (в файл <db>.preheal-<время>).
//
// Чинит два инцидента из продакшена:
//  1) P2022 «The column `deletedAt` does not exist in the current database»
//     после обновления образа, когда sidecar-файл .schema-version не отражал
//     реальную структуру БД;
//  2) SQLITE_CORRUPT «database disk image is malformed» (extended_code 11) —
//     битые страницы данных. ALTER TABLE редактирует страницу 1 (sqlite_master)
//     и может «успешно» пройти на повреждённой БД: приложение стартует, но падает
//     на каждом запросе. Поэтому перед лечением БД проверяется быстрым сканом
//     (quick_check, см. ниже), а при провале восстанавливается из последнего
//     здорового снимка:
//       <db>.preheal-*  — VACUUM-копии, которые этот скрипт делает перед ALTER'ами;
//       <db>.bak-*      — бэкапы entrypoint при подмене БД шаблоном.
//     Хвостовые -wal/-shm при подмене файла БД удаляются: кадры старого WAL,
//     наложенные на страницы другого файла — типичная причина «malformed».
//
// ИНЦИДЕНТ v1.36.0 (продакшен): контейнер unhealthy, docker logs ПУСТЫ,
// рестарт не помогает. Причина: db-heal выполнял ТЯЖЁЛЫЕ операции молча и
// БЕЗ ограничения времени — integrity_check на огромной БД (после зависших
// DNS-сборок том разросся: миллионы доменов + гигабайтный WAL), проверка до
// 15 снапшотов подряд, мультигигабайтный VACUUM INTO. Всё это — ДО exec node
// server.js: приложение не стартует, healthcheck не отвечает, логи пустые.
// Лечение (все тяжёлые шаги):
//   • печать размеров/прогресса ДО начала работы — логи больше не пустые;
//   • жёсткий таймаут на каждый шаг (DB_HEAL_TIMEOUT_MS, дефолт 90с);
//   • bounded-скан quick_check(25) вместо полного integrity_check: стоп
//     после 25 проблем (быстрый фейл на повреждённой БД); полный
//     integrity_check — только при NDR_DB_FULL_CHECK=1;
//   • снапшотов проверяется максимум 5 (каждый со своим таймаутом);
//   • коды выхода: 0 — ок/докатано; 1 — БД повреждена без здоровых снимков
//     (entrypoint бэкапит и создаёт БД из шаблона); 2 — проверка НЕ
//     ЗАВЕРШИЛАСЬ (таймаут) — БД НЕ считается повреждённой, entrypoint
//     запускает сервер с существующей БД (диагностика в /api/health).
// После успешной проверки — wal_checkpoint(TRUNCATE): подрезает огромный
// WAL, оставшийся от зависших сборок (мог быть больше самой БД).
// Никогда не стирает данные сам: решение «шаблон вместо БД» принимает
// только entrypoint и только на коде 1.
//
// ИНЦИДЕНТ v1.36.2 (продакшен): БД тома 1.3 GB — quick_check(25) не
// укладывался в 90с, выход с кодом 2 обрывал скрипт ДО докатки схемы
// (код 2 означал «не успел, БД не тронута») — сервер стартовал на устаревшей
// схеме тома, все API падали P2022/P2021, UI вечно показывал «Проверка
// сессии…». Лечение:
//   • скан целостности ПРОПУСКАЕТСЯ на БД больше DB_HEAL_CHECK_SKIP_MB
//     (дефолт 400 MB): на большой БД скан идёт минутами и съедал бюджет
//     рестарта, а докатка схемы — метаданные (sqlite_master + PRAGMA
//     table_info), на страницах данных не зависит; полный скан — вручную:
//     NDR_DB_FULL_CHECK=1 (+ DB_HEAL_TIMEOUT_MS побольше);
//   • тайм-аут скана больше НЕ обрывает скрипт: повреждённость не доказана
//     (структурная проверка пройдена) — докатка выполняется, сервер стартует
//     со СВЕЖЕЙ схемой вместо устаревшей.
// ============================================================================
const fs = require('fs')
const path = require('path')

const P = '[db-heal]'
const dbArg = process.argv[2]
const manifestArg = process.argv[3]
// сколько самых свежих снимков проверять; каждый — со своим таймаутом
const MAX_CANDIDATES = 5
// таймаут ОДНОГО тяжёлого шага (скан, снапшот, VACUUM, индекс);
// DB_HEAL_TIMEOUT_MS задаётся в секундах*1000 при запуске, любые значения > 0
// допускаются (тесты), отсутствие/некорректное — дефолт 90с
const rawTimeoutMs = Number(process.env.DB_HEAL_TIMEOUT_MS)
const STEP_TIMEOUT_MS = rawTimeoutMs > 0 ? rawTimeoutMs : 90_000
// полный integrity_check вместо quick_check(25) — только вручную через env
const FULL_CHECK = process.env.NDR_DB_FULL_CHECK === '1'
// Порог размера БД (MB), выше которого скан целостности ПРОПУСКАЕТСЯ по
// умолчанию (инцидент v1.36.2 — см. шапку). 0 — сканировать всегда
// (поведение до v1.36.2); отрицательное/некорректное — дефолт 400.
const rawSkipMb = Number(process.env.DB_HEAL_CHECK_SKIP_MB)
const CHECK_SKIP_MB = Number.isFinite(rawSkipMb) && rawSkipMb >= 0 ? rawSkipMb : 400
const dbBytes = (() => { try { return fs.statSync(dbArg).size } catch { return 0 } })()
const scanSkippedBySize = !FULL_CHECK && CHECK_SKIP_MB > 0 && dbBytes > CHECK_SKIP_MB * 1024 * 1024

function fatal(msg) {
  console.error(`${P} FATAL: ${msg}`)
  process.exit(1)
}

if (!dbArg || !manifestArg) fatal('usage: db-heal.cjs <db-file> <manifest.json>')
if (!fs.existsSync(dbArg)) fatal(`БД не найдена: ${dbArg}`)
if (!fs.existsSync(manifestArg)) fatal(`манифест не найден: ${manifestArg}`)

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestArg, 'utf8'))
} catch (e) {
  fatal(`манифест не читается: ${e.message}`)
}
if (!manifest.tables || typeof manifest.tables !== 'object') fatal('в манифесте нет tables')

// БД задаётся аргументом — жёстко переопределяем DATABASE_URL ДО загрузки клиента
process.env.DATABASE_URL = `file:${dbArg}`
let PrismaClient
try {
  ;({ PrismaClient } = require('@prisma/client'))
} catch (e) {
  fatal(`не удалось загрузить @prisma/client: ${e.message}`)
}

const q = (id) => `"${String(id).replace(/"/g, '""')}"`
const MB = (n) => (n / 1024 / 1024).toFixed(1)
const t0 = Date.now()
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}с`
let exitCode = 0

function log(msg) {
  console.log(`${P} [+${elapsed()}] ${msg}`)
}

// Размеры БД и sidecar-файлов — печатаются ПЕРВЫМИ (инцидент v1.36.0: пустые
// docker logs — невозможно понять, где именно висит инициализация)
function sizeOf(p) {
  try { return MB(fs.statSync(p).size) } catch { return 'нет' }
}

function freeDisk(dir) {
  try { return MB(fs.statfsSync(dir).bavail * fs.statfsSync(dir).bsize) } catch { return '—' }
}

function printHeader() {
  const wal = `${dbArg}-wal`
  const shm = `${dbArg}-shm`
  const mode = FULL_CHECK
    ? 'integrity_check (полный, NDR_DB_FULL_CHECK=1)'
    : scanSkippedBySize
      ? `скан пропускается (БД > ${CHECK_SKIP_MB} MB, DB_HEAL_CHECK_SKIP_MB)`
      : 'quick_check(25)'
  log(`БД: ${dbArg} — ${sizeOf(dbArg)} MB; WAL: ${sizeOf(wal)} MB; SHM: ${sizeOf(shm)} MB; свободно на томе: ${freeDisk(path.dirname(dbArg))} MB`)
  log(`манифест: ${Object.keys(manifest.tables).length} таблиц, ${(manifest.indexes || []).length} индексов; режим скана: ${mode}; таймаут шага: ${STEP_TIMEOUT_MS / 1000}с`)
  if (sizeOf(wal) !== 'нет' && parseFloat(sizeOf(wal)) > parseFloat(sizeOf(dbArg))) {
    log(`ВНИМАНИЕ: WAL больше самой БД — след зависших сборок; после проверки будет выполнен wal_checkpoint(TRUNCATE)`)
  }
}

// Клиент под конкретный файл БД: Prisma читает DATABASE_URL в конструкторе,
// поэтому URL подменяется на время создания клиента. busy_timeout — ждать
// освобождения файла (после таймаута VACUUM/индекса движок может ещё держать
// файл), а не падать мгновенно.
async function clientFor(dbPath) {
  process.env.DATABASE_URL = `file:${dbPath}`
  const c = new PrismaClient()
  try { await c.$executeRawUnsafe('PRAGMA busy_timeout=15000') } catch { /* не критично */ }
  return c
}

/**
 * Жёсткий таймаут тяжёлого шага. Прервать запрос Prisma извне нельзя, поэтому
 * по таймауту шаг помечается пропущенным, его клиент оставляется висеть
 * (движок приберётся при process.exit в конце), а работа продолжается.
 * Возвращает { timedOut, value } — value только если timedOut=false.
 */
async function withTimeout(label, fn) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), STEP_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([
      fn().then((value) => ({ timedOut: false, value })),
      timeout,
    ])
    if (result.timedOut) {
      console.error(`${P} [+${elapsed()}] ТАЙМАУТ ${STEP_TIMEOUT_MS / 1000}с: ${label} — шаг пропущен (БД большая или диск медленный; увеличьте DB_HEAL_TIMEOUT_MS при необходимости)`)
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

// Bounded-скан целостности: quick_check(25) стопорится после 25 проблем
// (быстрый фейл на повреждённой БД); полный integrity_check — по env.
// Открытие БД (clientFor — включая recovery WAL) — ВНУТРИ таймаута: открытие
// гигабайтного wal-файла само по себе может занять минуты.
// Возвращает { ok, problems, timedOut }.
async function checkIntegrity(dbPath) {
  const sql = FULL_CHECK ? 'PRAGMA integrity_check' : 'PRAGMA quick_check(25)'
  try {
    const res = await withTimeout(`скан целостности ${path.basename(dbPath)}`, async () => {
      const c = await clientFor(dbPath)
      try {
        return await c.$queryRawUnsafe(sql)
      } finally {
        try { await c.$disconnect() } catch { /* коннекция уже мертва */ }
      }
    })
    if (res.timedOut) return { ok: false, problems: [], timedOut: true }
    const problems = res.value
      .map((r) => String(Object.values(r)[0]))
      .filter((v) => v !== 'ok')
    return { ok: problems.length === 0, problems, timedOut: false }
  } catch (e) {
    return { ok: false, problems: [String(e?.message ?? e).split('\n')[0]], timedOut: false }
  }
}

// Снимки БД рядом с текущей: <db>.preheal-* и <db>.bak-*. Хвостовые файлы
// -wal/-shm (в т.ч. уехавшие в бэкап под именем <bak>-wal) кандидатами не
// являются — это не самостоятельные БД.
function candidates(dbPath) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  let out
  try {
    out = fs.readdirSync(dir)
      .filter((n) => (n.startsWith(`${base}.preheal-`) || n.startsWith(`${base}.bak-`))
        && !n.endsWith('-wal') && !n.endsWith('-shm'))
      .map((n) => path.join(dir, n))
      .filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, MAX_CANDIDATES)
      .map((x) => x.p)
  } catch {
    out = []
  }
  return out
}

// Восстановление БД из последнего здорового снимка. Возвращает имя снимка
// или null. Снимки с ТАЙМАУТОМ проверки пропускаются (не считаются здоровыми
// — но и не являются доказательством повреждения живой БД).
async function restoreFromSnapshot(dbPath) {
  const list = candidates(dbPath)
  if (list.length === 0) {
    log(`снимков для восстановления нет (${path.basename(dbPath)}.preheal-*, .bak-*)`)
    return null
  }
  log(`найдено снимков: ${list.length} (максимум ${MAX_CANDIDATES}) — проверяю с самого свежего`)
  for (const cand of list) {
    log(`скан снимка ${path.basename(cand)} — ${sizeOf(cand)} MB`)
    const st = await checkIntegrity(cand)
    if (st.timedOut) {
      log(`снимок ${path.basename(cand)} не проверен (таймаут) — пропускаю`)
      continue
    }
    if (!st.ok) {
      log(`снимок ${path.basename(cand)} не прошёл проверку (${st.problems[0]}) — пропускаю`)
      continue
    }
    // Хвостовые -wal/-shm принадлежат КОНКРЕТНОМУ файлу БД: оставленный
    // старый WAL поверх нового файла = «database disk image is malformed».
    for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.rmSync(side, { force: true }) } catch { /* нет файла */ }
    }
    log(`копирую снимок ${path.basename(cand)} → ${path.basename(dbPath)}`)
    fs.copyFileSync(cand, dbPath)
    log(`БД восстановлена из снимка ${path.basename(cand)} (скан: ok)`)
    return path.basename(cand)
  }
  log(`ни один снимок не прошёл проверку`)
  return null
}

// Пытается восстановить БД из последнего здорового снимка; после успешного
// восстановления — повторный скан. Возвращает:
//   true      — БД здорова;
//   'timeout' — повторный скан не уложился: finish(2) уже вызван, caller
//               должен выйти (иначе неверный «повреждена» → код 1);
//   false     — здоровых снимков нет: caller вызывает finishBroken (код 1).
async function tryRestore() {
  const snap = await restoreFromSnapshot(dbArg)
  if (!snap) return false
  log(`повторный скан восстановленной БД…`)
  const recheck = await checkIntegrity(dbArg)
  if (recheck.timedOut) { finish(2, `повторный скан не завершился — БД заменена снимком, запуск продолжается`); return 'timeout' }
  if (!recheck.ok) fatal(`восстановленная БД ${dbArg} тоже повреждена: ${recheck.problems.slice(0, 3).join('; ')}`)
  return true
}

// БД доказанно повреждена и здоровых снимков нет → код 1: entrypoint бэкапит
// файл и создаёт БД из шаблона (единственный сценарий потери «живого» файла —
// с бэкапом, и только по факту проверенного повреждения, никогда по таймауту).
function finishBroken(problems) {
  fatal(`БД ${dbArg} повреждена, здоровых снимков нет: ${problems.join('; ')}. ` +
    'Возможные причины: сервер выключался без завершения записи, не хватало места на диске. ' +
    'Дальше entrypoint бэкапит файл (hub.db.bak-…) и создаёт БД из шаблона.')
}

function columnFragment(c) {
  let frag = `${q(c.name)} ${c.type || 'TEXT'}`
  if (c.notnull && c.dflt !== null) frag += ` NOT NULL DEFAULT ${c.dflt}`
  else if (c.dflt !== null) frag += ` DEFAULT ${c.dflt}`
  else if (c.notnull) log(`ВНИМАНИЕ: колонка ${c.name} NOT NULL без DEFAULT — добавляется как nullable`)
  return frag
}

// Финальная точка: process.exit гарантирует завершение даже если
// откуда-то остался висеть клиент с неотвеченным запросом (после таймаута).
// ВАЖНО: stdout/stderr в pipe (docker logs, child_process) асинхронны —
// без ожидания flush process.exit обрезал хвост диагностики (логи терялись).
// Идемпотентность: после finish(2) из шага промис main() всё равно резолвится,
// и страховочный .then не должен перезаписать код выхода нулём.
let finished = false
function finish(code, extra) {
  if (finished) return
  finished = true
  if (extra) log(extra)
  log(`завершение (код ${code})`)
  let pending = 2
  const dec = () => { if (--pending === 0) process.exit(code) }
  process.stdout.write('', dec)
  process.stderr.write('', dec)
  // предохранитель: если flush не придёт вообще (висящий движок) — выйти силой
  setTimeout(() => process.exit(code), 1000).unref()
}

async function main() {
  printHeader()

  // 1. Быстрая структурная проверка (страница 1 + sqlite_master — миллисекунды):
  //    «malformed» на мастере виден сразу, без полного скана. Свой клиент,
  //    отключается сразу: при последующем восстановлении файл будет подменён
  //    (copyFileSync) — открытый хэндл старого файла остаётся со старым
  //    кэшем страниц, и все следующие запросы через него ломаются.
  let masterOk = true
  {
    // подключение (включая открытие файла/recovery WAL) — ВНУТРИ таймаута:
    // открытие гигабайтного wal-файла может занять минуты
    let res
    try {
      res = await withTimeout('подключение к БД и чтение sqlite_master', async () => {
        const probe = await clientFor(dbArg)
        try {
          return await probe.$queryRawUnsafe("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
        } finally {
          try { await probe.$disconnect() } catch { /* коннекция уже мертва */ }
        }
      })
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (/malformed|corrupt|not a database/i.test(msg)) {
        res = { timedOut: false, error: msg }
      } else {
        finish(2, `чтение sqlite_master не удалось (${msg.split('\n')[0]}) — повреждённость не доказана`)
        return
      }
    }
    if (res.error) {
      masterOk = false
      log(`структурная проверка НЕ ПРОЙДЕНА: ${res.error.split('\n')[0]}`)
    } else if (res.timedOut) {
      // даже чтение мастера не завершилось — файл недоступен/огромный WAL;
      // повреждённость НЕ доказана: пусть сервер стартует и диагностирует
      finish(2, `чтение sqlite_master не завершилось — БД не проверена`)
      return
    } else {
      log(`sqlite_master: ${res.value[0].n} таблиц (объектов)`)
    }
  }

  // 2. Скан целостности (bounded) — ИЛИ путь восстановления, если структурная
  //    проверка уже не прошла (повреждение мастера и так уведено на шаге 1).
  //    ALTER'ы по повреждённой БД запрещены (инцидент №2: «успешная» докатка
  //    на битых страницах и падение приложения на каждом запросе).
  //    v1.36.2: на большой БД скан пропускается (DB_HEAL_CHECK_SKIP_MB), а
  //    тайм-аут скана больше не обрывает скрипт до докатки — докатка схемы
  //    читает только метаданные (sqlite_master, PRAGMA table_info) и не
  //    зависит от страниц данных.
  if (masterOk) {
    if (scanSkippedBySize) {
      log(`скан целостности пропущен: БД ${MB(dbBytes)} MB > порога ${CHECK_SKIP_MB} MB (DB_HEAL_CHECK_SKIP_MB) — на большой БД скан идёт минутами и съедал бюджет рестарта; повреждённость сканом не проверяется, докатка схемы выполняется`)
      log(`полный скан вручную: NDR_DB_FULL_CHECK=1 (запуск с увеличенным DB_HEAL_TIMEOUT_MS, например 600000)`)
    } else {
      log(`скан целостности БД (${FULL_CHECK ? 'integrity_check' : 'quick_check(25)'})…`)
      const health = await checkIntegrity(dbArg)
      if (health.timedOut) {
        // v1.36.2: раньше здесь был finish(2) — докатка не выполнялась, и
        // сервер стартовал на устаревшей схеме (P2022 на всех API). Теперь:
        // повреждённость НЕ доказана (структурная проверка пройдена) —
        // продолжаем с докаткой.
        log(`скан не завершился (таймаут) — повреждённость НЕ доказана, докатку схемы выполняю`)
      } else if (health.ok) {
        log(`скан целостности: ok`)
      } else {
        log(`скан целостности НЕ ПРОЙДЕН: ${health.problems.slice(0, 3).join('; ')}`)
        const restored = await tryRestore()
        if (restored === 'timeout') return
        if (!restored) finishBroken(health.problems.slice(0, 3))
      }
    }
  } else {
    const restored = await tryRestore()
    if (restored === 'timeout') return
    if (!restored) finishBroken([`malformed на sqlite_master`])
  }

  // 3. Сверка схемы с манифестом + докатка. Клиент создаётся ЗДЕСЬ — после
  //    возможной подмены файла при восстановлении (шаг 2): у клиента, открытого
  //    до подмены, кэш страниц старого файла, запросы через него ломаются
  //    (инцидент тестов: «сверка схемы не удалась» сразу после restore).
  //    Подключение — под таймаутом (открытие огромной БД/recovery — минуты).
  //    Каждое изменение — с таймаутом: CREATE INDEX на таблице в миллионы
  //    строк может быть долгим.
  const openRes = await withTimeout('подключение к БД для сверки схемы', () => clientFor(dbArg))
  if (openRes.timedOut) { finish(2, `подключение к БД не завершилось — запуск продолжается`); return }
  const prisma = openRes.value
  try {
    const liveTables = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'"
    )
    const liveSet = new Set(liveTables.map((t) => t.name))

    const actions = []
    for (const [table, def] of Object.entries(manifest.tables)) {
      if (!liveSet.has(table)) {
        actions.push({ sql: def.ddl, log: `добавлена таблица ${table}` })
        continue
      }
      const cols = await prisma.$queryRawUnsafe(`PRAGMA table_info(${q(table)})`)
      const have = new Set(cols.map((c) => c.name))
      for (const c of def.columns || []) {
        if (!have.has(c.name)) {
          actions.push({ sql: `ALTER TABLE ${q(table)} ADD COLUMN ${columnFragment(c)}`, log: `добавлена колонка ${table}.${c.name}` })
        }
      }
    }

    const liveIdx = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='index'")
    const idxSet = new Set(liveIdx.map((i) => i.name))
    for (const idx of manifest.indexes || []) {
      if (!idxSet.has(idx.name)) {
        actions.push({ sql: idx.sql, log: `добавлен индекс ${idx.name} (${idx.table})` })
      }
    }

    if (actions.length > 0) {
      // консистентная копия перед первым изменением (с таймаутом: копия
      // гигабайтной БД на медленном диске — минуты, молчать нельзя).
      // ОТДЕЛЬНЫЙ клиент: VACUUM INTO — только чтение источника, не должен
      // блокировать ALTER'ы основного клиента даже после своего таймаута.
      const backup = `${dbArg}.preheal-${new Date().toISOString().replace(/[:.]/g, '-')}`
      const vacOpen = await withTimeout('подключение для VACUUM INTO', () => clientFor(dbArg))
      if (vacOpen.timedOut) {
        log(`ВНИМАНИЕ: подключение для бэкапа не завершилось — продолжаю без него (данные ALTER'ами не затрагиваются)`)
      } else {
        const vacClient = vacOpen.value
        log(`бэкап перед изменениями (VACUUM INTO)…`)
        try {
          const vac = await withTimeout(`VACUUM INTO ${path.basename(backup)}`, () =>
            vacClient.$executeRawUnsafe(`VACUUM INTO ${q(backup)}`)
          )
          if (vac.timedOut) {
            log(`ВНИМАНИЕ: бэкап VACUUM INTO не завершился — продолжаю без него (данные ALTER'ами не затрагиваются)`)
          } else {
            log(`бэкап до изменений: ${backup}`)
          }
        } catch (e) {
          log(`ВНИМАНИЕ: бэкап VACUUM INTO не удался (${String(e?.message ?? e).split('\n')[0]}) — продолжаю без него`)
        } finally {
          try { await vacClient.$disconnect() } catch { /* коннекция уже мертва */ }
        }
      }

      // Ошибка (не таймаут) ALTER'а — тоже «неопределённость», а не «БД
      // повреждена»: код 2, маркер не пишется, докатка повторится при рестарте
      for (const a of actions) {
        let r
        try {
          r = await withTimeout(a.log, () => prisma.$executeRawUnsafe(a.sql))
        } catch (e) {
          console.error(`${P} докатка не удалась (${a.log}): ${String(e?.message ?? e).split('\n')[0]}`)
          return finish(2)
        }
        if (r.timedOut) {
          console.error(`${P} докатка не завершена (таймаут) — маркер схемы НЕ записывается, проверка повторится при следующем рестарте`)
          return finish(2)
        }
        log(a.log)
      }
      log(`схема докатана: ${actions.length} изменен(ий/ия) — данные сохранены`)
    } else {
      log(`схема актуальна (${Object.keys(manifest.tables).length} таблиц), изменений не требуется`)
    }

    // 4. Подрезка WAL: гигабайтный WAL от зависших сборок замедляет каждый
    //    следующий старт (recovery при открытии) и раздувает том. TRUNCATE —
    //    обнуляет wal-файл; с таймаутом и без обязательности.
    const walPath = `${dbArg}-wal`
    const walBefore = sizeOf(walPath)
    if (walBefore !== 'нет') {
      log(`wal_checkpoint(TRUNCATE): WAL до ${walBefore} MB…`)
      const cp = await withTimeout('wal_checkpoint(TRUNCATE)', () =>
        prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
      )
      if (cp.timedOut) {
        log(`ВНИМАНИЕ: checkpoint не завершился — WAL останется как есть (${walBefore} MB)`)
      } else {
        log(`checkpoint: WAL после — ${sizeOf(walPath)} MB`)
      }
    }
  } catch (e) {
    // Ошибка чтения схемы/мастера — не доказательство повреждения: код 2
    console.error(`${P} сверка схемы не удалась: ${String(e?.message ?? e).split('\n')[0]}`)
    finish(2)
  } finally {
    try { await prisma.$disconnect() } catch { /* коннекция уже мертва */ }
  }

  finish(exitCode, `инициализация БД успешна`)
}

main()
  .then((code) => finish(typeof code === 'number' ? code : exitCode))
  .catch((e) => {
    console.error(`${P} FATAL: ${(e?.message ?? String(e)).split('\n').slice(0, 4).join('; ')}`)
    process.exit(1)
  })
