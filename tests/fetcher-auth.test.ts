import { describe, it, expect } from 'vitest'
import { applyAuth, isGzip, bodyReason, notArchiveError, FetchSourceCfg, ExtraCfg } from '@/lib/engine/fetcher'

// Фейковый код: в тестах настоящий oinkcode не используется
const CODE = '0123456789abcdef0123456789abcdef01234567'

const oinkCfg = (url: string): FetchSourceCfg => ({
  id: 'x', name: 'x', category: 'ruleset', kind: 'tarball', url, authType: 'oinkcode', format: 'auto',
})
const oinkExtra = (): ExtraCfg => ({ oinkcode: CODE })

describe('fetcher: applyAuth — ссылки личного кабинета → каноническая форма', () => {
  it('downloads/registered → www.snort.org/reg-rules/<файл>/<код>', () => {
    const url = applyAuth('https://snort.org/downloads/registered/snortrules-snapshot-3200.tar.gz', oinkCfg('u'), oinkExtra())
    expect(url).toBe(`https://www.snort.org/reg-rules/snortrules-snapshot-3200.tar.gz/${CODE}`)
  })

  it('www + downloads/subscribed тоже нормализуется', () => {
    const url = applyAuth('https://www.snort.org/downloads/subscribed/snortrules-snapshot-3200.tar.gz', oinkCfg('u'), oinkExtra())
    expect(url).toBe(`https://www.snort.org/reg-rules/snortrules-snapshot-3200.tar.gz/${CODE}`)
  })

  it('query (?oinkcode=…) у ссылки кабинета отбрасывается', () => {
    const url = applyAuth(`https://snort.org/downloads/registered/Talos_LightSPD.tar.gz?oinkcode=${CODE}`, oinkCfg('u'), oinkExtra())
    expect(url).toBe(`https://www.snort.org/reg-rules/Talos_LightSPD.tar.gz/${CODE}`)
  })

  it('reg-rules без кода в пути → код дописывается сегментом', () => {
    const url = applyAuth('https://www.snort.org/reg-rules/snortrules-snapshot-29200.tar.gz', oinkCfg('u'), oinkExtra())
    expect(url).toBe(`https://www.snort.org/reg-rules/snortrules-snapshot-29200.tar.gz/${CODE}`)
  })

  it('reg-rules с чужим query — query срезается, сегмент дописан', () => {
    const url = applyAuth('https://www.snort.org/reg-rules/snortrules-snapshot-3200.tar.gz?oinkcode=OLD', oinkCfg('u'), oinkExtra())
    expect(url).toBe(`https://www.snort.org/reg-rules/snortrules-snapshot-3200.tar.gz/${CODE}`)
    expect(url).not.toContain('OLD')
  })

  it('посторонний сайт — oinkcode в query (обратная совместимость)', () => {
    const url = applyAuth('https://example.com/feed.tar.gz', oinkCfg('u'), oinkExtra())
    expect(url).toBe(`https://example.com/feed.tar.gz?oinkcode=${CODE}`)
  })

  it('authType none / пустой код — URL не меняется', () => {
    const none = applyAuth('https://snort.org/downloads/registered/x.tar.gz', { ...oinkCfg('u'), authType: 'none' }, oinkExtra())
    expect(none).toBe('https://snort.org/downloads/registered/x.tar.gz')
    const empty = applyAuth('https://www.snort.org/reg-rules/x.tar.gz', oinkCfg('u'), {})
    expect(empty).toBe('https://www.snort.org/reg-rules/x.tar.gz')
  })
})

describe('fetcher: isGzip', () => {
  it('магия 1f8b распознаётся', () => {
    expect(isGzip(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(true)
  })
  it('HTML/пустое тело — не gzip', () => {
    expect(isGzip(Buffer.from('<!DOCTYPE html>'))).toBe(false)
    expect(isGzip(Buffer.alloc(0))).toBe(false)
  })
})

describe('fetcher: bodyReason', () => {
  it('HTML → заголовок страницы', () => {
    const r = bodyReason(Buffer.from('<html><head><title>Snort.Org 404</title></head><body>x</body></html>'))
    expect(r).toBe('Snort.Org 404')
  })
  it('JSON-массив snort.org → текст причины', () => {
    expect(bodyReason(Buffer.from('["Invalid oinkcode"]'))).toBe('Invalid oinkcode')
  })
  it('бинарное тело (gzip) → null, без бинарного мусора', () => {
    expect(bodyReason(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x9a, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00, 0x07]))).toBeNull()
  })
  it('пустое тело → null', () => {
    expect(bodyReason(Buffer.alloc(0))).toBeNull()
  })
})

describe('fetcher: notArchiveError', () => {
  const html = Buffer.from('<!DOCTYPE html><html><head><title>Snort - Network IDS</title></head></html>')
  it('snort-вариант: подсказка про лимит/форму ссылки, код не раскрывается', () => {
    const msg = notArchiveError(200, html, oinkExtra(), 'https://snort.org/downloads/registered/x.tar.gz', true)
    expect(msg).toContain('не gzip-содержимое')
    expect(msg).toContain('Snort - Network IDS')
    expect(msg).toContain('15 минут')
    expect(msg).toContain('0123…4567')
    expect(msg).not.toContain(CODE)
  })
  it('чужой источник: без snort-подсказок', () => {
    const msg = notArchiveError(200, html, {}, 'https://example.com/x.tar.gz', false)
    expect(msg).toContain('источник: HTTP 200')
    expect(msg).not.toContain('oinkcode')
  })
})
