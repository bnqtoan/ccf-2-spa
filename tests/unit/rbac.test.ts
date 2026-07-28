// T-22 — logic thuần RBAC (không DB). Khẳng định HÀNH VI authorization:
//   - requireRole: cho qua khi role thuộc danh sách, chặn khi không.
//   - session payload mang role/staffId ký-verify đúng; sửa role → verify fail.
//   - hash mật khẩu PBKDF2: đúng khớp, sai không khớp, constant-time (verify sai fail-closed).
import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  issueSessionToken,
  readSession,
  requireRole,
  verifyPassword,
  verifySessionToken,
  type AuthUser,
} from '../../src/worker/lib/auth.ts'

const SECRET = 'unit-secret'
const NOW = 1_800_000_000

describe('requireRole', () => {
  const owner: AuthUser = { userId: 1, role: 'owner', staffId: null }
  const recep: AuthUser = { userId: 2, role: 'receptionist', staffId: null }
  const ktv: AuthUser = { userId: 3, role: 'technician', staffId: 6 }

  it('cho qua khi role thuộc danh sách', () => {
    expect(requireRole(owner, 'owner')).toBe(true)
    expect(requireRole(recep, 'owner', 'receptionist')).toBe(true)
    expect(requireRole(ktv, 'technician')).toBe(true)
  })

  it('chặn khi role KHÔNG thuộc danh sách', () => {
    expect(requireRole(recep, 'owner')).toBe(false)
    expect(requireRole(ktv, 'owner', 'receptionist')).toBe(false)
  })

  it('user null/undefined → chặn (fail-closed)', () => {
    expect(requireRole(null, 'owner')).toBe(false)
    expect(requireRole(undefined, 'owner', 'receptionist', 'technician')).toBe(false)
  })
})

describe('session payload mang role/staffId', () => {
  it('ký-verify đúng: token owner → readSession trả đúng role/staffId', async () => {
    const user: AuthUser = { userId: 7, role: 'owner', staffId: null }
    const t = await issueSessionToken(SECRET, NOW, 3600, user)
    const got = await readSession(t, SECRET, NOW)
    expect(got).toEqual({ userId: 7, role: 'owner', staffId: null })
  })

  it('technician token mang staffId', async () => {
    const user: AuthUser = { userId: 3, role: 'technician', staffId: 6 }
    const t = await issueSessionToken(SECRET, NOW, 3600, user)
    const got = await readSession(t, SECRET, NOW)
    expect(got).toEqual({ userId: 3, role: 'technician', staffId: 6 })
  })

  it('SỬA role trong token (không ký lại) → verify fail (không giả mạo được role)', async () => {
    const user: AuthUser = { userId: 3, role: 'technician', staffId: 6 }
    const t = await issueSessionToken(SECRET, NOW, 3600, user)
    // Giả mạo: đổi payload thành role owner, giữ chữ ký cũ.
    const [, sig] = t.split('.')
    const forgedPayload = btoa(JSON.stringify({ sub: 'admin', uid: 3, role: 'owner', sid: 6, iat: NOW, exp: NOW + 3600 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const tampered = `${forgedPayload}.${sig}`
    expect(await verifySessionToken(tampered, SECRET, NOW)).toBe(false)
    expect(await readSession(tampered, SECRET, NOW)).toBeNull()
  })

  it('sai secret → readSession null', async () => {
    const t = await issueSessionToken(SECRET, NOW, 3600, { userId: 1, role: 'owner', staffId: null })
    expect(await readSession(t, 'secret-khac', NOW)).toBeNull()
  })

  it('hết hạn → readSession null', async () => {
    const t = await issueSessionToken(SECRET, NOW, 3600, { userId: 1, role: 'owner', staffId: null })
    expect(await readSession(t, SECRET, NOW + 3600)).toBeNull()
  })
})

describe('hashPassword + verifyPassword (PBKDF2)', () => {
  it('đúng mật khẩu → khớp', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPassword('hunter2', hash)).toBe(true)
  })

  it('sai mật khẩu → KHÔNG khớp', async () => {
    const hash = await hashPassword('hunter2')
    expect(await verifyPassword('hunter3', hash)).toBe(false)
  })

  it('cùng mật khẩu, hash khác nhau (salt ngẫu nhiên) nhưng cả hai đều verify đúng', async () => {
    const a = await hashPassword('samepass')
    const b = await hashPassword('samepass')
    expect(a).not.toBe(b)
    expect(await verifyPassword('samepass', a)).toBe(true)
    expect(await verifyPassword('samepass', b)).toBe(true)
  })

  it('hash hỏng/thiếu/định dạng sai → false (fail-closed)', async () => {
    expect(await verifyPassword('x', undefined)).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'pbkdf2$abc$salt$hash')).toBe(false)
    expect(await verifyPassword('', await hashPassword('x'))).toBe(false)
  })
})
