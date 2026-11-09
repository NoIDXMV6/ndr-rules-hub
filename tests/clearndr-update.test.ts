// ─────────────────────────────────────────────────────────────────────────────
// Тесты чистой логики раздела «Обновление Clear NDR»
// (src/lib/engine/clearndr-update.ts — функции без работы с процессами)
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest'
import {
  buildProbeScript,
  buildRunnerScript,
  buildUpdateArgs,
  compareVersions,
  parseProbeOutput,
  parseVersion,
  safeVersionTag,
  sudoPrefix,
  UPDATE_OPTIONS_DEFAULTS,
  updateAvailable,
} from '@/lib/engine/clearndr-update'

describe('версии: parseVersion / compareVersions', () => {
  it('убирает префикс v и сравнивает посегментно', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('1.10.0')).toEqual([1, 10, 0])
    expect(parseVersion('')).toEqual([0, 0, 0])
  })

  it('равенство с v-префиксом и разной длиной', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('числовое (не лексикографическое) сравнение', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
  })

  it('обновление доступно только если релиз строго новее', () => {
    expect(updateAvailable('1.2.3', 'v1.4.0')).toBe(true)
    expect(updateAvailable('1.4.0', '1.4.0')).toBe(false)
    expect(updateAvailable('1.5.0', '1.4.0')).toBe(false)
  })

  it('неизвестные версии → null (решение не принимаем)', () => {
    expect(updateAvailable(undefined, '1.4.0')).toBeNull()
    expect(updateAvailable('1.2.3', undefined)).toBeNull()
    expect(updateAvailable('неизвестна', '1.4.0')).toBeNull()
    expect(updateAvailable('latest', '1.4.0')).toBeNull()
  })
})

describe('safeVersionTag: защита от инъекций в CLI-аргументы', () => {
  it('допускает нормальные теги', () => {
    expect(safeVersionTag('')).toBe('')
    expect(safeVersionTag('latest')).toBe('latest')
    expect(safeVersionTag('v1.2.3')).toBe('v1.2.3')
    expect(safeVersionTag('1.2.3-rc1')).toBe('1.2.3-rc1')
  })

  it('отклоняетshell-метасимволы и пробелы', () => {
    expect(() => safeVersionTag('1.2; rm -rf /')).toThrow()
    expect(() => safeVersionTag('1 2')).toThrow()
    expect(() => safeVersionTag('$(whoami)')).toThrow()
    expect(() => safeVersionTag('1.2.3\n--flag')).toThrow()
  })
})

describe('buildUpdateArgs: опции UI → аргументы clearndr-update.sh', () => {
  it('дефолт: неинтерактивный режим, данные сохраняются, PG — restore', () => {
    const args = buildUpdateArgs(UPDATE_OPTIONS_DEFAULTS)
    expect(args[0]).toBe('--yes')
    expect(args).toContain('--no-color')
    expect(args).toEqual(
      expect.arrayContaining(['--opensearch-data', 'keep', '--pg-strategy', 'restore', '--health-timeout', '600']),
    )
    expect(args).not.toContain('--version') // latest → флаг не передаём
  })

  it('конкретная версия передаётся как --version', () => {
    const args = buildUpdateArgs({ ...UPDATE_OPTIONS_DEFAULTS, version: 'v9.9.9' })
    const i = args.indexOf('--version')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('v9.9.9')
  })

  it('wipe данных opensearch и все флаги', () => {
    const args = buildUpdateArgs({
      ...UPDATE_OPTIONS_DEFAULTS,
      opensearchData: 'wipe',
      updateCli: true,
      skipDbDump: true,
      skipVolume: true,
      fullConfig: true,
      skipMikrocataCheck: true,
    })
    expect(args).toEqual(expect.arrayContaining(['--opensearch-data', 'wipe', '--update-cli', '--skip-db-dump', '--skip-volume', '--full-config', '--skip-mikrocata-check']))
  })

  it('health-timeout зажимается в 60…3600', () => {
    const lo = buildUpdateArgs({ ...UPDATE_OPTIONS_DEFAULTS, healthTimeout: 5 })
    const hi = buildUpdateArgs({ ...UPDATE_OPTIONS_DEFAULTS, healthTimeout: 99999 })
    expect(lo[lo.indexOf('--health-timeout') + 1]).toBe('60')
    expect(hi[hi.indexOf('--health-timeout') + 1]).toBe('3600')
  })

  it('инъекция через версию отклоняется', () => {
    expect(() => buildUpdateArgs({ ...UPDATE_OPTIONS_DEFAULTS, version: '1.0 --no-rollback' })).toThrow()
  })
})

