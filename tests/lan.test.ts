import { describe, it, expect } from 'vitest'
import { isLanIp } from '@/lib/security/lan'

// isLanIp — определение «локального» адреса для аварийного сброса 2FA:
// приватные диапазоны IPv4 (RFC 1918), loopback, link-local, CGNAT, IPv6 ULA/link-local.
// Публичные адреса — всегда false (из интернета сброс недоступен).

describe('isLanIp: IPv4 приватные диапазоны', () => {
  const lan: Array<[string, string]> = [
    ['10.0.0.1', '10/8 начало'],
    ['10.255.255.255', '10/8 конец'],
    ['192.168.0.1', '192.168/16 начало'],
    ['192.168.255.254', '192.168/16 конец'],
    ['172.16.0.1', '172.16/12 начало'],
    ['172.31.255.254', '172.31/12 конец (docker-сети)'],
    ['127.0.0.1', 'loopback'],
    ['127.8.8.8', 'loopback 127/8'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'CGNAT начало'],
    ['100.127.255.254', 'CGNAT конец'],
    ['172.17.0.1', 'docker0 по умолчанию'],
  ]
  for (const [ip, name] of lan) {
    it(`${ip} — LAN (${name})`, () => expect(isLanIp(ip)).toBe(true))
  }

  const wan: Array<[string, string]> = [
    ['93.184.216.34', 'публичный'],
    ['8.8.8.8', 'публичный DNS'],
    ['172.32.0.1', 'за границей 172.16/12'],
    ['172.15.255.255', 'ниже 172.16/12'],
    ['192.169.0.1', 'соседний с 192.168/16'],
    ['11.0.0.1', 'публичный 11/8'],
    ['100.63.255.255', 'ниже CGNAT'],
    ['100.128.0.1', 'выше CGNAT'],
    ['169.253.1.1', 'соседний с link-local'],
    ['9.9.9.9', 'публичный'],
  ]
  for (const [ip, name] of wan) {
    it(`${ip} — не LAN (${name})`, () => expect(isLanIp(ip)).toBe(false))
  }
})

describe('isLanIp: IPv6', () => {
  it('::1 — loopback', () => expect(isLanIp('::1')).toBe(true))
  it('fe80::1 — link-local', () => expect(isLanIp('fe80::1')).toBe(true))
  it('fe80::1%eth0 — зона отбрасывается', () => expect(isLanIp('fe80::1%eth0')).toBe(true))
  it('fd00::5 — ULA', () => expect(isLanIp('fd00::5')).toBe(true))
  it('fc00::1 — ULA', () => expect(isLanIp('fc00::1')).toBe(true))
  it('febf::1 — край link-local', () => expect(isLanIp('febf::1')).toBe(true))
  it('fec0::1 — вне link-local', () => expect(isLanIp('fec0::1')).toBe(false))
  it('fdbf::1 — ULA (fc00::/7 покрывает fc00–fdff)', () => expect(isLanIp('fdbf::1')).toBe(true))
  it('fe00::1 — вне link-local', () => expect(isLanIp('fe00::1')).toBe(false))
  it('2001:db8::1 — публичный', () => expect(isLanIp('2001:db8::1')).toBe(false))
  it('2606:4700::1 — публичный', () => expect(isLanIp('2606:4700::1')).toBe(false))
  it('::ffff:192.168.1.10 — IPv4-совместимая запись', () => expect(isLanIp('::ffff:192.168.1.10')).toBe(true))
  it('::ffff:8.8.8.8 — публичный в совместимой записи', () => expect(isLanIp('::ffff:8.8.8.8')).toBe(false))
  it('64:ff9b::10.0.0.1 — NAT64 считается публичным', () => expect(isLanIp('64:ff9b::10.0.0.1')).toBe(false))
})

describe('isLanIp: граничные случаи', () => {
  it("'local' — прямое соединение без прокси (с хоста)", () => expect(isLanIp('local')).toBe(true))
  it("пустая строка — считается хостом", () => expect(isLanIp('')).toBe(true))
  it('хостнейм — не LAN', () => expect(isLanIp('hub.example.com')).toBe(false))
  it('мусор — не LAN', () => expect(isLanIp('999.999.999.999')).toBe(false))
  it('некорректный IPv6 (::1::2) — не LAN', () => expect(isLanIp('::1::2')).toBe(false))
  it('регистр не важен (FE80::1)', () => expect(isLanIp('FE80::1')).toBe(true))
})
