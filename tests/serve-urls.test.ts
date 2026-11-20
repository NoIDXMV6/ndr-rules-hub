import { describe, it, expect } from 'vitest'
import { dnsExportUrl, rulesExportUrls } from '@/lib/serve-urls'

// Готовые Uri отдачи для плашки после создания токена (v1.33.0):
//  • правила Suricata — Uri БЕЗ токена (токен передаётся полем
//    «Optional authorization key» источника Clear NDR);
//  • список заблокированных доменов — ПОЛНЫЙ Uri С токеном (?token=…):
//    список забирают любые DNS-серверы с обновлением списков по ссылке
//    (AdGuard Home, Pi-hole, Blocky, dnsmasq…), отдельного поля для токена
//    у них нет.

describe('rulesExportUrls: Uri правил для Clear NDR (без токена)', () => {
  it('файл и архив собираются из origin, токен в Uri не входит', () => {
    const u = rulesExportUrls('http://hub.local:3080')
    expect(u.file).toBe('http://hub.local:3080/api/export')
    expect(u.archive).toBe('http://hub.local:3080/api/export?archive=1')
    expect(u.file).not.toContain('token')
    expect(u.archive).not.toContain('token')
  })

  it('хвостовой слэш origin срезается (без двойного //)', () => {
    const u = rulesExportUrls('http://hub.local:3080/')
    expect(u.file).toBe('http://hub.local:3080/api/export')
    expect(u.archive).toBe('http://hub.local:3080/api/export?archive=1')
  })

  it('пробелы вокруг origin обрезаются', () => {
    const u = rulesExportUrls('  https://hub.example.com  ')
    expect(u.file).toBe('https://hub.example.com/api/export')
  })
})

describe('dnsExportUrl: ПОЛНЫЙ Uri списка доменов (токен в адресе)', () => {
  const token = 'ndrt_d6Da67FKjEq66MlOq2c09-mhEAIQvU7aCz-VytaZTDw'

  it('токен входит в адрес как query-параметр ?token=', () => {
    const u = dnsExportUrl('http://hub.local:3080', token)
    expect(u).toBe(`http://hub.local:3080/api/dns/export?token=${token}`)
    expect(u).toContain('/api/dns/export')
  })

  it('токен URL-кодируется, если содержит спецсимволы', () => {
    const u = dnsExportUrl('http://hub.local:3080', 'ndrt_a+b/c=d')
    expect(u).toBe('http://hub.local:3080/api/dns/export?token=ndrt_a%2Bb%2Fc%3Dd')
    // при этом адрес остаётся самодостаточным: один query-параметр
    expect(u.split('?').length).toBe(2)
  })

  it('хвостовой слэш origin срезается', () => {
    expect(dnsExportUrl('http://hub.local:3080/', token)).toBe(`http://hub.local:3080/api/dns/export?token=${token}`)
  })

  it('разные origin дают разные адреса (адрес собирается из текущего окна)', () => {
    expect(dnsExportUrl('http://localhost:3000', token)).toContain('http://localhost:3000')
    expect(dnsExportUrl('http://192.168.1.10:3080', token)).toContain('http://192.168.1.10:3080')
  })
})
