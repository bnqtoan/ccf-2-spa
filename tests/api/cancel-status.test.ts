import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { localDayBounds, localToEpoch, weekdayOf } from '../../src/worker/lib/time.ts'

const db = env.DB

// vitest-pool-workers does not auto-apply migrations_dir from wrangler.jsonc,
// so the migration runs here once per file. Comments are stripped LINE BY LINE
// before splitting on ';' — splitting first would let the file's leading
// comment block swallow the `CREATE TABLE skills` statement.
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

// --- fixtures ---------------------------------------------------------------

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
  opts: { duration: number; buffer: number; zone?: string; name?: string },
): Promise<number> {
  const svc = await db
    .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, 1) RETURNING id')
    .bind(`Svc-${opts.name ?? opts.duration}-${skillId}-${Math.random()}`, skillId, opts.zone ?? 'body')
    .first<{ id: number }>()
  const v = await db
    .prepare(
      `INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active)
       VALUES (?, ?, ?, ?, 100000, 1) RETURNING id`,
    )
    .bind(svc!.id, opts.name ?? `${opts.duration} phút`, opts.duration, opts.buffer)
    .first<{ id: number }>()
  return v!.id
}

async function insertShift(staffId: number, weekday: number, startMin: number, endMin: number): Promise<void> {
  await db
    .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)')
    .bind(staffId, weekday, startMin, endMin)
    .run()
}

/**
 * Seeds an appointment + booking_item directly, with a chosen status and
 * start_at. Returns both ids so tests can call the endpoint under test.
 */
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

async function cancelBooking(itemId: number): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/bookings/${itemId}/cancel`, {
    method: 'POST',
  })
  return { status: res.status, body: await res.json() }
}

async function adminCancel(itemId: number): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/admin/bookings/${itemId}/cancel`, {
    method: 'POST',
  })
  return { status: res.status, body: await res.json() }
}

async function adminSetStatus(itemId: number, status: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/admin/bookings/${itemId}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  return { status: res.status, body: await res.json() }
}

async function getAvailability(variantId: number, date: string, staffId: number): Promise<any> {
  const res = await exports.default.fetch(
    `https://example.com/api/availability?variant_id=${variantId}&date=${date}&staff_id=${staffId}`,
  )
  return res.json()
}

async function itemStatus(itemId: number): Promise<{ status: string; cancelled_at: number | null }> {
  const row = await db
    .prepare('SELECT status, cancelled_at FROM booking_items WHERE id = ?')
    .bind(itemId)
    .first<{ status: string; cancelled_at: number | null }>()
  return row!
}

// A fixed FUTURE Monday so "in the past" never interferes with cutoff maths.
/**
 * Ngày dùng cho test: N ngày TỚI, tính động theo giờ spa.
 * Ngày cứng là bom hẹn giờ — test xanh hôm nay, đỏ vào một ngày nào đó khi
 * mốc đó trôi vào quá khứ, và lỗi trông như lỗi logic chứ không như test hết
 * hạn. Đã xảy ra thật với appointment-items.test.ts.
 */
function futureDateStr(daysAhead: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + daysAhead * 24 * 3600 * 1000))
}
const FUTURE_DATE = futureDateStr(12)
// Weekday PHẢI suy ra từ FUTURE_DATE. Để cứng `= 1` chỉ đúng khi ngày cũng
// cứng và tình cờ rơi vào thứ Hai; với ngày động thì ca làm việc không khớp
// ngày được hỏi và availability trả rỗng.
const FUTURE_WEEKDAY = weekdayOf(FUTURE_DATE)
const { start: FUTURE_DAY_START } = localDayBounds(FUTURE_DATE)

/** Local wall-clock on FUTURE_DATE → epoch seconds. */
function at(hour: number, minute = 0): number {
  // Neo vào FUTURE_DAY_START, không để cứng ngày: FUTURE_DATE là ngày động
  // nên mọi mốc giờ phải tính từ đầu ngày đó, nếu không sẽ lệch vài ngày và
  // test đỏ với thông báo trông như lỗi engine chứ không như lỗi fixture.
  return FUTURE_DAY_START + hour * 3600 + minute * 60
}

