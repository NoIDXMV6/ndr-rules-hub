#!/usr/bin/env node
// ============================================================================
// db-heal.cjs — докатка схемы БД тома до схемы образа, БЕЗ потери данных.
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
//   - отсутствующий индекс   → CREATE INDEX (best-effort: на таблице в миллионы
//     строк индекс строится минутами, его таймаут НЕ проваливает запуск).
//
// ГЛАВНЫЙ ПРИНЦИП (v1.39.0): докатка схемы — операции МЕТАДАННЫХ (sqlite_master,
// PRAGMA table_info, CREATE TABLE, ADD COLUMN). Они не читают страницы данных,
// выполняются за миллисекунды и не требуют бэкапа. Любая тяжёлая работа
// (скан целостности, восстановление) — только по явным доказательствам
// повреждения или вручную через env.
//
// ИНЦИДЕНТ v1.39.0 (продакшен, 10 дней): на БД 1.3 GB докатка схемы не
// выполнялась НИ РАЗУ с v1.37: перед ALTER'ами запускался «предохранительный»
// VACUUM INTO (копия БД), он не укладывался в 90с, шаг помечался пропущенным,
// но брошенный запрос продолжал выполняться в фоне — и `await
// vacClient.$disconnect()` в finally ждал его завершения МИНУТАМИ. Глобальный
// таймаут рестарта (300с) убивал процесс ДО ALTER'ов. Итог: недостающая
// таблица не создавалась НИКОГДА, при каждом рестарте всё повторялось,
// рядом копились частичные .preheal-копии (8 файлов ≈ 2.9 GB) с горячими
// -journal. Лечение (этот файл):
//   • VACUUM INTO ПЕРЕД докаткой УДАЛЁН как класс: метаданные не нуждаются
//     в бэкапе, а на большой БД он гарантированно не укладывался в бюджет
//     и блокировал саму докатку. Полная консистентная копия — вручную, при
//     остановленном приложении: sqlite3 hub.db "VACUUM INTO '/путь/копия.db'";
//   • по таймауту шага клиент НЕ.disconnect() (брошенный запрос нельзя
//     дождаться) — процесс просто завершается, движок прибирается сам;
//   • докатка выполняется ВСЕГДА и первой; таймаут одного ALTER'а — сигнал
//     «не успел» (код 2), повтор при следующем рестарте — как и раньше;
//   • уборка мусора: частичные .preheal-копии (с горячим -journal) удаляются
//     всегда, сверх двух свежих — тоже (два последних снимка остаются
//     кандидатами восстановления);
//   • при актуальной схеме весь проход занимает секунды на БД любого размера.
//
// ПРЕДЫДУЩИЕ ИНЦИДЕНТЫ (v1.36.0, v1.36.2) — сохранены уроки:
//   • логи печатаются ПЕРВЫМИ (размеры БД/WAL, режим скана) — «пустые docker
//     logs» больше невозможны;
//   • скан целостности пропускается на БД больше DB_HEAL_CHECK_SKIP_MB
//     (дефолт 400 MB) — полный скан вручную: NDR_DB_FULL_CHECK=1
//     (+ увеличенный DB_HEAL_TIMEOUT_MS);
//   • тайм-ауты не означают повреждение: код 2 («не успел/не доказано») —
//     entrypoint запускает сервер с существующей БД; код 1 — ТОЛЬКО по
//     доказанному повреждению (quick_check/integrity_check со структурной
//     проверкой мастера) и только когда ни один снимок не здоров;
//   • каждый тяжёлый шаг — со своим таймаутом (DB_HEAL_TIMEOUT_MS, дефолт 90с);
//   • после успешного прохода — wal_checkpoint(TRUNCATE) подрезает WAL,
//     оставшийся от зависших сборок (best-effort, с таймаутом).
// ============================================================================
const fs = require('fs')
const path = require('path')

