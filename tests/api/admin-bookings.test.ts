// T-29 — POST /api/admin/bookings: lễ tân tạo lịch TƯƠNG LAI trực tiếp trên
// timeline. Cùng write-path với T-04 (online)/T-08 (walk-in) — chỉ khác
// source='admin', status='booked', start_at do lễ tân chọn (không phải now).
//
// CONVENTIONS §8: ngày ĐỘNG (futureDateStr), ca làm phủ TRỌN mọi weekday để
// không phụ thuộc ngày chạy CI rơi vào thứ mấy — cùng mẫu insertAllDayShift
// đã dùng ở walkin.test.ts.

import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { adminCookieHeader } from './_authCookie.ts'
import { issueSessionToken, SESSION_COOKIE, type AuthUser } from '../../src/worker/lib/auth.ts'

const db = env.DB
const SECRET = 'test-session-secret' // khớp vitest.config.ts miniflare.bindings

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
  for (const stmt of splitStatements(migrationSql)) {
    await db.prepare(stmt).run()
  }
})

async function wipe(): Promise<void> {
  for (const t of [
    'booking_items',
    'appointments',
    'customers',
    'time_off',
    'work_shifts',
    'service_variants',
    'services',
    'staff_skills',
    'staff',
    'skills',
  ]) {
    await db.prepare(`DELETE FROM ${t}`).run()
  }
}

async function insertSkill(name: string): Promise<number> {
  const r = await db.prepare('INSERT INTO skills (name) VALUES (?) RETURNING id').bind(name).first<{ id: number }>()
  return r!.id
}

async function insertStaff(name: string, skillIds: number[], active = 1): Promise<number> {
  const r = await db
    .prepare('INSERT INTO staff (name, active) VALUES (?, ?) RETURNING id')
    .bind(name, active)
    .first<{ id: number }>()
  for (const skillId of skillIds) {
    await db.prepare('INSERT INTO staff_skills (staff_id, skill_id) VALUES (?, ?)').bind(r!.id, skillId).run()
  }
  return r!.id
}

async function insertVariant(skillId: number, opts: { duration: number; buffer: number }): Promise<number> {
  const svc = await db
    .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, 1) RETURNING id')
    .bind(`Svc-${Math.random()}`, skillId, 'body')
    .first<{ id: number }>()
  const v = await db
    .prepare(
      `INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active)
       VALUES (?, ?, ?, ?, 100000, 1) RETURNING id`,
    )
    .bind(svc!.id, `${opts.duration} phút`, opts.duration, opts.buffer)
    .first<{ id: number }>()
  return v!.id
}

/** Ca làm phủ TRỌN mọi ngày trong tuần — test không phụ thuộc weekday CI chạy. */
async function insertAllDayShift(staffId: number): Promise<void> {
  for (let wd = 0; wd < 7; wd++) {
    await db
      .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, ?, 0, 1440)')
      .bind(staffId, wd)
      .run()
  }
}

/** "YYYY-MM-DD" N ngày tới, theo giờ spa — động, không phải ngày cứng (CONVENTIONS §8). */
function futureDateStr(daysAhead: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + daysAhead * 24 * 3600 * 1000))
}

/** Epoch giây của một mốc giờ ĐỊA PHƯƠNG spa (UTC+7 cố định, không DST). */
function localToEpoch(dateStr: string, hour: number, minute = 0): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const asUtcGuess = Date.UTC(y!, m! - 1, d!, hour, minute, 0) / 1000
  return asUtcGuess - 7 * 3600
}

const FUTURE_DATE = futureDateStr(7)
/** Mốc giờ trong tương lai, rơi đúng lưới 15 phút. */
function at(hour: number, minute = 0): number {
  return localToEpoch(FUTURE_DATE, hour, minute)
}

async function technicianCookieHeader(staffId: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const user: AuthUser = { userId: 999, role: 'technician', staffId }
  const token = await issueSessionToken(SECRET, now, 12 * 3600, user)
  return `${SESSION_COOKIE}=${token}`
}

