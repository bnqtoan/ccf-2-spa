// T-19 — cổng auth admin. Khẳng định HÀNH VI nghiệp vụ (§8):
//   - mọi /api/admin/* thiếu/sai phiên → 401 UNAUTHORIZED
//   - có phiên hợp lệ → guard cho qua (route chạy như cũ, KHÔNG 401)
//   - route khách + webhook payment KHÔNG bị guard admin chặn (vẫn public)
//   - login sai mật khẩu → 401; login đúng → nhận cookie phiên dùng được
//
// Env test (ADMIN_PASSWORD='test-admin-pw', SESSION_SECRET='test-session-secret')
// đến từ miniflare.bindings trong vitest.config.ts — cùng pattern payment secrets.
// Token hợp lệ được ký bằng CHÍNH lib thuần (issueSessionToken) với đúng secret
// đó, rồi gắn vào header Cookie.

import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import migration0001 from '../../migrations/0001_init.sql?raw'
import migration0003 from '../../migrations/0003_payments.sql?raw'
import migration0004 from '../../migrations/0004_users.sql?raw'
import { SESSION_COOKIE, hashPassword, issueSessionToken } from '../../src/worker/lib/auth.ts'

const db = env.DB

function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

beforeAll(async () => {
  for (const stmt of splitStatements(migration0001)) await db.prepare(stmt).run()
  for (const stmt of splitStatements(migration0003)) await db.prepare(stmt).run()
  for (const stmt of splitStatements(migration0004)) await db.prepare(stmt).run()
  // T-22 — login nay là username+password tra bảng users. Seed 1 owner với mật
  // khẩu = ADMIN_PASSWORD test ('test-admin-pw', khớp vitest.config.ts).
  await db.prepare('DELETE FROM users').run()
  const hash = await hashPassword('test-admin-pw')
  await db
    .prepare("INSERT INTO users (username, password_hash, role, staff_id, active, created_at) VALUES ('owner', ?, 'owner', NULL, 1, 0)")
    .bind(hash)
    .run()
})

const BASE = 'https://example.com'
const SECRET = 'test-session-secret' // khớp vitest.config.ts miniflare.bindings

async function validCookie(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const token = await issueSessionToken(SECRET, now)
  return `${SESSION_COOKIE}=${token}`
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  return exports.default.fetch(`${BASE}${path}`, { headers })
}

// Đại diện mỗi nhóm route admin (card yêu cầu ≥1 case mỗi nhóm).
const ADMIN_GET_ROUTES = [
  '/api/admin/schedule?date=2099-01-01', // schedule
  '/api/admin/reassign-queue', // reassign / time-off
  '/api/admin/overview?date=2099-01-01', // overview (doanh thu/lương)
  '/api/admin/staff', // setup (nhân viên)
]

describe('cổng auth admin — chặn khi thiếu/sai phiên', () => {
  it('mọi /api/admin/* KHÔNG có cookie → 401 UNAUTHORIZED', async () => {
    for (const path of ADMIN_GET_ROUTES) {
      const res = await get(path)
      expect(res.status, `route ${path} phải 401 khi chưa đăng nhập`).toBe(401)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('UNAUTHORIZED')
    }
  })

  it('cookie phiên có chữ ký SAI → vẫn 401', async () => {
    const now = Math.floor(Date.now() / 1000)
    const forged = await issueSessionToken('khong-phai-secret-that', now)
    const res = await get('/api/admin/reassign-queue', `${SESSION_COOKIE}=${forged}`)
    expect(res.status).toBe(401)
  })

  it('cookie phiên ĐÃ HẾT HẠN → 401', async () => {
    // exp trong quá khứ: ký với now cách đây 2 giờ, TTL 1 giờ.
    const past = Math.floor(Date.now() / 1000) - 2 * 60 * 60
    const expired = await issueSessionToken(SECRET, past, 60 * 60)
    const res = await get('/api/admin/reassign-queue', `${SESSION_COOKIE}=${expired}`)
    expect(res.status).toBe(401)
  })
})

