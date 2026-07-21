import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { localDayBounds } from '../../src/worker/lib/time.ts'

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

async function insertVariant(
  skillId: number,
  opts: { duration: number; buffer: number; zone?: string },
): Promise<number> {
  const svc = await db
    .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, 1) RETURNING id')
    .bind(`Svc-${Math.random()}`, skillId, opts.zone ?? 'body')
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

async function insertAllDayShift(staffId: number): Promise<void> {
  for (let wd = 0; wd < 7; wd++) {
    await db
      .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, ?, 0, 1440)')
      .bind(staffId, wd)
      .run()
  }
}

/** Creates a bare appointment (no items yet) — the "existing appointment" the endpoint adds to. */
async function insertAppointment(startAt: number, endAt: number, status = 'booked'): Promise<number> {
  const cust = await db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, NULL) RETURNING id')
    .bind(`C-${Math.random()}`)
    .first<{ id: number }>()
  const appt = await db
    .prepare(
      `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
       VALUES (?, ?, ?, ?, 'admin', 0) RETURNING id`,
    )
    .bind(cust!.id, startAt, endAt, status)
    .first<{ id: number }>()
  return appt!.id
}

async function insertItem(
  appointmentId: number,
  staffId: number,
  variantId: number,
  startAt: number,
  durationMin: number,
  bufferMin: number,
  status = 'booked',
): Promise<number> {
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const item = await db
    .prepare(
      `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(appointmentId, staffId, variantId, startAt, endAt, blockEndAt, status)
    .first<{ id: number }>()
  return item!.id
}

async function postItem(appointmentId: number | string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/admin/appointments/${appointmentId}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

/**
 * Ngày dùng cho mọi test trong file: 7 ngày TỚI, tính động.
 *
 * Bản đầu để cứng `'2026-07-22'` và lấy `dayStart + 3600` (01:00 sáng hôm đó).
 * Test xanh khi viết lúc 00:xx, rồi đỏ hàng loạt lúc 01:42 cùng ngày — mọi
 * request trả 422 VALIDATION vì `start_at` đã trôi vào quá khứ. Lỗi trông như
 * lỗi logic nhưng thực ra là test tự hết hạn theo đồng hồ.
 *
 * Ngày động thì luôn ở tương lai, bất kể chạy lúc nào.
 */
const DATE = (() => {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  return parts // en-CA cho đúng dạng YYYY-MM-DD
})()

describe('POST /api/admin/appointments/:id/items', () => {
  beforeEach(wipe)

  it('thêm item hợp lệ vào appointment có sẵn trả 201', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600
    const appt = await insertAppointment(startAt, startAt + 3600)

    const { status, body } = await postItem(appt, { variant_id: variant, staff_id: lan, start_at: startAt })
    expect(status).toBe(201)
    expect(body.item.appointment_id).toBe(appt)
    expect(body.item.staff_id).toBe(lan)
    expect(body.item.status).toBe('booked')
  })

  it('item mới chồng giờ nhưng khác body_zone thì hợp lệ (tóc + móng)', async () => {
    const hairSkill = await insertSkill('Tóc')
    const nailSkill = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [hairSkill, nailSkill])
    await insertAllDayShift(lan)
    const hairVariant = await insertVariant(hairSkill, { duration: 60, buffer: 0, zone: 'hair' })
    const nailVariant = await insertVariant(nailSkill, { duration: 60, buffer: 0, zone: 'hands' })
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600
    const appt = await insertAppointment(startAt, startAt + 3600)
    await insertItem(appt, lan, hairVariant, startAt, 60, 0)

    // NOTE: same technician doing two overlapping services simultaneously is
    // physically odd, but the card's rule is explicitly body_zone-only — the
    // route deliberately does not re-check staff-overlap against sibling
    // items of the SAME appointment (only the global availability guard
    // against ALL booking_items, which this same item already occupies).
    // To exercise the "different zone -> allowed" rule cleanly we use a
    // different technician holding the second skill instead.
    const mai = await insertStaff('Mai', [nailSkill])
    await insertAllDayShift(mai)

    const { status, body } = await postItem(appt, { variant_id: nailVariant, staff_id: mai, start_at: startAt })
    expect(status).toBe(201)
    expect(body.item.staff_id).toBe(mai)
  })

  it('item mới chồng giờ và trùng body_zone trả 409 ZONE_CONFLICT', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const mai = await insertStaff('Mai', [skill])
    await insertAllDayShift(lan)
    await insertAllDayShift(mai)
    const variant1 = await insertVariant(skill, { duration: 60, buffer: 0, zone: 'body' })
    const variant2 = await insertVariant(skill, { duration: 60, buffer: 0, zone: 'body' })
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600
    const appt = await insertAppointment(startAt, startAt + 3600)
    await insertItem(appt, lan, variant1, startAt, 60, 0)

    // Different technician (Mai) so the staff-availability guard doesn't
    // interfere — isolates the body_zone rule specifically.
    const { status, body } = await postItem(appt, { variant_id: variant2, staff_id: mai, start_at: startAt })
    expect(status).toBe(409)
    expect(body.error.code).toBe('ZONE_CONFLICT')
  })

  it('KTV thiếu skill trả 409 STAFF_LACKS_SKILL', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const mai = await insertStaff('Mai', [nails])
    await insertAllDayShift(mai)
    const massageVariant = await insertVariant(massage, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600
    const appt = await insertAppointment(startAt, startAt + 3600)

    const { status, body } = await postItem(appt, { variant_id: massageVariant, staff_id: mai, start_at: startAt })
    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')
  })

  it('KTV đã bận giờ đó trả 409 SLOT_TAKEN', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600

    // Existing booking elsewhere occupies Lan at this time.
    const otherAppt = await insertAppointment(startAt, startAt + 3600)
    await insertItem(otherAppt, lan, variant, startAt, 60, 0)

    const appt = await insertAppointment(startAt, startAt + 3600)
    const { status, body } = await postItem(appt, { variant_id: variant, staff_id: lan, start_at: startAt })
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
  })

  it('appointment không tồn tại trả 404 NOT_FOUND', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)

    const { status, body } = await postItem(999999, { variant_id: variant, staff_id: lan, start_at: dayStart + 3600 })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('start_at lệch lưới 15 phút trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600 + 7 * 60 // off the 15-minute grid
    const appt = await insertAppointment(startAt, startAt + 3600)

    const { status, body } = await postItem(appt, { variant_id: variant, staff_id: lan, start_at: startAt })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })
})