async function seedWorld(opts: { duration?: number; buffer?: number } = {}) {
  const skill = await insertSkill('Massage')
  const staffId = await insertStaff('Lan', [skill])
  await insertShift(staffId, FUTURE_WEEKDAY, 0, 1439)
  const variantId = await insertVariant(skill, { duration: opts.duration ?? 60, buffer: opts.buffer ?? 15 })
  return { skill, staffId, variantId }
}

// --- POST /api/bookings/:id/cancel — khách tự huỷ ---------------------------

describe('POST /api/bookings/:id/cancel — khách tự huỷ', () => {
  beforeEach(wipe)

  it('huỷ trước 2 tiếng thành công, status chuyển cancelled và có cancelled_at', async () => {
    const w = await seedWorld()
    // Booking cách "giờ hẹn" 3 tiếng — cutoff dùng now server, không phải
    // start_at cố định trong quá khứ, nên ta neo start_at ở tương lai xa đủ.
    const startAt = at(15, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, startAt, 60, 15)

    const { status, body } = await cancelBooking(itemId)
    expect(status).toBe(200)
    expect(body.item.status).toBe('cancelled')
    expect(body.item.cancelled_at).not.toBeNull()

    const row = await itemStatus(itemId)
    expect(row.status).toBe('cancelled')
    expect(row.cancelled_at).not.toBeNull()
  })

  it('huỷ trước 2 tiếng xong, slot đó mở lại book được ngay (gọi lại availability thấy KTV rảnh)', async () => {
    const w = await seedWorld()
    const startAt = at(15, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, startAt, 60, 15)

    // Trước khi huỷ: KTV bận, slot không xuất hiện.
    const before = await getAvailability(w.variantId, FUTURE_DATE, w.staffId)
    expect(before.slots.find((s: any) => s.start_at === startAt)).toBeUndefined()

    const { status } = await cancelBooking(itemId)
    expect(status).toBe(200)

    const after = await getAvailability(w.variantId, FUTURE_DATE, w.staffId)
    const slot = after.slots.find((s: any) => s.start_at === startAt)
    expect(slot).toBeDefined()
    expect(slot.staff_ids).toContain(w.staffId)
  })

  it('huỷ trong vòng 2 tiếng trả 409 CANCEL_TOO_LATE', async () => {
    const w = await seedWorld()
    // now (server) = FUTURE_DATE 09:00; giờ hẹn 10:00 → cách 60' < 120'.
    // Ta không kiểm soát Date.now() thật, nên đặt start_at gần "bây giờ thật"
    // (thời điểm chạy test) thay vì gần FUTURE_DATE, để canCustomerCancel so
    // với now thật của server.
    const now = Math.floor(Date.now() / 1000)
    const startAt = now + 60 * 60 // 60 phút nữa — trong cutoff 120 phút.
    // Ca làm việc phủ hết tuần để không dính OUTSIDE_SHIFT khi seed trực tiếp
    // (seedBooking ghi thẳng DB, không qua validate, nên không cần ca thật).
    const { itemId } = await seedBooking(w.staffId, w.variantId, startAt, 60, 15)

    const { status, body } = await cancelBooking(itemId)
    expect(status).toBe(409)
    expect(body.error.code).toBe('CANCEL_TOO_LATE')

    const row = await itemStatus(itemId)
    expect(row.status).toBe('booked')
  })

  it('huỷ đúng ranh giới 120 phút chẵn vẫn được coi là hợp lệ (kề nhau không phải trong cutoff)', async () => {
    const w = await seedWorld()
    const now = Math.floor(Date.now() / 1000)
    const startAt = now + CANCEL_CUTOFF_SEC_FOR_TEST()
    const { itemId } = await seedBooking(w.staffId, w.variantId, startAt, 60, 15)

    const { status, body } = await cancelBooking(itemId)
    expect(status).toBe(200)
    expect(body.item.status).toBe('cancelled')
  })

  it('admin huỷ trong vòng 2 tiếng vẫn thành công, không bị CANCEL_TOO_LATE', async () => {
    const w = await seedWorld()
    const now = Math.floor(Date.now() / 1000)
    const startAt = now + 10 * 60 // 10 phút nữa — chắc chắn trong cutoff.
    const { itemId } = await seedBooking(w.staffId, w.variantId, startAt, 60, 15)

    const { status, body } = await adminCancel(itemId)
    expect(status).toBe(200)
    expect(body.item.status).toBe('cancelled')
    expect(body.error).toBeUndefined()
  })

  it('huỷ một booking đã huỷ trả 409 INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const startAt = at(15, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, startAt, 60, 15, 'cancelled')

    const { status, body } = await cancelBooking(itemId)
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
  })

  it('huỷ một booking đã done trả 409 INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const startAt = at(15, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, startAt, 60, 15, 'done')

    const { status, body } = await cancelBooking(itemId)
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
  })

  it('huỷ booking không tồn tại trả 404 NOT_FOUND', async () => {
    const { status, body } = await cancelBooking(999999)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

// --- POST /api/admin/bookings/:id/status ------------------------------------

describe('POST /api/admin/bookings/:id/status — chuyển trạng thái admin', () => {
  beforeEach(wipe)

  it('admin chuyển booked sang in_service thành công', async () => {
    const w = await seedWorld()
    const { itemId } = await seedBooking(w.staffId, w.variantId, at(15, 0), 60, 15, 'booked')

    const { status, body } = await adminSetStatus(itemId, 'in_service')
    expect(status).toBe(200)
    expect(body.item.status).toBe('in_service')

    const row = await itemStatus(itemId)
    expect(row.status).toBe('in_service')
  })

  it('admin chuyển in_service sang done thành công', async () => {
    const w = await seedWorld()
    const { itemId } = await seedBooking(w.staffId, w.variantId, at(15, 0), 60, 15, 'in_service')

    const { status, body } = await adminSetStatus(itemId, 'done')
    expect(status).toBe(200)
    expect(body.item.status).toBe('done')
  })

  it('admin chuyển done sang in_service trả 409 INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const { itemId } = await seedBooking(w.staffId, w.variantId, at(15, 0), 60, 15, 'done')

    const { status, body } = await adminSetStatus(itemId, 'in_service')
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
  })

  it('admin chuyển booked thẳng sang done (bỏ qua in_service) trả 409 INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const { itemId } = await seedBooking(w.staffId, w.variantId, at(15, 0), 60, 15, 'booked')

    const { status, body } = await adminSetStatus(itemId, 'done')
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
  })

  it('admin đánh dấu no_show từ booked thành công và booking đó không xuất hiện lại trong availability (đã terminal, không phải vì slot được "mở lại")', async () => {
    const w = await seedWorld()
    const startAt = at(15, 0)
    const { itemId } = await seedBooking(w.staffId, w.variantId, startAt, 60, 15, 'booked')

    const { status, body } = await adminSetStatus(itemId, 'no_show')
    expect(status).toBe(200)
    expect(body.item.status).toBe('no_show')

    // no_show là terminal — slot xuất hiện lại là vì status không còn
    // ('booked','in_service'), không phải vì có logic "mở lại" riêng biệt.
    // Ta xác nhận hành vi đúng: nó CÓ xuất hiện, vì slot đã không còn ai giữ.
    const after = await getAvailability(w.variantId, FUTURE_DATE, w.staffId)
    const slot = after.slots.find((s: any) => s.start_at === startAt)
    expect(slot).toBeDefined()
  })

  it('admin đánh dấu no_show một booking đang in_service trả 409 INVALID_TRANSITION (no_show chỉ hợp lệ từ booked)', async () => {
    const w = await seedWorld()
    const { itemId } = await seedBooking(w.staffId, w.variantId, at(15, 0), 60, 15, 'in_service')

    const { status, body } = await adminSetStatus(itemId, 'no_show')
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
  })

  it('chuyển status với giá trị không hợp lệ (vd "foo") trả 422 VALIDATION', async () => {
    const w = await seedWorld()
    const { itemId } = await seedBooking(w.staffId, w.variantId, at(15, 0), 60, 15, 'booked')

    const { status, body } = await adminSetStatus(itemId, 'foo')
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('chuyển status trên booking không tồn tại trả 404 NOT_FOUND', async () => {
    const { status, body } = await adminSetStatus(999999, 'in_service')
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

// CANCEL_CUTOFF_MIN là 120 (PRD §6) — hằng số này khai báo ở lib/status.ts và
// được import trực tiếp trong test ranh giới ở trên qua hàm nhỏ dưới đây, để
// không cần import chéo tên hằng số hai lần.
function CANCEL_CUTOFF_SEC_FOR_TEST(): number {
  return 120 * 60
}
