// T-19 — logic thuần auth (không DB). Khẳng định hành vi ký/kiểm phiên.
import { describe, expect, it } from 'vitest'
import {
  checkPassword,
  issueSessionToken,
  verifySessionToken,
} from '../../src/worker/lib/auth.ts'

const SECRET = 'unit-secret'
const NOW = 1_800_000_000

describe('checkPassword', () => {
  it('đúng mật khẩu → true', () => {
    expect(checkPassword('hunter2', 'hunter2')).toBe(true)
  })
  it('sai mật khẩu → false', () => {
    expect(checkPassword('hunter2', 'khac')).toBe(false)
  })
  it('secret chưa cấu hình (undefined/rỗng) → luôn false (fail-closed)', () => {
    expect(checkPassword('bat-ky', undefined)).toBe(false)
    expect(checkPassword('bat-ky', '')).toBe(false)
  })
  it('input rỗng/không phải chuỗi → false', () => {
    expect(checkPassword('', 'x')).toBe(false)
    expect(checkPassword(123, 'x')).toBe(false)
    expect(checkPassword(null, 'x')).toBe(false)
  })
})

describe('issueSessionToken + verifySessionToken', () => {
  it('token vừa phát → verify true trong thời hạn', async () => {
    const t = await issueSessionToken(SECRET, NOW, 3600)
    expect(await verifySessionToken(t, SECRET, NOW)).toBe(true)
    expect(await verifySessionToken(t, SECRET, NOW + 3599)).toBe(true)
  })

  it('hết hạn (now >= exp) → false', async () => {
    const t = await issueSessionToken(SECRET, NOW, 3600)
    expect(await verifySessionToken(t, SECRET, NOW + 3600)).toBe(false)
    expect(await verifySessionToken(t, SECRET, NOW + 99999)).toBe(false)
  })

  it('sai secret → false (không giả mạo được chữ ký)', async () => {
    const t = await issueSessionToken(SECRET, NOW, 3600)
    expect(await verifySessionToken(t, 'secret-khac', NOW)).toBe(false)
  })

  it('token bị sửa payload → chữ ký không khớp → false', async () => {
    const t = await issueSessionToken(SECRET, NOW, 3600)
    const [, sig] = t.split('.')
    const tampered = `${btoa('{"sub":"admin","iat":0,"exp":9999999999}')}.${sig}`
    expect(await verifySessionToken(tampered, SECRET, NOW)).toBe(false)
  })

  it('thiếu / rỗng / sai định dạng → false', async () => {
    expect(await verifySessionToken(undefined, SECRET, NOW)).toBe(false)
    expect(await verifySessionToken('', SECRET, NOW)).toBe(false)
    expect(await verifySessionToken('khong-co-cham', SECRET, NOW)).toBe(false)
    expect(await verifySessionToken('.', SECRET, NOW)).toBe(false)
  })

  it('secret server rỗng → verify luôn false (fail-closed)', async () => {
    const t = await issueSessionToken(SECRET, NOW, 3600)
    expect(await verifySessionToken(t, '', NOW)).toBe(false)
    expect(await verifySessionToken(t, undefined, NOW)).toBe(false)
  })
})