const P = '[db-heal]'
const dbArg = process.argv[2]
const manifestArg = process.argv[3]
// сколько самых свежих снимков проверять; каждый — со своим таймаутом
const MAX_CANDIDATES = 5
// таймаут ОДНОГО тяжёлого шага (скан, снапшот, ALTER, индекс);
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
// сколько свежих .preheal-снимков хранить как кандидатов восстановления
const KEEP_PREHEAL = 2
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
 * Отключить клиент, НЕ дожидаясь зависших запросов: $disconnect на клиенте
 * с выполняющимся запросом ждёт его завершения (инцидент v1.39.0 — так
 * докатка схемы не выполнялась неделями). Гонка с коротким таймером: что
 * раньше — disconnect или 2с; брошенный движок прибирается при process.exit.
 */
async function detachQuietly(client) {
  if (!client) return
  await Promise.race([
    client.$disconnect().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2000).unref()),
  ])
}

/**
 * Жёсткий таймаут тяжёлого шага. Прервать запрос Prisma извне нельзя, поэтому
 * по таймауту шаг помечается пропущенным, клиент БРОСАЕТСЯ (не disconnect! —
 * см. detachQuietly/шапку), а работа продолжается.
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
  let client = null
  try {
    const res = await withTimeout(`скан целостности ${path.basename(dbPath)}`, async () => {
      client = await clientFor(dbPath)
      return await client.$queryRawUnsafe(sql)
    })
    if (res.timedOut) return { ok: false, problems: [], timedOut: true }
    const problems = res.value
      .map((r) => String(Object.values(r)[0]))
      .filter((v) => v !== 'ok')
    return { ok: problems.length === 0, problems, timedOut: false }
  } catch (e) {
    return { ok: false, problems: [String(e?.message ?? e).split('\n')[0]], timedOut: false }
  } finally {
    await detachQuietly(client)
  }
}

// Снимки БД рядом с текущей: <db>.preheal-* и <db>.bak-*. Хвостовые файлы
// -wal/-shm/-journal (в т.ч. уехавшие в бэкап под именем <bak>-wal) кандидатами
// не являются — это не самостоятельные БД.
function candidates(dbPath) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  let out
  try {
    out = fs.readdirSync(dir)
      .filter((n) => (n.startsWith(`${base}.preheal-`) || n.startsWith(`${base}.bak-`))
        && !n.endsWith('-wal') && !n.endsWith('-shm') && !n.endsWith('-journal'))
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

/**
 * Уборка мусора прежних попыток «бэкапа перед изменениями» (v1.39.0):
 *  • .preheal-копия с соседним -journal — частичный файл прерванного
 *    VACUUM INTO (горячий журнал), не снимок: удаляется ВСЕГДА вместе с
 *    журналом (открытие такого файла — только лишний recovery);
 *  • сверх KEEP_PREHEAL самых свежих .preheal-копий — тоже удаляются
 *    (кандидаты восстановления — два последних), остальное — мусор недель;
 *  • рядом с любыми снимками удаляются хвостовые -journal/-wal/-shm.
 * .bak-* (бэкапы entrypoint при подмене БД шаблоном) не трогаются никогда.
 */
