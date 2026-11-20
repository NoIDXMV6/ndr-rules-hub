import { describe, it, expect } from 'vitest'
import { applyAuth, isStamusOpenNrdUrl, parseArchiveText, isGzip, type FetchSourceCfg, type ExtraCfg } from '@/lib/engine/fetcher'
import { SEED_SOURCES, DEFAULT_SETTINGS } from '@/lib/engine/seed'
import { SECRET_SETTING_KEYS } from '@/lib/security/guard'

// Open NRD (Stamus Networks): фиды новых доменов — код лицензии в сегменте пути
// (%%OPENNRD%% в URL), код вводится в «Настройки → Токены источников».

const cfg = (authType: string, url: string): FetchSourceCfg => ({
  id: 's1',
  name: 'test',
  category: 'domain-list',
  kind: 'tarball',
  url,
  authType,
  format: 'auto',
})

describe('isStamusOpenNrdUrl', () => {
  it('распознаёт фиды ti.stamus-networks.io', () => {
    expect(isStamusOpenNrdUrl('https://ti.stamus-networks.io/CODE/sti-domains-nrd-30.tar.gz')).toBe(true)
    expect(isStamusOpenNrdUrl('https://ti.stamus-networks.io/CODE/sti-domains-phishing-14.tar.gz')).toBe(true)
    expect(isStamusOpenNrdUrl('https://www.snort.org/reg-rules/x.tar.gz')).toBe(false)
    expect(isStamusOpenNrdUrl(null)).toBe(false)
    expect(isStamusOpenNrdUrl('not a url')).toBe(false)
  })
})

describe('applyAuth: подстановка кода лицензии Open NRD', () => {
  it('%%OPENNRD%% заменяется кодом лицензии', () => {
    const extra: ExtraCfg = { openNrdCode: 'secret-code-123' }
    const out = applyAuth('https://ti.stamus-networks.io/%%OPENNRD%%/sti-domains-nrd-30.tar.gz', cfg('opennrd', 'x'), extra)
    expect(out).toBe('https://ti.stamus-networks.io/secret-code-123/sti-domains-nrd-30.tar.gz')
  })

  it('код экранируется как компонент пути', () => {
    const out = applyAuth('https://ti.stamus-networks.io/%%OPENNRD%%/x.tar.gz', cfg('opennrd', 'x'), { openNrdCode: 'a b/c' })
    expect(out).toContain('a%20b%2Fc')
  })

  it('без кода URL не меняется (ошибка о отсутствии кода отдаёт движок)', () => {
    const url = 'https://ti.stamus-networks.io/%%OPENNRD%%/sti-domains-nrd-30.tar.gz'
    expect(applyAuth(url, cfg('opennrd', 'x'), {})).toBe(url)
    expect(applyAuth(url, cfg('opennrd', 'x'), { openNrdCode: '  ' })).toBe(url)
  })

  it('другой authType не трогает плейсхолдер Open NRD', () => {
    const url = 'https://ti.stamus-networks.io/%%OPENNRD%%/x.tar.gz'
    expect(applyAuth(url, cfg('none', 'x'), { openNrdCode: 'code' })).toBe(url)
  })
})

describe('parseArchiveText: списки доменов/IP внутри архивов (Open NRD)', () => {
  it('домены конвертируются в DNS-правила', () => {
    const rules = parseArchiveText('malware.example\nphishing.example\n\n# комментарий\nshop.example', 'sti-domains-nrd-30.txt')
    expect(rules.length).toBe(3)
    for (const r of rules) {
      expect(r.raw).toContain('dns.query;')
      expect(r.sid).toBeGreaterThan(0)
    }
    expect(rules.map((r) => r.raw.toLowerCase()).join(' ')).toContain('malware.example')
  })

  it('IP-списки конвертируются чанками (до 500 адресов в правиле)', () => {
    const rules = parseArchiveText('1.2.3.4\n5.6.7.8\n', 'aggressive-ips.txt')
    expect(rules.length).toBe(1) // один чанк на оба адреса
    expect(rules[0].raw).toContain('1.2.3.4')
    expect(rules[0].raw).toContain('5.6.7.8')
  })

  it('.rules файлы разбираются как правила, а не как списки', () => {
    const text = 'alert tcp $HOME_NET any -> $EXTERNAL_NET 443 (msg:"T: x"; sid:9000001; rev:1;)'
    const rules = parseArchiveText(text, 'local.rules')
    expect(rules.length).toBe(1)
    expect(rules[0].sid).toBe(9000001)
  })

  it('gzip-детектор не путает доменный список с архивом', () => {
    expect(isGzip(Buffer.from('malware.example\n'))).toBe(false)
  })
})

describe('каталог: Open NRD и adminOnly-источники', () => {
  it('источник Open NRD присутствует в каталоге с плейсхолдером кода', () => {
    const s = SEED_SOURCES.find((x) => x.name.startsWith('Stamus Open NRD'))
    expect(s).toBeTruthy()
    expect(s!.authType).toBe('opennrd')
    expect(s!.url).toContain('%%OPENNRD%%')
    expect(s!.url).toContain('ti.stamus-networks.io')
    expect(s!.adminOnly).toBeFalsy() // доступен пользователям (код системный)
    expect(s!.badge).toBe('recommended')
  })

  it('ET Pro и MISP-источники помечены adminOnly (скрыты у пользователей)', () => {
    for (const s of SEED_SOURCES) {
      if (s.name.startsWith('ET Pro Ruleset') || s.name.startsWith('MISP Suricata Export') || s.name.startsWith('MISP Attributes')) {
        expect(s.adminOnly, `adminOnly у «${s.name}»`).toBe(true)
      }
    }
  })

  it('бейдж «новый» удалён из каталога — только суть источника', () => {
    for (const s of SEED_SOURCES) {
      // 'new' отсутствует в типе бейджа SeedSource — сравнение с ним не типобезопасно,
      // поэтому проверяем строку-значение (бейджи «new» в каталоге не заданы)
      expect(String(s.badge) === 'new', `бейдж «new» у «${s.name}»`).toBe(false)
    }
    // словарные ключи новых бейджей используются в каталоге
    expect(SEED_SOURCES.some((s) => s.badge === 'traffic')).toBe(true)
    expect(SEED_SOURCES.some((s) => s.badge === 'hunting')).toBe(true)
  })

  it('настройка openNrdLicense существует и является секретом', () => {
    expect('openNrdLicense' in DEFAULT_SETTINGS).toBe(true)
    expect(SECRET_SETTING_KEYS).toContain('openNrdLicense')
  })
})
