import { describe, it, expect } from 'vitest'
import { bodyReason, oinkcodeFingerprint, snortFetchError } from '@/lib/engine/fetcher'

describe('fetcher: bodyReason', () => {
  it('извлекает причину из JSON-ответа snort.org', () => {
    // реальный ответ snort.org при отклонённом oinkcode
    expect(bodyReason(Buffer.from('["Invalid oinkcode"]'))).toBe('Invalid oinkcode')
  })
  it('извлекает причину из простого текста/HTML', () => {
    expect(bodyReason(Buffer.from('<html><body> Rate limit exceeded </body></html>'))).toBe('Rate limit exceeded')
  })
  it('пустое тело — null', () => {
    expect(bodyReason(Buffer.from(''))).toBeNull()
  })
})

describe('fetcher: oinkcodeFingerprint', () => {
  it('не задан — прямо об этом говорит', () => {
    expect(oinkcodeFingerprint({})).toContain('НЕ задан')
  })
  it('задан — отпечаток без раскрытия значения', () => {
    const fp = oinkcodeFingerprint({ oinkcode: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' })
    expect(fp).toContain('(40 симв.)')
    expect(fp).toContain('a1b2…a9b0')
    expect(fp).not.toContain('a1b2c3d4e5f6')
  })
})

describe('fetcher: snortFetchError', () => {
  const realCode = { oinkcode: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' }

  it('422 = Invalid oinkcode с подсказкой про Настройки', () => {
    const msg = snortFetchError(422, Buffer.from('["Invalid oinkcode"]'), realCode, 'https://www.snort.org/reg-rules/snortrules-snapshot-3200.tar.gz')
    expect(msg).toContain('HTTP 422')
    expect(msg).toContain('Invalid oinkcode')
    expect(msg).toContain('Настройки')
    expect(msg).toContain('(40 симв.)')
  })
  it('422 без oinkcode — видно, что запрос ушёл без кода', () => {
    const msg = snortFetchError(422, Buffer.from('["Invalid oinkcode"]'), {}, 'https://www.snort.org/reg-rules/x.tar.gz')
    expect(msg).toContain('НЕ задан')
  })
  it('403 — лимит загрузок', () => {
    const msg = snortFetchError(403, Buffer.from('["Forbidden"]'), realCode, 'https://www.snort.org/reg-rules/x.tar.gz')
    expect(msg).toContain('лимит')
  })
  it('429 — слишком частые запросы', () => {
    const msg = snortFetchError(429, Buffer.from(''), realCode, 'https://www.snort.org/reg-rules/x.tar.gz')
    expect(msg).toContain('15-30 минут')
  })
})
