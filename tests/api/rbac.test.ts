// T-22 — RBAC 3 vai trò trong workerd + D1 thật (CONVENTIONS §8).
//
// Khẳng định HÀNH VI nghiệp vụ theo card:
//   - owner-only (overview/earnings/users/sửa-giá): owner 200, lễ tân/KTV 403.
//   - row-filter (schedule): technician CHỈ thấy booking của mình; owner/lễ tân thấy mọi KTV.
//   - ownership-check (đổi status, huỷ, báo nghỉ): technician CHỈ đụng của mình;
//     ĐỤNG CỦA KTV KHÁC → 403 (silent side-effect nếu thiếu — cạm bẫy #1).
//   - login username+password: đúng → session mang role; sai → 401; inactive → 401.
//   - route KHÁCH + webhook payment KHÔNG bị RBAC đụng.
//
// Cookie mỗi role ký bằng CHÍNH lib thuần (issueSessionToken) với SESSION_SECRET
// test — role trong payload ĐÃ KÝ, không giả được.

import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migration0001 from '../../migrations/0001_init.sql?raw'
import migration0002 from '../../migrations/0002_commission_tax.sql?raw'
import migration0003 from '../../migrations/0003_payments.sql?raw'
import migration0004 from '../../migrations/0004_users.sql?raw'
import migration0005 from '../../migrations/0005_must_change_password.sql?raw'
import { seed } from '../../src/worker/db/seed.ts'
import { SESSION_COOKIE, hashPassword, issueSessionToken, type AuthUser } from '../../src/worker/lib/auth.ts'

const db = env.DB
const BASE = 'https://example.com'
const SECRET = 'test-session-secret' // khớp vitest.config.ts miniflare.bindings

function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// staff ids sau seed: Lan=1..Yen=5 theo thứ tự STAFF_DEFS. Ta tra động cho chắc.
let LAN_ID = 0
let MAI_ID = 0

async function cookie(user: AuthUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const token = await issueSessionToken(SECRET, now, 12 * 3600, user)
  return `${SESSION_COOKIE}=${token}`
}

// Các actor test.
let OWNER: AuthUser
let RECEPTION: AuthUser
let KTV_LAN: AuthUser // technician link staff Lan
let KTV_MAI: AuthUser // technician link staff Mai (để test "đụng của người khác")

beforeAll(async () => {
  for (const m of [migration0001, migration0002, migration0003, migration0004, migration0005]) {
    for (const stmt of splitStatements(m)) await db.prepare(stmt).run()
  }
})

beforeEach(async () => {
  // seed() dựng staff/services/bookings + xoá users. Sau đó ta tự chèn users
  // gắn với staff thật để test row-filter/ownership.
  await seed(db)
  const lan = await db.prepare("SELECT id FROM staff WHERE name = 'Lan'").first<{ id: number }>()
  const mai = await db.prepare("SELECT id FROM staff WHERE name = 'Mai'").first<{ id: number }>()
  LAN_ID = lan!.id
  MAI_ID = mai!.id

  const hash = await hashPassword('pw-secret')
  await db.prepare('DELETE FROM users').run()
  await db
    .prepare("INSERT INTO users (username, password_hash, role, staff_id, active, created_at) VALUES ('owner', ?, 'owner', NULL, 1, 0)")
    .bind(hash)
    .run()
  await db
    .prepare("INSERT INTO users (username, password_hash, role, staff_id, active, created_at) VALUES ('recep', ?, 'receptionist', NULL, 1, 0)")
    .bind(hash)
    .run()
  await db
    .prepare("INSERT INTO users (username, password_hash, role, staff_id, active, created_at) VALUES ('lan', ?, 'technician', ?, 1, 0)")
    .bind(hash, LAN_ID)
    .run()
  await db
    .prepare("INSERT INTO users (username, password_hash, role, staff_id, active, created_at) VALUES ('mai', ?, 'technician', ?, 1, 0)")
    .bind(hash, MAI_ID)
    .run()

  const owner = await db.prepare("SELECT id FROM users WHERE username='owner'").first<{ id: number }>()
  const recep = await db.prepare("SELECT id FROM users WHERE username='recep'").first<{ id: number }>()
  const lanU = await db.prepare("SELECT id FROM users WHERE username='lan'").first<{ id: number }>()
  const maiU = await db.prepare("SELECT id FROM users WHERE username='mai'").first<{ id: number }>()
  OWNER = { userId: owner!.id, role: 'owner', staffId: null }
  RECEPTION = { userId: recep!.id, role: 'receptionist', staffId: null }
  KTV_LAN = { userId: lanU!.id, role: 'technician', staffId: LAN_ID }
  KTV_MAI = { userId: maiU!.id, role: 'technician', staffId: MAI_ID }
})

