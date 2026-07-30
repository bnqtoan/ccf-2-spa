// T-30 — đổi GIỜ / đổi KTV cho một lịch NGAY trên timeline admin.
//
// Card cấm viết endpoint reschedule mới: admin DÙNG LẠI đúng reschedule nguyên
// tử race-safe đã có (POST /api/bookings/:id/reschedule, T-24). File test này
// khẳng định các BẤT BIẾN mà luồng admin dựa vào:
//   1. Đổi giờ + đổi KTV cùng lúc, KTV mới đủ skill → thành công, ghi đúng DB.
//   2. Đổi vào slot đã BẬN → 409 SLOT_TAKEN, item CŨ Y NGUYÊN (không mất lịch).
//   3. Đổi sang KTV KHÔNG đủ skill → chặn (STAFF_LACKS_SKILL), item cũ giữ nguyên.
//   4. Không gửi staff_id (chỉ đổi giờ) → giữ KTV cũ.
//
// Nguyên tử là điểm sống-còn: nếu (2)/(3) làm item cũ biến mất thì lịch khách
// mồ côi âm thầm — đúng thảm hoạ card gọi tên. Mọi test dưới đây kiểm cả phản
// hồi lỗi LẪN dòng DB sau lỗi.

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
): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/bookings/${itemId}/reschedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

/** Local wall-clock on FUTURE_DATE → epoch seconds (đủ xa để qua cutoff 2h). */
function at(hour: number, minute = 0): number {
  return FUTURE_DAY_START + hour * 3600 + minute * 60
}

/** Hai KTV (Lan, Mai) đều có skill Massage, ca phủ cả ngày; và Hoa KHÔNG có
 * skill Massage. Đủ để dựng cả ba tình huống của luồng admin. */
async function seedWorld() {
  const skill = await insertSkill('Massage')
  const other = await insertSkill('Tóc')
  const lan = await insertStaff('Lan', [skill])
  const mai = await insertStaff('Mai', [skill])
  const hoa = await insertStaff('Hoa', [other]) // KHÔNG có skill Massage
  for (const s of [lan, mai, hoa]) await insertShift(s, FUTURE_WEEKDAY, 0, 1439)
  const variantId = await insertVariant(skill, { duration: 60, buffer: 15 })
  return { skill, lan, mai, hoa, variantId }
}

describe('T-30 admin đổi giờ/KTV — reuse reschedule nguyên tử (POST /api/bookings/:id/reschedule)', () => {
  beforeEach(wipe)

  it('kéo/đổi block sang KTV khác + giờ khác (đủ skill, slot trống) → DB đổi cả staff lẫn giờ', async () => {
    const w = await seedWorld()
    const oldStart = at(14, 0)
    const newStart = at(15, 0)
    const { itemId } = await seedBooking(w.lan, w.variantId, oldStart, 60, 15)

    // Lan@14:00 → Mai@15:00, đúng ví dụ E2E của card.
    const { status, body } = await reschedule(itemId, { start_at: newStart, staff_id: w.mai })
    expect(status).toBe(200)
    expect(body.item.staff_id).toBe(w.mai)
    expect(body.item.start_at).toBe(newStart)
    expect(body.staff.id).toBe(w.mai)

    const row = await itemRow(itemId)
    expect(row.staff_id).toBe(w.mai)
    expect(row.start_at).toBe(newStart)
    expect(row.end_at).toBe(newStart + 60 * 60)
    expect(row.block_end_at).toBe(newStart + 75 * 60)
    expect(row.status).toBe('booked')
  })

  it('đổi vào slot của KTV đích ĐANG BẬN → 409 SLOT_TAKEN, item cũ Y NGUYÊN (không mất lịch)', async () => {
    const w = await seedWorld()
    const oldStart = at(14, 0)
    const takenStart = at(16, 0)
    const { itemId } = await seedBooking(w.lan, w.variantId, oldStart, 60, 15)
    // Mai đã có lịch chiếm đúng 16:00 — đổi Lan@14:00 → Mai@16:00 phải bị chặn.
    await seedBooking(w.mai, w.variantId, takenStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: takenStart, staff_id: w.mai })
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')

    // BẤT BIẾN: item cũ vẫn booked, vẫn Lan, vẫn 14:00 — không có trạng thái nửa vời.
    const row = await itemRow(itemId)
    expect(row.status).toBe('booked')
    expect(row.staff_id).toBe(w.lan)
    expect(row.start_at).toBe(oldStart)
  })

  it('đổi sang KTV KHÔNG đủ skill (kéo sang cột KTV thiếu kỹ năng) → 409 STAFF_LACKS_SKILL, item cũ giữ nguyên', async () => {
    const w = await seedWorld()
    const oldStart = at(14, 0)
    const { itemId } = await seedBooking(w.lan, w.variantId, oldStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: at(15, 0), staff_id: w.hoa })
    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')

    const row = await itemRow(itemId)
    expect(row.staff_id).toBe(w.lan) // vẫn KTV cũ
    expect(row.start_at).toBe(oldStart)
    expect(row.status).toBe('booked')
  })

  it('chỉ đổi GIỜ (không gửi staff_id) → giữ nguyên KTV cũ, đổi đúng giờ', async () => {
    const w = await seedWorld()
    const oldStart = at(14, 0)
    const newStart = at(17, 0)
    const { itemId } = await seedBooking(w.lan, w.variantId, oldStart, 60, 15)

    const { status, body } = await reschedule(itemId, { start_at: newStart })
    expect(status).toBe(200)
    expect(body.item.staff_id).toBe(w.lan)
    expect(body.item.start_at).toBe(newStart)

    const row = await itemRow(itemId)
    expect(row.staff_id).toBe(w.lan)
    expect(row.start_at).toBe(newStart)
  })
})
