// POST /api/bookings/:id/reschedule — khách tự đổi giờ (T-24 / G5).
//
// Bất biến quan trọng nhất (card): đổi giờ NGUYÊN TỬ — nếu giờ mới bất khả thi
// (bị cướp / ngoài ca / KTV thiếu skill), item CŨ phải Y NGUYÊN, khách không
// bao giờ rơi vào trạng thái "mất giờ cũ mà chưa có giờ mới".

import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { localDayBounds, weekdayOf } from '../../src/worker/lib/time.ts'

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
    .bind(`Svc-${skillId}-${Math.random()}`, skillId, opts.zone ?? 'body')
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

async function insertShift(staffId: number, weekday: number, startMin: number, endMin: number): Promise<void> {
  await db
    .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)')
    .bind(staffId, weekday, startMin, endMin)
    .run()
}

async function insertTimeOff(staffId: number, startAt: number, endAt: number): Promise<void> {
  await db
    .prepare('INSERT INTO time_off (staff_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)')
    .bind(staffId, startAt, endAt, 'nghỉ')
    .run()
}

async function seedBooking(
  staffId: number,
  variantId: number,
  startAt: number,
  durationMin: number,
  bufferMin: number,
  status = 'booked',
): Promise<{ appointmentId: number; itemId: number }> {
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const cust = await db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, NULL) RETURNING id')
    .bind(`C-${Math.random()}`)
    .first<{ id: number }>()
  const appt = await db
    .prepare(
      `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
       VALUES (?, ?, ?, ?, 'online', 0) RETURNING id`,
    )
    .bind(cust!.id, startAt, endAt, status)
    .first<{ id: number }>()
  const item = await db
    .prepare(
      `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(appt!.id, staffId, variantId, startAt, endAt, blockEndAt, status)
    .first<{ id: number }>()
  return { appointmentId: appt!.id, itemId: item!.id }
}

async function reschedule(
  itemId: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/bookings/${itemId}/reschedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function itemRow(itemId: number): Promise<{
  status: string
  staff_id: number
  start_at: number
  end_at: number
  block_end_at: number
}> {
  const row = await db
    .prepare('SELECT status, staff_id, start_at, end_at, block_end_at FROM booking_items WHERE id = ?')
    .bind(itemId)
    .first<any>()
  return row!
}

function futureDateStr(daysAhead: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + daysAhead * 24 * 3600 * 1000))
}
const FUTURE_DATE = futureDateStr(12)
const FUTURE_WEEKDAY = weekdayOf(FUTURE_DATE)
const { start: FUTURE_DAY_START } = localDayBounds(FUTURE_DATE)

/** Local wall-clock on FUTURE_DATE → epoch seconds. */
function at(hour: number, minute = 0): number {
  return FUTURE_DAY_START + hour * 3600 + minute * 60
}

async function seedWorld(opts: { duration?: number; buffer?: number } = {}) {
  const skill = await insertSkill('Massage')
  const staffId = await insertStaff('Lan', [skill])
  await insertShift(staffId, FUTURE_WEEKDAY, 0, 1439)
  const variantId = await insertVariant(skill, { duration: opts.duration ?? 60, buffer: opts.buffer ?? 15 })
  return { skill, staffId, variantId }
}

describe('POST /api/bookings/:id/reschedule — khách tự đổi giờ', () => {
  beforeEach(wipe)

  it('đổi sang slot trống hợp lệ (>2h) → item đổi giờ, giờ cũ mở lại book được', async () => {
    const w = await seedWorld()
    const oldStart = at(15, 0)
    const newStart = at(17, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, oldStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: newStart })
    expect(status).toBe(200)
    expect(body.item.status).toBe('booked')
    expect(body.item.start_at).toBe(newStart)

    const row = await itemRow(itemId)
    expect(row.start_at).toBe(newStart)
    expect(row.end_at).toBe(newStart + 60 * 60)
    expect(row.block_end_at).toBe(newStart + 75 * 60)
    expect(row.status).toBe('booked')

    // Giờ CŨ mở lại: availability của KTV thấy slot 15:00 rảnh lại.
    const res = await exports.default.fetch(
      `https://example.com/api/availability?variant_id=${w.variantId}&date=${FUTURE_DATE}&staff_id=${w.staffId}`,
    )
    const avail = (await res.json()) as any
    expect(avail.slots.find((s: any) => s.start_at === oldStart)).toBeDefined()
  })

  it('đổi sang giờ mà slot mới VỪA BỊ CHIẾM → 409 SLOT_TAKEN, item CŨ GIỮ NGUYÊN (không mất)', async () => {
    const w = await seedWorld()
    const staff2 = await insertStaff('Mai', [w.skill]) // KTV khác, KHÔNG dùng
    const oldStart = at(15, 0)
    const newStart = at(17, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, oldStart, 60, 15)

    // Ai đó chiếm CHÍNH slot 17:00 của đúng KTV w.staffId trước khi khách đổi.
    await seedBooking(w.staffId, w.variantId, newStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: newStart })
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')

    // BẤT BIẾN: item cũ Y NGUYÊN — vẫn booked, vẫn ở giờ cũ, vẫn KTV cũ.
    const row = await itemRow(itemId)
    expect(row.status).toBe('booked')
    expect(row.start_at).toBe(oldStart)
    expect(row.staff_id).toBe(w.staffId)
    expect(staff2).toBeGreaterThan(0)
  })

  it('đổi giờ dưới 2 tiếng → 409 CANCEL_TOO_LATE (như huỷ), item cũ giữ nguyên', async () => {
    const w = await seedWorld()
    // start_at neo gần "bây giờ thật" của server để cutoff so với now thật.
    const now = Math.floor(Date.now() / 1000)
    const oldStart = now + 60 * 60 // 60 phút nữa — trong cutoff 120 phút.
    const { itemId } = await seedBooking(w.staffId, w.variantId, oldStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: oldStart + 3 * 3600 })
    expect(status).toBe(409)
    expect(body.error.code).toBe('CANCEL_TOO_LATE')

    const row = await itemRow(itemId)
    expect(row.status).toBe('booked')
    expect(row.start_at).toBe(oldStart)
  })

  it('đổi sang giờ ngoài ca làm việc → 422 VALIDATION (OUTSIDE_SHIFT), item cũ giữ nguyên', async () => {
    const skill = await insertSkill('Massage')
    const staffId = await insertStaff('Lan', [skill])
    // Ca chỉ 08:00–18:00 (480–1080). Slot 20:00 nằm ngoài ca.
    await insertShift(staffId, FUTURE_WEEKDAY, 480, 1080)
    const variantId = await insertVariant(skill, { duration: 60, buffer: 15 })
    const oldStart = at(15, 0)
    const { itemId } = await seedBooking(staffId, variantId, oldStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: at(20, 0) })
    expect(status).toBe(409)
    expect(body.error.code).toBe('OUTSIDE_SHIFT')

    const row = await itemRow(itemId)
    expect(row.start_at).toBe(oldStart)
    expect(row.status).toBe('booked')
  })

  it('đổi giờ + đổi sang KTV KHÔNG có skill → 409 STAFF_LACKS_SKILL, item cũ giữ nguyên', async () => {
    const w = await seedWorld()
    const otherSkill = await insertSkill('Tóc')
    const staffNoSkill = await insertStaff('Hoa', [otherSkill]) // không có skill Massage
    await insertShift(staffNoSkill, FUTURE_WEEKDAY, 0, 1439)
    const oldStart = at(15, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, oldStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: at(17, 0), staff_id: staffNoSkill })
    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')

    const row = await itemRow(itemId)
    expect(row.start_at).toBe(oldStart)
    expect(row.staff_id).toBe(w.staffId) // KTV cũ giữ nguyên
  })

  it('đổi giờ đè lên time_off của KTV → 409 SLOT_TAKEN, item cũ giữ nguyên', async () => {
    const w = await seedWorld()
    const oldStart = at(15, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, oldStart, 60, 15)
    // KTV nghỉ 17:00–19:00; đổi sang 17:00 đè lên nghỉ.
    await insertTimeOff(w.staffId, at(17, 0), at(19, 0))

    const { status, body } = await reschedule(itemId, { start_at: at(17, 0) })
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')

    const row = await itemRow(itemId)
    expect(row.start_at).toBe(oldStart)
  })

  it('đổi giờ item đã cancelled → 409 INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const { itemId } = await seedBooking(w.staffId, w.variantId, at(15, 0), 60, 15, 'cancelled')

    const { status, body } = await reschedule(itemId, { start_at: at(17, 0) })
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
  })

  it('đổi giờ item đã done → 409 INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const { itemId } = await seedBooking(w.staffId, w.variantId, at(15, 0), 60, 15, 'done')

    const { status, body } = await reschedule(itemId, { start_at: at(17, 0) })
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
  })

  it('đổi giờ item không tồn tại → 404 NOT_FOUND', async () => {
    const { status, body } = await reschedule(999999, { start_at: at(17, 0) })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('start_at không rơi lưới 15 phút → 422 VALIDATION, item cũ giữ nguyên', async () => {
    const w = await seedWorld()
    const oldStart = at(15, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, oldStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: at(17, 7) }) // 17:07 lệch lưới
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')

    const row = await itemRow(itemId)
    expect(row.start_at).toBe(oldStart)
  })

  it('đổi giờ dịch NHẸ trong block của chính mình (giữ KTV cũ) → không tự chặn, thành công', async () => {
    // Item 15:00–16:00 (+15 buffer → block tới 16:15). Đổi sang 15:15 chồng
    // lên block CŨ của chính nó — nếu không loại chính mình sẽ báo SLOT_TAKEN sai.
    const w = await seedWorld()
    const oldStart = at(15, 0)
    const newStart = at(15, 15)
    const { itemId } = await seedBooking(w.staffId, w.variantId, oldStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: newStart })
    expect(status).toBe(200)
    expect(body.item.start_at).toBe(newStart)
  })
})