function req(path: string, cookie: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { cookie }
  if (init?.body) headers['content-type'] = 'application/json'
  return exports.default.fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } })
}

// Ngày seed dùng UTC-midnight-anchor; schedule dùng ngày local. Ta tra ngày của
// một booking seed để hỏi schedule đúng ngày có dữ liệu.
async function seededBookingDate(): Promise<string> {
  const row = await db
    .prepare("SELECT start_at FROM booking_items ORDER BY start_at LIMIT 1")
    .first<{ start_at: number }>()
  const d = new Date((row!.start_at + 7 * 3600) * 1000) // +7h giờ VN
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// ---------------------------------------------------------------------------
describe('owner-only: doanh thu/lương (overview + staff-earnings)', () => {
  it('owner GET /api/admin/overview → 200; receptionist → 403; technician → 403', async () => {
    const date = await seededBookingDate()
    const o = await req(`/api/admin/overview?date=${date}`, await cookie(OWNER))
    expect(o.status).toBe(200)
    const r = await req(`/api/admin/overview?date=${date}`, await cookie(RECEPTION))
    expect(r.status).toBe(403)
    expect((await r.json() as any).error.code).toBe('FORBIDDEN')
    const t = await req(`/api/admin/overview?date=${date}`, await cookie(KTV_LAN))
    expect(t.status).toBe(403)
  })

  it('staff-earnings: owner 200, lễ tân 403, KTV 403', async () => {
    const date = await seededBookingDate()
    const o = await req(`/api/admin/staff-earnings?staff_id=${LAN_ID}&date=${date}&period=day`, await cookie(OWNER))
    expect(o.status).toBe(200)
    const r = await req(`/api/admin/staff-earnings?staff_id=${LAN_ID}&date=${date}&period=day`, await cookie(RECEPTION))
    expect(r.status).toBe(403)
    const t = await req(`/api/admin/staff-earnings?staff_id=${LAN_ID}&date=${date}&period=day`, await cookie(KTV_LAN))
    expect(t.status).toBe(403)
  })
})

describe('owner-only: sửa GIÁ (services/variants/skills), lễ tân KHÓA sửa nhưng XEM được', () => {
  it('receptionist sửa giá variant → 403; owner → 200', async () => {
    const variant = await db.prepare("SELECT id FROM service_variants LIMIT 1").first<{ id: number }>()
    const body = JSON.stringify({ price: 999000 })
    const r = await req(`/api/admin/variants/${variant!.id}`, await cookie(RECEPTION), { method: 'PATCH', body })
    expect(r.status).toBe(403)
    const o = await req(`/api/admin/variants/${variant!.id}`, await cookie(OWNER), { method: 'PATCH', body })
    expect(o.status).toBe(200)
  })

  it('receptionist VẪN XEM được danh sách dịch vụ/variant (GET không bị khoá — cần cho walk-in)', async () => {
    const gv = await req('/api/admin/variants', await cookie(RECEPTION))
    expect(gv.status).toBe(200)
    const gs = await req('/api/admin/services', await cookie(RECEPTION))
    expect(gs.status).toBe(200)
  })

  it('technician sửa/thêm giá → 403', async () => {
    const t = await req('/api/admin/services', await cookie(KTV_LAN), {
      method: 'POST',
      body: JSON.stringify({ name: 'X', skill_id: 1, body_zone: 'hair' }),
    })
    expect(t.status).toBe(403)
  })
})

describe('owner-only: quản lý user', () => {
  it('owner tạo user mới role=receptionist → 201, user login được thấy đúng phạm vi', async () => {
    const create = await req('/api/admin/users', await cookie(OWNER), {
      method: 'POST',
      body: JSON.stringify({ username: 'letan2', password: 'pw-secret', role: 'receptionist' }),
    })
    expect(create.status).toBe(201)

    // Login user mới → session mang role receptionist.
    const login = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'letan2', password: 'pw-secret' }),
    })
    expect(login.status).toBe(200)
    expect((await login.json() as any).role).toBe('receptionist')

    // Phạm vi đúng: user mới (lễ tân) KHÔNG vào được overview.
    const setCookie = login.headers.get('set-cookie') ?? ''
    const m = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
    const date = await seededBookingDate()
    const ov = await req(`/api/admin/overview?date=${date}`, `${SESSION_COOKIE}=${m![1]}`)
    expect(ov.status).toBe(403)
  })

  it('receptionist/technician KHÔNG quản lý được user → 403', async () => {
    const r = await req('/api/admin/users', await cookie(RECEPTION))
    expect(r.status).toBe(403)
    const t = await req('/api/admin/users', await cookie(KTV_LAN))
    expect(t.status).toBe(403)
  })

  it('technician BẮT BUỘC có staff_id; owner/lễ tân KHÔNG được gán staff_id', async () => {
    const noStaff = await req('/api/admin/users', await cookie(OWNER), {
      method: 'POST',
      body: JSON.stringify({ username: 'ktv-loi', password: 'pw-secret', role: 'technician' }),
    })
    expect(noStaff.status).toBe(422)
    const ownerWithStaff = await req('/api/admin/users', await cookie(OWNER), {
      method: 'POST',
      body: JSON.stringify({ username: 'owner2', password: 'pw-secret', role: 'owner', staff_id: LAN_ID }),
    })
    expect(ownerWithStaff.status).toBe(422)
  })
})

