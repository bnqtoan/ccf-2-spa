// T-19 — logic thuần auth (không DB). Khẳng định hành vi ký/kiểm phiên.
import { describe, expect, it } from 'vitest'
import {
  issueSessionToken,
  verifySessionToken,
} from '../../src/worker/lib/auth.ts'

const SECRET = 'unit-secret'
const NOW = 1_800_000_000

// Mật khẩu đăng nhập giờ so với hash trong bảng `users` (verifyPassword, có test
// ở tests/api/rbac.test.ts + auth.test.ts). Hàm checkPassword cũ (so mật khẩu
// chung ADMIN_PASSWORD của T-19) đã BỎ khi T-22 chuyển sang RBAC nhiều user.

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