async function postAdminBooking(body: unknown, cookie?: string): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://example.com/api/admin/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie ?? (await adminCookieHeader()) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function countItems(): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM booking_items').first<{ n: number }>()
  return r!.n
}

describe('POST /api/admin/bookings', () => {
  beforeEach(wipe)

  it('lễ tân/owner tạo lịch tương lai thành công: source=admin, status=booked', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })

    const { status, body } = await postAdminBooking({
      name: 'Khách Gọi Điện',
      phone: '0911222333',
      variant_id: variant,
      staff_id: lan,
      start_at: at(10, 0),
    })

    expect(status).toBe(201)
    expect(body.appointment.source).toBe('admin')
    expect(body.appointment.status).toBe('booked')
    expect(body.item.status).toBe('booked')
    expect(body.item.start_at).toBe(at(10, 0))
    expect(body.customer.name).toBe('Khách Gọi Điện')
    expect(body.customer.phone).toBe('0911222333')
  })

  it('không truyền phone vẫn tạo được, customer.phone giữ NULL', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })

    const { status, body } = await postAdminBooking({
      name: 'Khách Vãng Lai Có Hẹn',
      variant_id: variant,
      staff_id: lan,
      start_at: at(11, 0),
    })

    expect(status).toBe(201)
    expect(body.customer.phone).toBeNull()
  })

  it('technician gọi endpoint này → 403 FORBIDDEN, chặn ở route (bài học T-28)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })

    const { status, body } = await postAdminBooking(
      { name: 'Khách X', variant_id: variant, staff_id: lan, start_at: at(9, 0) },
      await technicianCookieHeader(lan),
    )

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(await countItems()).toBe(0)
  })

  it('tạo trùng slot đã có báo 409 SLOT_TAKEN, không tạo thêm item', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })

    const first = await postAdminBooking({
      name: 'Khách A',
      variant_id: variant,
      staff_id: lan,
      start_at: at(14, 0),
    })
    expect(first.status).toBe(201)

    const second = await postAdminBooking({
      name: 'Khách B',
      variant_id: variant,
      staff_id: lan,
      start_at: at(14, 0),
    })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('SLOT_TAKEN')
    expect(await countItems()).toBe(1)
  })

  it('start_at lệch lưới 15 phút bị chặn 422 VALIDATION (khác walk-in — đây KHÔNG được miễn lưới)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })

    const { status, body } = await postAdminBooking({
      name: 'Khách Lệch Lưới',
      variant_id: variant,
      staff_id: lan,
      start_at: at(9, 7), // 09:07 — không chia hết 15 phút
    })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
    expect(await countItems()).toBe(0)
  })

  it('chọn KTV không có skill của variant trả 409 STAFF_LACKS_SKILL', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const mai = await insertStaff('Mai', [nails])
    await insertAllDayShift(mai)
    const massageVariant = await insertVariant(massage, { duration: 30, buffer: 0 })

    const { status, body } = await postAdminBooking({
      name: 'Khách C',
      variant_id: massageVariant,
      staff_id: mai,
      start_at: at(15, 0),
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')
  })

  it('variant_id không tồn tại trả 404 NOT_FOUND', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)

    const { status, body } = await postAdminBooking({
      name: 'Khách D',
      variant_id: 999999,
      staff_id: lan,
      start_at: at(16, 0),
    })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('thiếu name trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 30, buffer: 0 })

    const { status, body } = await postAdminBooking({
      variant_id: variant,
      staff_id: lan,
      start_at: at(9, 0),
    })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('thiếu staff_id trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const variant = await insertVariant(skill, { duration: 30, buffer: 0 })

    const { status, body } = await postAdminBooking({
      name: 'Khách E',
      variant_id: variant,
      start_at: at(9, 0),
    })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('không có cookie phiên → 401 UNAUTHORIZED (adminAuthGuard chặn trước)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 30, buffer: 0 })

    const res = await exports.default.fetch('https://example.com/api/admin/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Khách F', variant_id: variant, staff_id: lan, start_at: at(9, 0) }),
    })
    expect(res.status).toBe(401)
  })
})
