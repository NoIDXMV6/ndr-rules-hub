/**
 * Смоук-тест реанимации/отмены прогонов OSD на реальном коде движка
 * (bun, без БД): local-режим, временный RULES_DATA_DIR.
 *
 * Сценарии:
 *  S1  зависший прогон (pid мёртв, rc отсутствует) → rc=143, meta завершена;
 *  S2  прогон без pid-файла старше 3 минут → rc=143;
 *  S3  живой процесс + cancelOsdRun → процесс убит, rc=143, cancelled=true;
 *  S4  живой прогон (спит 5 c, стартовал только что) → статус active;
 *  S5  pid переиспользован (процесс моложе прогона на часы) → rc=143,
 *      чужой процесс НЕ убивается;
 *  S6  cancelOsdRun при переиспользованном pid → ok, без kill, rc=143.
 * Запуск: bun scripts/test-osd-stale-run.ts
 */
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'osd-stale-'))
process.env.RULES_DATA_DIR = TMP
process.env.CLEARNDR_OSD_ANALYTICS_SCRIPT = '/bin/true'
process.env.CLEARNDR_OSD_IMPORT_SCRIPT = '/bin/true'

const { readOsdRunStatus, cancelOsdRun, OSD_RUNS_DIR } = await import('../src/lib/engine/clearndr-osd')
const cfg = {
  updateMode: 'local' as const,
  instanceDir: TMP,
  scriptPath: '/bin/true',
  osdEsUrl: '',
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok: ${name}`) } else { fail++; console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function mkRun(runId: string, opts: { deadPid?: number; livePid?: number; startedAtMs?: number }) {
  const dir = path.join(OSD_RUNS_DIR, runId)
  await fs.mkdir(dir, { recursive: true })
  const startedAt = new Date(opts.startedAtMs ?? Date.now() - 10 * 60 * 1000).toISOString()
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ runId, mode: 'local', kind: 'import', startedAt, args: ['--yes'] }))
  await fs.writeFile(path.join(dir, 'log.txt'), 'запуск...\n')
  if (opts.deadPid !== undefined) await fs.writeFile(path.join(dir, 'pid.txt'), String(opts.deadPid))
  if (opts.livePid !== undefined) await fs.writeFile(path.join(dir, 'pid.txt'), String(opts.livePid))
  return dir
}
async function alivePid(): Promise<number> {
  // долгоживущий «раннер» — свой же процесс-ребёнок, отдельная группа
  const { spawn } = await import('child_process')
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid ?? 0
}

console.log('S1: зависший прогон (pid мёртв) реанимируется при опросе статуса')
{
  const runId = 'osd-import-20261109215032'
  const dead = await alivePid().then((p) => { process.kill(p, 'SIGKILL'); return p })
  await new Promise((r) => setTimeout(r, 300))
  await mkRun(runId, { deadPid: dead })
  const st = await readOsdRunStatus(cfg as never, runId)
  check('статус не активный', !st.active)
  check('код выхода 143', st.exitCode === 143)
  check('лог содержит пометку hub', st.log.includes('[hub]'))
  const meta = JSON.parse(await fs.readFile(path.join(OSD_RUNS_DIR, runId, 'meta.json'), 'utf8'))
  check('meta завершена', !!meta.finishedAt && meta.exitCode === 143)
  check('rc=143 записан', (await fs.readFile(path.join(OSD_RUNS_DIR, runId, 'rc'), 'utf8')).trim() === '143')
}
console.log('S2: прогон без pid-файла (старше 3 мин) реанимируется')
{
  const runId = 'osd-import-20261110220001'
  await mkRun(runId, { startedAtMs: Date.now() - 10 * 60 * 1000 })
  const st = await readOsdRunStatus(cfg as never, runId)
  check('статус не активный', !st.active)
  check('код выхода 143', st.exitCode === 143)
}
console.log('S3: cancelOsdRun убивает живой процесс и финализирует прогон')
{
  const runId = 'osd-import-20261110220002'
  const live = await alivePid()
  await mkRun(runId, { livePid: live, startedAtMs: Date.now() })
  let alive = true
  try { process.kill(live, 0); alive = true } catch { alive = false }
  check('процесс жив перед отменой', alive)
  const r = await cancelOsdRun(cfg as never, runId)
  check('cancel вернул ok', r.ok === true, r.error)
  await new Promise((r2) => setTimeout(r2, 300))
  let dead = false
  try { process.kill(live, 0) } catch { dead = true }
  check('процесс убит', dead)
  const st = await readOsdRunStatus(cfg as never, runId)
  check('статус не активный', !st.active)
  check('код 143', st.exitCode === 143)
  check('флаг cancelled', st.cancelled === true)
  const meta = JSON.parse(await fs.readFile(path.join(OSD_RUNS_DIR, runId, 'meta.json'), 'utf8'))
  check('meta: cancelled=true', meta.cancelled === true)
}
console.log('S4: живой прогон со свежим стартом остаётся активным')
{
  const runId = 'osd-import-20261110220003'
  const live = await alivePid()
  await mkRun(runId, { livePid: live, startedAtMs: Date.now() - 5_000 })
  const st = await readOsdRunStatus(cfg as never, runId)
  check('статус активный', st.active === true)
  try { process.kill(live, 'SIGKILL') } catch { /* уже мёртв */ }
}
console.log('S5: pid переиспользован (процесс моложе прогона) → прогон реанимируется, чужой процесс жив')
{
  const runId = 'osd-import-20261110220004'
  const live = await alivePid()
  // прогон «стартовал» 13 часов назад, а процесс только что создан —
  // номер pid достался чужому процессу после пересоздания контейнера
  await mkRun(runId, { livePid: live, startedAtMs: Date.now() - 13 * 60 * 60 * 1000 })
  const st = await readOsdRunStatus(cfg as never, runId)
  check('статус не активный', !st.active)
  check('код выхода 143', st.exitCode === 143)
  check('лог: pid принадлежит другому процессу', st.log.includes('переиспользован'))
  let stillAlive = false
  try { process.kill(live, 0); stillAlive = true } catch { stillAlive = false }
  check('чужой процесс не убит опросом статуса', stillAlive)
  try { process.kill(live, 'SIGKILL') } catch { /* уже мёртв */ }
}
console.log('S6: cancelOsdRun при переиспользованном pid — без kill, прогон финализирован')
{
  const runId = 'osd-import-20261110220005'
  const live = await alivePid()
  await mkRun(runId, { livePid: live, startedAtMs: Date.now() - 13 * 60 * 60 * 1000 })
  const r = await cancelOsdRun(cfg as never, runId)
  check('cancel вернул ok', r.ok === true, r.error)
  let stillAlive = false
  try { process.kill(live, 0); stillAlive = true } catch { stillAlive = false }
  check('чужой процесс НЕ убит отменой', stillAlive)
  const st = await readOsdRunStatus(cfg as never, runId)
  check('статус не активный', !st.active)
  check('флаг cancelled', st.cancelled === true)
  const meta = JSON.parse(await fs.readFile(path.join(OSD_RUNS_DIR, runId, 'meta.json'), 'utf8'))
  check('meta: cancelled=true', meta.cancelled === true)
  try { process.kill(live, 'SIGKILL') } catch { /* уже мёртв */ }
}

await fs.rm(TMP, { recursive: true, force: true })
console.log(`\nИТОГО: ok=${pass}, fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