function cleanupPartialSnapshots(dbPath) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  let preheals = []
  try {
    preheals = fs.readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.preheal-`)
        && !n.endsWith('-wal') && !n.endsWith('-shm') && !n.endsWith('-journal'))
      .map((n) => path.join(dir, n))
      .filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map((x) => x.p)
  } catch { return }
  let removed = 0
  const rm = (p) => {
    try { fs.rmSync(p, { force: true }); removed++ } catch { /* занят/нет файла */ }
  }
  preheals.forEach((p, i) => {
    const partial = fs.existsSync(`${p}-journal`) // горячий журнал = прерванный VACUUM INTO
    if (partial || i >= KEEP_PREHEAL) {
      rm(p)
      rm(`${p}-journal`)
      log(partial
        ? `убрана частичная копия ${path.basename(p)} (прерванный VACUUM INTO, горячий журнал) — снимком не является`
        : `убрана старая копия ${path.basename(p)} (хранятся ${KEEP_PREHEAL} свежих как кандидаты восстановления)`)
    }
  })
  // хвостовые журналы у выживших снимков — восстановлению не помогают
  for (const p of preheals.slice(0, KEEP_PREHEAL)) {
    for (const suf of ['-journal', '-wal', '-shm']) {
      try { if (fs.existsSync(`${p}${suf}`)) fs.rmSync(`${p}${suf}`, { force: true }) } catch { /* нет файла */ }
    }
  }
  if (removed > 0) log(`очистка мусора: удалено файлов ${removed}, освобождено место на томе`)
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

  // 0. Мусор прежних прогонов убирается ДО любой проверки: частичные копии
  //    прерванных VACUUM INTO (v1.39.0) — не снимки и места не должны занимать.
  cleanupPartialSnapshots(dbArg)

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
    let probe = null
    try {
      res = await withTimeout('подключение к БД и чтение sqlite_master', async () => {
        probe = await clientFor(dbArg)
        return await probe.$queryRawUnsafe("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
      })
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (/malformed|corrupt|not a database/i.test(msg)) {
        res = { timedOut: false, error: msg }
      } else {
        finish(2, `чтение sqlite_master не удалось (${msg.split('\n')[0]}) — повреждённость не доказана`)
        return
      }
    } finally {
      await detachQuietly(probe)
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
  //    ДОКАТКА БЕЗ ПРЕДВАРИТЕЛЬНОГО БЭКАПА (v1.39.0): CREATE TABLE и
  //    ADD COLUMN — операции метаданных, страницы данных не трогают; бэкап
  //    перед ними был балластом, который на большой БД съедал весь бюджет
  //    рестарта и блокировал саму докатку (см. шапку).
  const openRes = await withTimeout('подключение к БД для сверки схемы', () => clientFor(dbArg))
  if (openRes.timedOut) { finish(2, `подключение к БД не завершилось — запуск продолжается`); return }
  const prisma = openRes.value
  let indexPending = 0
  try {
    const liveTables = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'"
    )
    const liveSet = new Set(liveTables.map((t) => t.name))

    const actions = []
    const indexActions = []
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
        // CREATE INDEX на таблице в миллионы строк — минуты: отдельно,
        // best-effort — таймаут индекса НЕ проваливает запуск (схема
        // работоспособна и без него, докатка повторится при рестарте)
        indexActions.push({ sql: idx.sql, log: `добавлен индекс ${idx.name} (${idx.table})` })
      }
    }

    if (actions.length > 0 || indexActions.length > 0) {
      log(`схема отстаёт от манифеста: таблиц/колонок — ${actions.length}, индексов — ${indexActions.length}`)
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
    if (actions.length > 0) log(`структура схемы докатана: ${actions.length} изменен(ий/ия) — данные сохранены`)

    // Индексы — best-effort: на большой таблице долгие, но не критичные
    for (const a of indexActions) {
      let r
      try {
        r = await withTimeout(a.log, () => prisma.$executeRawUnsafe(a.sql))
      } catch (e) {
        log(`индекс не создан (${a.log}): ${String(e?.message ?? e).split('\n')[0]} — некритично, повтор при рестарте`)
        indexPending++
        continue
      }
      if (r.timedOut) {
        log(`индекс не создан за таймаут (${a.log}) — некритично, повтор при рестарте`)
        indexPending++
        continue
      }
      log(a.log)
    }
    if (actions.length === 0 && indexActions.length === 0) {
      log(`схема актуальна (${Object.keys(manifest.tables).length} таблиц), изменений не требуется`)
    } else if (indexPending > 0) {
      log(`докатка завершена (индексов отложено: ${indexPending} — создадутся при следующем рестарте)`)
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
    // НЕ ждем зависших запросов: disconnect — в гонке с 2с (v1.39.0)
    await detachQuietly(prisma)
  }

  finish(exitCode, `инициализация БД успешна`)
}

main()
  .then((code) => finish(typeof code === 'number' ? code : exitCode))
  .catch((e) => {
    console.error(`${P} FATAL: ${(e?.message ?? String(e)).split('\n').slice(0, 4).join('; ')}`)
    process.exit(1)
  })