describe('cổng auth admin — cho qua khi phiên hợp lệ', () => {
  it('có cookie hợp lệ → guard KHÔNG chặn, route chạy như cũ', async () => {
    const cookie = await validCookie()
    const res = await get('/api/admin/reassign-queue', cookie)
    // Không phải 401 (guard cho qua). DB rỗng → route trả 200 { items: [] }.
    expect(res.status).not.toBe(401)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items?: unknown[] }
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('mọi nhóm admin đều cho qua guard (không 401) với phiên hợp lệ', async () => {
    const cookie = await validCookie()
    for (const path of ADMIN_GET_ROUTES) {
      const res = await get(path, cookie)
      expect(res.status, `route ${path} không được 401 khi đã đăng nhập`).not.toBe(401)
    }
  })
})

describe('route khách vẫn public — KHÔNG bị guard admin chặn', () => {
  it('GET /api/services không cần đăng nhập', async () => {
    const res = await get('/api/services')
    expect(res.status).toBe(200)
  })

  it('GET /api/availability không bị 401 (không cần đăng nhập)', async () => {
    // Thiếu tham số → có thể 422, nhưng TUYỆT ĐỐI không phải 401.
    const res = await get('/api/availability?variant_id=1&date=2099-01-01')
    expect(res.status).not.toBe(401)
  })

  it('POST /api/bookings không bị 401 (route khách)', async () => {
    const res = await exports.default.fetch(`${BASE}/api/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).not.toBe(401)
  })

  it('POST /api/payments/create không bị 401 (route khách)', async () => {
    const res = await exports.default.fetch(`${BASE}/api/payments/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).not.toBe(401)
  })
})

describe('webhook payment vẫn public — tự xác thực Apikey, KHÔNG qua auth admin', () => {
  it('POST /api/payments/webhook/sepay bị chặn bởi Apikey (401 của webhook), KHÔNG phải guard admin', async () => {
    // Không có cookie admin. Webhook không nằm dưới /api/admin/* nên guard admin
    // không đụng tới. SePay adapter tự từ chối vì thiếu Apikey → 401 UNAUTHORIZED,
    // nhưng đó là 401 của CHÍNH webhook (fail-closed), không phải guard admin.
    const res = await exports.default.fetch(`${BASE}/api/payments/webhook/sepay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1 }),
    })
    // Với Apikey ĐÚNG, webhook cho qua verify → chứng minh guard admin không chặn.
    const ok = await exports.default.fetch(`${BASE}/api/payments/webhook/sepay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Apikey test-sepay-key' },
      body: JSON.stringify({ id: 1, code: 'CCF999X', transferType: 'in', transferAmount: 1 }),
    })
    // Verified event (dù không khớp order nào) → webhook trả 200 success, KHÔNG 401.
    expect(ok.status).toBe(200)
    // Còn khi thiếu Apikey, 401 đến từ webhook chứ không phải vì "chưa đăng nhập admin".
    expect(res.status).toBe(401)
  })
})

describe('POST /api/auth/login + logout', () => {
  it('mật khẩu SAI → 401 UNAUTHORIZED', async () => {
    const res = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'sai-mat-khau' }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('UNAUTHORIZED')
  })

  it('mật khẩu ĐÚNG → 200, set cookie phiên dùng được cho /api/admin/*', async () => {
    const login = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'test-admin-pw' }),
    })
    expect(login.status).toBe(200)
    const setCookie = login.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(SESSION_COOKIE)
    expect(setCookie.toLowerCase()).toContain('httponly')

    // Lấy token từ Set-Cookie rồi dùng đi vào một route admin.
    const m = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
    expect(m).not.toBeNull()
    const res = await get('/api/admin/reassign-queue', `${SESSION_COOKIE}=${m![1]}`)
    expect(res.status).toBe(200)
  })

  it('body không phải JSON → 422 VALIDATION (không phải 401)', async () => {
    const res = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'khong-phai-json',
    })
    expect(res.status).toBe(422)
  })

  it('POST /api/auth/logout → 200 và xoá cookie', async () => {
    const res = await exports.default.fetch(`${BASE}/api/auth/logout`, { method: 'POST' })
    expect(res.status).toBe(200)
    const setCookie = login2SetCookie(res)
    expect(setCookie).toContain(SESSION_COOKIE)
  })
})

function login2SetCookie(res: Response): string {
  return res.headers.get('set-cookie') ?? ''
}

describe('GET /api/auth/session', () => {
  it('không cookie → { authenticated: false }, 200', async () => {
    const res = await get('/api/auth/session')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authenticated: false })
  })

  it('cookie hợp lệ → authenticated true + role', async () => {
    const res = await get('/api/auth/session', await validCookie())
    expect(res.status).toBe(200)
    // T-22: session nay trả thêm role/staffId. validCookie() ký token không kèm
    // user → role mặc định 'owner', staffId null (giữ tương thích test cũ).
    const body = (await res.json()) as { authenticated: boolean; role?: string }
    expect(body.authenticated).toBe(true)
    expect(body.role).toBe('owner')
  })
})