describe('sudoPrefix: повышение прав на хосте', () => {
  it('auto: root напрямую, остальные через sudo -n', () => {
    expect(sudoPrefix('auto', 'root')).toBe('')
    expect(sudoPrefix('auto', 'admin')).toBe('sudo -n ')
  })
  it('явные режимы', () => {
    expect(sudoPrefix('sudo', 'root')).toBe('sudo -n ')
    expect(sudoPrefix('plain', 'admin')).toBe('')
  })
})

describe('parseProbeOutput: разбор вывода probe-скрипта', () => {
  const sample = [
    'stamusctl\tstamusctl version 1.2.0 (build 4f1c)',
    'stack_version\t1.2.3',
    'os_tag\topensearchproject/opensearch:2.5.0',
    'pg_tag\tpostgres:16',
    'suricata_interfaces\ttzsp0',
    'mikrocata\t1',
    'max_map_count\t262144',
    'mem_avail_mb\t7900',
    'docker_root\t/var/lib/docker',
    'disk_free_mb\t41200',
    'web_http\t200',
    'api_http\t200',
    'api_sources\t5',
    'CT\tconfig-scirius-FNISvONwp2TtteCD\tUp 2 minutes (healthy)',
    'CT\tconfig-opensearch-FNISvONwp2TtteCD\tExited (1) 3 minutes ago',
  ].join('\n')

  it('скалярные поля распознаны', () => {
    const p = parseProbeOutput(sample)
    expect(p.stackVersion).toBe('1.2.3')
    expect(p.osTag).toBe('opensearchproject/opensearch:2.5.0')
    expect(p.pgTag).toBe('postgres:16')
    expect(p.suricataInterfaces).toBe('tzsp0')
    expect(p.mikrocata).toBe(true)
    expect(p.maxMapCount).toBe(262144)
    expect(p.memAvailMb).toBe(7900)
    expect(p.diskFreeMb).toBe(41200)
    expect(p.webHttp).toBe('200')
    expect(p.apiSources).toBe('5')
  })

  it('контейнеры: имя, статус, сервис, признак Up', () => {
    const p = parseProbeOutput(sample)
    expect(p.containers).toHaveLength(2)
    const scirius = p.containers![0]
    expect(scirius.name).toBe('config-scirius-FNISvONwp2TtteCD')
    expect(scirius.up).toBe(true)
    expect(scirius.service).toBe('scirius')
    const os = p.containers![1]
    expect(os.up).toBe(false)
    expect(os.status).toContain('Exited')
  })

  it('пустой вывод → пустой probe без падения', () => {
    const p = parseProbeOutput('')
    expect(p.containers).toEqual([])
    expect(p.stackVersion).toBeUndefined()
  })
})

describe('buildRunnerScript: раннер на хосте', () => {
  const cfg = {
    instanceDir: '/opt/ClearNDR',
    scriptPath: '/opt/ClearNDR/clearndr-update.sh',
    args: ['--yes', '--no-color', '--health-timeout', '600'],
    sudo: 'sudo -n ',
    runDir: '/opt/ClearNDR/.hub-update-runs/update-20261109120000',
  }

  it('пишет pid группы, код скрипта в rc и пробрасывает его как exit', () => {
    const s = buildRunnerScript(cfg)
    expect(s).toContain("echo $$ > '/opt/ClearNDR/.hub-update-runs/update-20261109120000/pid'")
    expect(s).toContain("cd '/opt/ClearNDR'")
    expect(s).toContain('RC=$?')
    expect(s).toContain("echo $RC > '/opt/ClearNDR/.hub-update-runs/update-20261109120000/rc'")
    expect(s).toContain('exit $RC')
  })

  it('запускает скрипт с sudo и кавычками вокруг аргументов', () => {
    const s = buildRunnerScript(cfg)
    expect(s).toContain("sudo -n bash '/opt/ClearNDR/clearndr-update.sh' '--yes' '--no-color'")
  })
})

describe('buildProbeScript: probe-скрипт хоста', () => {
  it('содержит проверки версии, контейнеров и web/api', () => {
    const s = buildProbeScript({ instanceDir: '/opt/ClearNDR', healthUrl: 'https://localhost/', apiToken: 'tok123' })
    expect(s).toContain("INSTANCE='/opt/ClearNDR'")
    expect(s).toContain("TOKEN='tok123'")
    expect(s).toContain('vm.max_map_count')
    expect(s).toContain('config version')
    expect(s).toContain('CT\\t{{.Names}}\\t{{.Status}}')
    expect(s).toContain('Authorization: Token $TOKEN')
    expect(s).toContain('/rest/rules/source/')
  })

  it('одинарные кавычки в URL/токене вырезаются (нет инъекций)', () => {
    const s = buildProbeScript({ instanceDir: '/opt/C', healthUrl: "https://h/'x; rm -rf /", apiToken: "to'ken" })
    expect(s).toContain("HEALTH='https://h/x; rm -rf /'") // кавычка вырезана — шелл не сломан
    expect(s).toContain("TOKEN='token'")
    expect(s).not.toContain("''")
  })
})