describe('row-filter: schedule', () => {
  it('technician GET schedule → CHỈ booking của staff_id mình (không thấy KTV khác)', async () => {
    const date = await seededBookingDate()
    const res = await req(`/api/admin/schedule?date=${date}`, await cookie(KTV_LAN))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { staff: { id: number }[] }
    // Chỉ thấy đúng cột của mình (Lan).
    expect(body.staff.every((s) => s.id === LAN_ID)).toBe(true)
    expect(body.staff.length).toBe(1)
  })

  it('receptionist/owner GET schedule → thấy MỌI KTV', async () => {
    const date = await seededBookingDate()
    const r = await req(`/api/admin/schedule?date=${date}`, await cookie(RECEPTION))
    const rBody = (await r.json()) as { staff: unknown[] }
    expect(rBody.staff.length).toBeGreaterThan(1)
    const o = await req(`/api/admin/schedule?date=${date}`, await cookie(OWNER))
    const oBody = (await o.json()) as { staff: unknown[] }
    expect(oBody.staff.length).toBeGreaterThan(1)
  })
})

describe('ownership-check: đổi status booking (SILENT SIDE-EFFECT — cạm bẫy #1)', () => {
  // Seed: Lan có booking 'done' @10h (không đổi được), và 'no_show' @14h. Ta tạo
  // một booking 'booked' mới cho Lan và một cho Mai để test đổi status sạch.
  async function makeBooking(staffId: number): Promise<number> {
    const v = await db.prepare("SELECT id FROM service_variants LIMIT 1").first<{ id: number }>()
    const cust = await db.prepare("SELECT id FROM customers LIMIT 1").first<{ id: number }>()
    const appt = await db
      .prepare("INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at) VALUES (?, 100, 200, 'booked', 'online', 0) RETURNING id")
      .bind(cust!.id)
      .first<{ id: number }>()
    const item = await db
      .prepare("INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status) VALUES (?, ?, ?, 100, 200, 300, 'booked') RETURNING id")
      .bind(appt!.id, staffId, v!.id)
      .first<{ id: number }>()
    return item!.id
  }

  it('technician đổi status booking CỦA MÌNH → 200', async () => {
    const itemId = await makeBooking(LAN_ID)
    const res = await req(`/api/admin/bookings/${itemId}/status`, await cookie(KTV_LAN), {
      method: 'POST',
      body: JSON.stringify({ status: 'in_service' }),
    })
    expect(res.status).toBe(200)
  })

  it('technician đổi status booking CỦA KTV KHÁC → 403 (KHÔNG được đụng)', async () => {
    const maiItem = await makeBooking(MAI_ID)
    const res = await req(`/api/admin/bookings/${maiItem}/status`, await cookie(KTV_LAN), {
      method: 'POST',
      body: JSON.stringify({ status: 'in_service' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json() as any).error.code).toBe('FORBIDDEN')
    // Bằng chứng KHÔNG có side-effect âm thầm: status của Mai vẫn 'booked'.
    const after = await db.prepare('SELECT status FROM booking_items WHERE id = ?').bind(maiItem).first<{ status: string }>()
    expect(after!.status).toBe('booked')
  })

  it('technician HUỶ booking CỦA KTV KHÁC → 403 (không đụng được)', async () => {
    const maiItem = await makeBooking(MAI_ID)
    const res = await req(`/api/admin/bookings/${maiItem}/cancel`, await cookie(KTV_LAN), { method: 'POST' })
    expect(res.status).toBe(403)
    const after = await db.prepare('SELECT status FROM booking_items WHERE id = ?').bind(maiItem).first<{ status: string }>()
    expect(after!.status).toBe('booked')
  })

  it('owner/lễ tân đổi status booking BẤT KỲ KTV → không bị 403', async () => {
    const maiItem = await makeBooking(MAI_ID)
    const res = await req(`/api/admin/bookings/${maiItem}/status`, await cookie(RECEPTION), {
      method: 'POST',
      body: JSON.stringify({ status: 'in_service' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('ownership-check: báo nghỉ (time-off)', () => {
  it('technician tạo time-off cho CHÍNH MÌNH → 200', async () => {
    const res = await req('/api/admin/time-off', await cookie(KTV_LAN), {
      method: 'POST',
      body: JSON.stringify({ staff_id: LAN_ID, start_at: 1000, end_at: 2000, reason: 'ốm' }),
    })
    expect(res.status).toBe(200)
  })

  it('technician tạo time-off cho KTV KHÁC → 403 (không đụng được)', async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM time_off WHERE staff_id = ?').bind(MAI_ID).first<{ n: number }>()
    const res = await req('/api/admin/time-off', await cookie(KTV_LAN), {
      method: 'POST',
      body: JSON.stringify({ staff_id: MAI_ID, start_at: 1000, end_at: 2000 }),
    })
    expect(res.status).toBe(403)
    // Không có side-effect: không tạo được dòng time_off cho Mai.
    const after = await db.prepare('SELECT COUNT(*) AS n FROM time_off WHERE staff_id = ?').bind(MAI_ID).first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })

  it('lễ tân/owner báo nghỉ cho bất kỳ KTV → không 403', async () => {
    const res = await req('/api/admin/time-off', await cookie(RECEPTION), {
      method: 'POST',
      body: JSON.stringify({ staff_id: MAI_ID, start_at: 1000, end_at: 2000 }),
    })
    expect(res.status).toBe(200)
  })
})

describe('login username+password', () => {
  it('đúng → session mang role', async () => {
    const res = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lan', password: 'pw-secret' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as any).role).toBe('technician')
  })

  it('sai password → 401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'sai' }),
    })
    expect(res.status).toBe(401)
  })

  it('user INACTIVE → 401 (dù đúng mật khẩu)', async () => {
    await db.prepare("UPDATE users SET active = 0 WHERE username = 'recep'").run()
    const res = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'recep', password: 'pw-secret' }),
    })
    expect(res.status).toBe(401)
  })

  it('username không tồn tại → 401', async () => {
    const res = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'khong-co', password: 'pw-secret' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('route KHÁCH + webhook payment KHÔNG bị RBAC đụng', () => {
  it('GET /api/services (khách) không cần role → 200', async () => {
    const res = await exports.default.fetch(`${BASE}/api/services`)
    expect(res.status).toBe(200)
  })

  it('POST /api/payments/webhook/sepay (Apikey đúng) không bị RBAC → 200', async () => {
    const res = await exports.default.fetch(`${BASE}/api/payments/webhook/sepay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Apikey test-sepay-key' },
      body: JSON.stringify({ id: 1, code: 'CCF999X', transferType: 'in', transferAmount: 1 }),
    })
    expect(res.status).toBe(200)
  })
})
