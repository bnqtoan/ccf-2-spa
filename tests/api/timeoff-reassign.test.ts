import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { reassignItemAtomically } from '../../src/worker/db/timeoff.ts'
import { localToEpoch } from '../../src/worker/lib/time.ts'

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

// --- fixtures --------------------------------------------------------------

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
  opts: { duration: number; buffer: number; serviceName?: string; variantName?: string },
): Promise<number> {
  const svc = await db
    .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, 1) RETURNING id')
    .bind(opts.serviceName ?? `Gội đầu dưỡng sinh ${Math.random()}`, skillId, 'body')
    .first<{ id: number }>()
  const v = await db
    .prepare(
      `INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active)
       VALUES (?, ?, ?, ?, 100000, 1) RETURNING id`,
    )
    .bind(svc!.id, opts.variantName ?? `${opts.duration} phút`, opts.duration, opts.buffer)
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
 * Seeds one booking directly. `end_at` is the service end WITHOUT buffer on
 * purpose, so any code reading the wrong column gives a visibly wrong answer.
 */
async function seedBooking(opts: {
  staffId: number
  variantId: number
  startAt: number
  durationMin: number
  bufferMin: number
  status?: string
  customerName?: string
  customerPhone?: string | null
}): Promise<number> {
  const endAt = opts.startAt + opts.durationMin * 60
  const blockEndAt = endAt + opts.bufferMin * 60
  const status = opts.status ?? 'booked'
  const cust = await db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id')
    .bind(opts.customerName ?? `Khách ${Math.random()}`, opts.customerPhone === undefined ? null : opts.customerPhone)
    .first<{ id: number }>()
  const appt = await db
    .prepare(
      `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
       VALUES (?, ?, ?, ?, 'online', 0) RETURNING id`,
    )
    .bind(cust!.id, opts.startAt, endAt, status)
    .first<{ id: number }>()
  const item = await db
    .prepare(
      `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(appt!.id, opts.staffId, opts.variantId, opts.startAt, endAt, blockEndAt, status)
    .first<{ id: number }>()
  return item!.id
}

async function postTimeOff(body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://x.test/api/admin/time-off', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function deleteTimeOffApi(id: number): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://x.test/api/admin/time-off/${id}`, { method: 'DELETE' })
  return { status: res.status, body: await res.json() }
}

async function getQueue(): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://x.test/api/admin/reassign-queue')
  return { status: res.status, body: await res.json() }
}

async function getCandidates(itemId: number): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://x.test/api/admin/bookings/${itemId}/reassign-candidates`)
  return { status: res.status, body: await res.json() }
}

async function postReassign(itemId: number, staffId: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://x.test/api/admin/bookings/${itemId}/reassign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staff_id: staffId }),
  })
  return { status: res.status, body: await res.json() }
}

// A fixed FUTURE Monday.
const FUTURE_WEEKDAY = 1
function at(hour: number, minute = 0): number {
  return localToEpoch(2026, 8, 3, hour, minute, 0)
}

async function itemRow(id: number): Promise<any> {
  return db.prepare('SELECT * FROM booking_items WHERE id = ?').bind(id).first<any>()
}

/** Two skilled technicians on a full 09:00–19:00 shift, one 60+15 variant. */
async function seedWorld() {
  const skill = await insertSkill('Massage')
  const lan = await insertStaff('Lan', [skill])
  const huong = await insertStaff('Hương', [skill])
  await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
  await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
  const variant = await insertVariant(skill, { duration: 60, buffer: 15, serviceName: 'Massage vai gáy' })
  return { skill, lan, huong, variant }
}

describe('POST /api/admin/time-off — tạo nghỉ phép và phơi bày hậu quả', () => {
  beforeEach(wipe)

  it('tạo time-off không đè booking nào trả affected_items rỗng', async () => {
    const w = await seedWorld()
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })

    // Nghỉ buổi chiều, booking buổi sáng — không dính nhau.
    const { status, body } = await postTimeOff({
      staff_id: w.lan,
      start_at: at(15, 0),
      end_at: at(17, 0),
      reason: 'Việc riêng',
    })

    expect(status).toBe(200)
    expect(body.time_off.id).toBeTypeOf('number')
    expect(body.affected_items).toEqual([])
  })

  it('tạo time-off đè 2 booking trả đúng 2 affected_items', async () => {
    const w = await seedWorld()
    const a = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    const b = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(13, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    // Lịch của KTV khác trong cùng khung giờ KHÔNG được lọt vào.
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })

    const { status, body } = await postTimeOff({
      staff_id: w.lan,
      start_at: at(9, 0),
      end_at: at(18, 0),
      reason: 'Ốm',
    })

    expect(status).toBe(200)
    expect(body.affected_items).toHaveLength(2)
    expect(body.affected_items.map((i: any) => i.item_id).sort((x: number, y: number) => x - y)).toEqual(
      [a, b].sort((x, y) => x - y),
    )
  })

  it('time-off vẫn được tạo dù có booking bị ảnh hưởng (không trả lỗi)', async () => {
    const w = await seedWorld()
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })

    const { status, body } = await postTimeOff({
      staff_id: w.lan,
      start_at: at(9, 0),
      end_at: at(18, 0),
      reason: 'Ốm',
    })

    // Không 409, không 422 — KTV đã nghỉ rồi, chối bỏ sự thật không giúp ai.
    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    const row = await db.prepare('SELECT COUNT(*) AS n FROM time_off').first<{ n: number }>()
    expect(row!.n).toBe(1)
  })

  it('affected_items giữ nguyên status booked và staff_id cũ', async () => {
    const w = await seedWorld()
    const a = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    const { body } = await postTimeOff({ staff_id: w.lan, start_at: at(9, 0), end_at: at(18, 0), reason: 'Ốm' })
    expect(body.affected_items).toHaveLength(1)

    // Không tự huỷ, không tự chuyển — một người thật phải gọi cho khách.
    const row = await itemRow(a)
    expect(row.status).toBe('booked')
    expect(row.staff_id).toBe(w.lan)
    expect(row.cancelled_at).toBeNull()
    expect(body.affected_items[0].status).toBe('booked')
    expect(body.affected_items[0].staff_id).toBe(w.lan)
  })

  it('affected_items có đủ tên khách và số điện thoại để gọi', async () => {
    const w = await seedWorld()
    await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
      customerName: 'Chị Thu',
      customerPhone: '0912345678',
    })

    const { body } = await postTimeOff({ staff_id: w.lan, start_at: at(9, 0), end_at: at(18, 0), reason: 'Ốm' })

    const item = body.affected_items[0]
    expect(item.customer_name).toBe('Chị Thu')
    expect(item.customer_phone).toBe('0912345678')
    expect(item.service_name).toBe('Massage vai gáy')
    expect(item.start_at).toBe(at(10, 0))
    expect(item.staff_name).toBe('Lan')
  })

  it('time-off bắt đầu đúng tại block_end_at của booking thì booking đó không bị ảnh hưởng', async () => {
    const w = await seedWorld()
    // [10:00, 11:15): end_at 11:00, block_end_at 11:15.
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })

    const { body } = await postTimeOff({ staff_id: w.lan, start_at: at(11, 15), end_at: at(13, 0), reason: 'Việc' })

    // Nửa mở: kề nhau không phải chồng.
    expect(body.affected_items).toEqual([])
  })

  it('time-off chỉ đè phần buffer vẫn tính là ảnh hưởng', async () => {
    const w = await seedWorld()
    // block_end_at = 11:15; buffer là [11:00, 11:15).
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })

    // Bắt đầu nghỉ đúng 11:00 = end_at. Nếu code dùng end_at thay block_end_at
    // thì đây sẽ ra rỗng — đó chính là mục đích của case này.
    const { body } = await postTimeOff({ staff_id: w.lan, start_at: at(11, 0), end_at: at(13, 0), reason: 'Việc' })

    expect(body.affected_items).toHaveLength(1)
    expect(body.affected_items[0].start_at).toBe(at(10, 0))
  })

  it('booking đã cancelled không vào affected_items', async () => {
    const w = await seedWorld()
    await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
      status: 'cancelled',
    })
    await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(13, 0),
      durationMin: 60,
      bufferMin: 15,
      status: 'done',
    })

    const { body } = await postTimeOff({ staff_id: w.lan, start_at: at(9, 0), end_at: at(18, 0), reason: 'Ốm' })
    expect(body.affected_items).toEqual([])
  })

  it('start_at không nhỏ hơn end_at trả 422 VALIDATION', async () => {
    const w = await seedWorld()
    const { status, body } = await postTimeOff({ staff_id: w.lan, start_at: at(12, 0), end_at: at(12, 0) })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('staff_id không tồn tại trả 404 NOT_FOUND', async () => {
    const { status, body } = await postTimeOff({ staff_id: 999999, start_at: at(12, 0), end_at: at(13, 0) })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

describe('GET /api/admin/reassign-queue — hàng chờ suy ra từ dữ liệu sống', () => {
  beforeEach(wipe)

  it('reassign-queue trả các item mồ côi, sắp xếp theo start_at tăng dần', async () => {
    const w = await seedWorld()
    // Cố ý seed theo thứ tự ngược: 15:00 trước, rồi 10:00.
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(15, 0), durationMin: 60, bufferMin: 15 })
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })
    // Lịch của KTV không nghỉ — không được vào hàng chờ.
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(11, 0), durationMin: 60, bufferMin: 15 })

    await postTimeOff({ staff_id: w.lan, start_at: at(9, 0), end_at: at(18, 0), reason: 'Ốm' })

    const { status, body } = await getQueue()
    expect(status).toBe(200)
    expect(body.items).toHaveLength(2)
    // Khách gần giờ nhất phải gọi trước.
    expect(body.items.map((i: any) => i.start_at)).toEqual([at(10, 0), at(15, 0)])
    expect(body.items.every((i: any) => i.staff_id === w.lan)).toBe(true)
  })

  it('xoá time-off thì hàng chờ rỗng trở lại', async () => {
    const w = await seedWorld()
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })

    const created = await postTimeOff({ staff_id: w.lan, start_at: at(9, 0), end_at: at(18, 0), reason: 'Ốm' })
    expect((await getQueue()).body.items).toHaveLength(1)

    const del = await deleteTimeOffApi(created.body.time_off.id)
    expect(del.status).toBe(200)

    // Hàng chờ là suy ra, không phải cờ: xoá nghỉ phép là nó tự rỗng.
    expect((await getQueue()).body.items).toEqual([])
  })

  it('time-off chỉ đè phần buffer vẫn đưa item vào hàng chờ', async () => {
    const w = await seedWorld()
    // [10:00, 11:15): end_at 11:00, buffer là [11:00, 11:15).
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })
    // Nghỉ từ đúng 11:00 = end_at. KTV không kịp dọn dẹp ⇒ vẫn phải vào hàng chờ.
    // Nếu câu truy vấn hàng chờ dùng end_at thay block_end_at thì đây sẽ ra rỗng.
    await postTimeOff({ staff_id: w.lan, start_at: at(11, 0), end_at: at(13, 0), reason: 'Việc' })

    const { body } = await getQueue()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].start_at).toBe(at(10, 0))
  })

  it('time-off bắt đầu đúng block_end_at thì item KHÔNG vào hàng chờ', async () => {
    const w = await seedWorld()
    await seedBooking({ staffId: w.lan, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })
    // 11:15 = đúng block_end_at. Nửa mở ⇒ kề nhau, không chồng.
    // Hàng chờ cũng không được chặn quá tay.
    await postTimeOff({ staff_id: w.lan, start_at: at(11, 15), end_at: at(13, 0), reason: 'Việc' })

    expect((await getQueue()).body.items).toEqual([])
  })

  it('xoá time-off không tồn tại trả 404 NOT_FOUND', async () => {
    const { status, body } = await deleteTimeOffApi(999999)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('huỷ booking thì nó cũng rời hàng chờ mà không cần đụng vào time-off', async () => {
    const w = await seedWorld()
    const a = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    await postTimeOff({ staff_id: w.lan, start_at: at(9, 0), end_at: at(18, 0), reason: 'Ốm' })
    expect((await getQueue()).body.items).toHaveLength(1)

    await db.prepare("UPDATE booking_items SET status = 'cancelled' WHERE id = ?").bind(a).run()

    // Không có cột cờ nào phải đồng bộ — hàng chờ tự đúng.
    expect((await getQueue()).body.items).toEqual([])
  })
})

describe('GET /api/admin/bookings/:id/reassign-candidates — kèm lý do', () => {
  beforeEach(wipe)

  function candidateFor(body: any, staffId: number) {
    return body.candidates.find((c: any) => c.staff.id === staffId)
  }

  it('reassign-candidates đánh dấu KTV thiếu skill là không đủ điều kiện, kèm lý do', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage])
    const mai = await insertStaff('Mai', [nails])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    await insertShift(mai, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(massage, { duration: 60, buffer: 15 })
    const item = await seedBooking({
      staffId: lan,
      variantId: variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    const { status, body } = await getCandidates(item)
    expect(status).toBe(200)
    const mai_ = candidateFor(body, mai)
    expect(mai_.eligible).toBe(false)
    expect(mai_.reason).toBe('STAFF_LACKS_SKILL')
    expect(typeof mai_.message).toBe('string')
    expect(mai_.message.length).toBeGreaterThan(0)
    // KTV đang giữ item không tự xuất hiện trong danh sách ứng viên.
    expect(candidateFor(body, lan)).toBeUndefined()
  })

  it('reassign-candidates đánh dấu KTV bận giờ đó là không đủ điều kiện, kèm lý do', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    // Hương đã có khách đúng khung giờ đó.
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })

    const { body } = await getCandidates(item)
    const huong = candidateFor(body, w.huong)
    expect(huong.eligible).toBe(false)
    expect(huong.reason).toBe('SLOT_TAKEN')
  })

  it('reassign-candidates đánh dấu KTV ngoài ca là không đủ điều kiện, kèm lý do', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Hương', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    // Hương chỉ làm ca sáng.
    await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 12 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    const item = await seedBooking({
      staffId: lan,
      variantId: variant,
      startAt: at(15, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    const { body } = await getCandidates(item)
    const h = candidateFor(body, huong)
    expect(h.eligible).toBe(false)
    expect(h.reason).toBe('OUTSIDE_SHIFT')
  })

  it('reassign-candidates đánh dấu KTV đang nghỉ phép là không đủ điều kiện, kèm lý do riêng', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    await postTimeOff({ staff_id: w.huong, start_at: at(9, 0), end_at: at(18, 0), reason: 'Nghỉ phép' })

    const { body } = await getCandidates(item)
    const huong = candidateFor(body, w.huong)
    expect(huong.eligible).toBe(false)
    // "Đang nghỉ" và "đang bận khách khác" dẫn tới hai cuộc gọi khác nhau.
    expect(huong.reason).toBe('ON_TIME_OFF')
  })

  it('reassign-candidates đánh dấu KTV rảnh và đủ skill là đủ điều kiện, không kèm lý do', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    const { body } = await getCandidates(item)
    const huong = candidateFor(body, w.huong)
    expect(huong.eligible).toBe(true)
    expect(huong.reason).toBeNull()
  })

  it('KTV kề đúng block_end_at của item vẫn đủ điều kiện (kề nhau không phải chồng)', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    // Hương bận [11:15, 12:30) — bắt đầu đúng block_end_at của item.
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(11, 15), durationMin: 60, bufferMin: 15 })

    const { body } = await getCandidates(item)
    expect(candidateFor(body, w.huong).eligible).toBe(true)
  })

  it('KTV bận đúng phần buffer của item là KHÔNG đủ điều kiện', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    // Hương bận [11:00, 12:15) — chồng đúng 15 phút buffer của item.
    // Nếu ứng viên được xét bằng end_at thay block_end_at thì đây sẽ ra eligible.
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(11, 0), durationMin: 60, bufferMin: 15 })

    const { body } = await getCandidates(item)
    expect(candidateFor(body, w.huong).eligible).toBe(false)
    expect(candidateFor(body, w.huong).reason).toBe('SLOT_TAKEN')
  })

  it('item không tồn tại trả 404 NOT_FOUND', async () => {
    const { status, body } = await getCandidates(999999)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

describe('POST /api/admin/bookings/:id/reassign — chuyển KTV', () => {
  beforeEach(wipe)

  it('reassign sang KTV hợp lệ trả 200 và đổi staff_id', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    const { status, body } = await postReassign(item, w.huong)
    expect(status).toBe(200)
    expect(body.item.staff_id).toBe(w.huong)

    const row = await itemRow(item)
    expect(row.staff_id).toBe(w.huong)
    // Giờ giấc không đổi — reassign chuyển người, không chuyển lịch.
    expect(row.start_at).toBe(at(10, 0))
    expect(row.block_end_at).toBe(at(11, 15))
    expect(row.status).toBe('booked')
  })

  it('sau khi reassign, item rời khỏi reassign-queue', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    await postTimeOff({ staff_id: w.lan, start_at: at(9, 0), end_at: at(18, 0), reason: 'Ốm' })
    expect((await getQueue()).body.items).toHaveLength(1)

    expect((await postReassign(item, w.huong)).status).toBe(200)

    expect((await getQueue()).body.items).toEqual([])
  })

  it('reassign sang KTV thiếu skill trả 409 STAFF_LACKS_SKILL', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage])
    const mai = await insertStaff('Mai', [nails])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    await insertShift(mai, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(massage, { duration: 60, buffer: 15 })
    const item = await seedBooking({
      staffId: lan,
      variantId: variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    const { status, body } = await postReassign(item, mai)
    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')
    // Và item phải nằm nguyên chỗ cũ.
    expect((await itemRow(item)).staff_id).toBe(lan)
  })

  it('reassign sang KTV đang bận giờ đó trả 409 SLOT_TAKEN', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(10, 30), durationMin: 60, bufferMin: 15 })

    const { status, body } = await postReassign(item, w.huong)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
    expect((await itemRow(item)).staff_id).toBe(w.lan)
  })

  it('reassign sang KTV chỉ chồng phần buffer trả 409 SLOT_TAKEN', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    // Hương bận [11:00, 12:15): chỉ chạm 15 phút buffer của item.
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(11, 0), durationMin: 60, bufferMin: 15 })

    const { status, body } = await postReassign(item, w.huong)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
  })

  it('reassign sang KTV ngoài ca trả 409 OUTSIDE_SHIFT', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Hương', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 12 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    const item = await seedBooking({
      staffId: lan,
      variantId: variant,
      startAt: at(15, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    const { status, body } = await postReassign(item, huong)
    expect(status).toBe(409)
    expect(body.error.code).toBe('OUTSIDE_SHIFT')
  })

  it('reassign sang KTV đang nghỉ phép trả 409 SLOT_TAKEN', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    await postTimeOff({ staff_id: w.huong, start_at: at(9, 0), end_at: at(18, 0), reason: 'Nghỉ' })

    const { status, body } = await postReassign(item, w.huong)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
    expect((await itemRow(item)).staff_id).toBe(w.lan)
  })

  it('reassign item đã cancelled trả 409 INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
      status: 'cancelled',
    })

    const { status, body } = await postReassign(item, w.huong)
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
    expect((await itemRow(item)).staff_id).toBe(w.lan)
  })

  it('reassign item đã done trả 409 INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
      status: 'done',
    })

    const { status, body } = await postReassign(item, w.huong)
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVALID_TRANSITION')
  })

  it('reassign item không tồn tại trả 404 NOT_FOUND', async () => {
    const w = await seedWorld()
    const { status, body } = await postReassign(999999, w.huong)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('reassign sang KTV không tồn tại trả 404 NOT_FOUND', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    const { status, body } = await postReassign(item, 999999)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('reassign hai item vào cùng KTV cùng khung giờ: cái thứ hai trả 409 SLOT_TAKEN', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const mai = await insertStaff('Mai', [skill])
    const huong = await insertStaff('Hương', [skill])
    for (const s of [lan, mai, huong]) await insertShift(s, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // Hai item khác KTV, CÙNG khung giờ. Cả hai cùng nhắm vào Hương đang rảnh.
    const first = await seedBooking({
      staffId: lan,
      variantId: variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    const second = await seedBooking({
      staffId: mai,
      variantId: variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    const a = await postReassign(first, huong)
    const b = await postReassign(second, huong)

    expect(a.status).toBe(200)
    expect(b.status).toBe(409)
    expect(b.body.error.code).toBe('SLOT_TAKEN')

    // Hương chỉ được giữ đúng một item trong khung giờ đó.
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM booking_items WHERE staff_id = ? AND status IN ('booked','in_service')")
      .bind(huong)
      .first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('hai reassign song song vào cùng KTV cùng khung giờ: đúng một cái thắng', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const mai = await insertStaff('Mai', [skill])
    const huong = await insertStaff('Hương', [skill])
    for (const s of [lan, mai, huong]) await insertShift(s, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const first = await seedBooking({
      staffId: lan,
      variantId: variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    const second = await seedBooking({
      staffId: mai,
      variantId: variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    // Promise.all — KHÔNG tuần tự hoá. Hai lễ tân bấm cùng lúc.
    const [a, b] = await Promise.all([postReassign(first, huong), postReassign(second, huong)])

    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409])
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM booking_items WHERE staff_id = ? AND status IN ('booked','in_service')")
      .bind(huong)
      .first<{ n: number }>()
    expect(n!.n).toBe(1)
  })
})

// --- điều kiện chống chồng NGAY TRONG câu UPDATE ---------------------------
//
// Các test qua tầng route chạm validate thuần TRƯỚC khi chạm SQL, nên nếu
// request A kịp ghi xong trước khi B validate thì chính validate (không phải
// SQL) là cái chặn B — và lỗi trong điều kiện SQL sẽ không lộ ra. Timing của
// isolate là KHÔNG tất định.
//
// Nên lớp bảo vệ cuối cùng được kiểm tra thẳng ở tầng DB, bỏ qua route: seed
// sẵn xung đột rồi gọi hàm ghi và xem nó có tự chặn không.

describe('reassignItemAtomically — điều kiện re-check trong câu UPDATE', () => {
  beforeEach(wipe)

  it('KTV mới đã bận thì câu UPDATE tự từ chối, không đổi staff_id', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(10, 0), durationMin: 60, bufferMin: 15 })

    const r = await reassignItemAtomically(db, {
      item_id: item,
      new_staff_id: w.huong,
      start_at: at(10, 0),
      block_end_at: at(11, 15),
    })

    expect(r.ok).toBe(false)
    expect((await itemRow(item)).staff_id).toBe(w.lan)
  })

  it('KTV mới chỉ bận phần buffer thì câu UPDATE vẫn từ chối', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    // [11:00, 12:15): 11:00 là ĐÚNG end_at của item. Nếu điều kiện SQL dùng
    // end_at thay block_end_at thì nó sẽ cho qua.
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(11, 0), durationMin: 60, bufferMin: 15 })

    const r = await reassignItemAtomically(db, {
      item_id: item,
      new_staff_id: w.huong,
      start_at: at(10, 0),
      block_end_at: at(11, 15),
    })

    expect(r.ok).toBe(false)
    expect((await itemRow(item)).staff_id).toBe(w.lan)
  })

  it('KTV mới bận đúng từ block_end_at trở đi thì câu UPDATE cho qua (kề nhau)', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    await seedBooking({ staffId: w.huong, variantId: w.variant, startAt: at(11, 15), durationMin: 60, bufferMin: 15 })

    const r = await reassignItemAtomically(db, {
      item_id: item,
      new_staff_id: w.huong,
      start_at: at(10, 0),
      block_end_at: at(11, 15),
    })

    // Chặn quá tay cũng là lỗi, chỉ là lỗi im lặng hơn.
    expect(r.ok).toBe(true)
    expect((await itemRow(item)).staff_id).toBe(w.huong)
  })

  it('KTV mới đang nghỉ phép thì câu UPDATE tự từ chối', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })
    await db
      .prepare('INSERT INTO time_off (staff_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)')
      .bind(w.huong, at(9, 0), at(18, 0), 'Nghỉ')
      .run()

    const r = await reassignItemAtomically(db, {
      item_id: item,
      new_staff_id: w.huong,
      start_at: at(10, 0),
      block_end_at: at(11, 15),
    })

    expect(r.ok).toBe(false)
    expect((await itemRow(item)).staff_id).toBe(w.lan)
  })

  it('item đã cancelled thì câu UPDATE từ chối với INVALID_TRANSITION', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
      status: 'cancelled',
    })

    const r = await reassignItemAtomically(db, {
      item_id: item,
      new_staff_id: w.huong,
      start_at: at(10, 0),
      block_end_at: at(11, 15),
    })

    expect(r).toEqual({ ok: false, reason: 'INVALID_TRANSITION' })
    expect((await itemRow(item)).staff_id).toBe(w.lan)
  })

  it('item cũ của chính nó không tự chặn chính nó', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    // Hương hoàn toàn rảnh: chỉ có đúng item này tồn tại trong khung giờ đó.
    const r = await reassignItemAtomically(db, {
      item_id: item,
      new_staff_id: w.huong,
      start_at: at(10, 0),
      block_end_at: at(11, 15),
    })
    expect(r.ok).toBe(true)
  })

  it('ghi lại chính item vào chính KTV đang giữ nó không bị coi là tự chồng lên mình', async () => {
    const w = await seedWorld()
    const item = await seedBooking({
      staffId: w.lan,
      variantId: w.variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
    })

    // Trường hợp duy nhất mà `other.id <> ?` trong câu UPDATE thực sự gánh việc:
    // KTV đích ĐANG giữ chính item này. Thiếu điều kiện đó, item sẽ khớp với
    // chính nó trong NOT EXISTS và câu lệnh tự từ chối một cách vô lý.
    const r = await reassignItemAtomically(db, {
      item_id: item,
      new_staff_id: w.lan,
      start_at: at(10, 0),
      block_end_at: at(11, 15),
    })

    expect(r.ok).toBe(true)
    expect((await itemRow(item)).staff_id).toBe(w.lan)
  })
})

// --- kịch bản "định nghĩa xong" của card ------------------------------------

describe('kịch bản đầy đủ: KTV nghỉ đột xuất', () => {
  beforeEach(wipe)

  it('2 lịch bị phủ → 2 affected_items → chuyển 1 thành công → còn 1 chưa xử lý', async () => {
    const skill = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const a = await insertStaff('KTV A', [skill])
    const b = await insertStaff('KTV B', [skill])
    const cStaff = await insertStaff('KTV C', [nails]) // thiếu skill
    for (const s of [a, b, cStaff]) await insertShift(s, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const item1 = await seedBooking({
      staffId: a,
      variantId: variant,
      startAt: at(10, 0),
      durationMin: 60,
      bufferMin: 15,
      customerName: 'Khách 1',
      customerPhone: '0900000001',
    })
    const item2 = await seedBooking({
      staffId: a,
      variantId: variant,
      startAt: at(14, 0),
      durationMin: 60,
      bufferMin: 15,
      customerName: 'Khách 2',
      customerPhone: '0900000002',
    })

    const off = await postTimeOff({ staff_id: a, start_at: at(9, 0), end_at: at(18, 0), reason: 'Ốm đột xuất' })
    expect(off.status).toBe(200)
    expect(off.body.affected_items).toHaveLength(2)

    expect((await getQueue()).body.items.map((i: any) => i.item_id)).toEqual([item1, item2])

    // Chuyển item 1 sang B (đủ skill, rảnh).
    expect((await postReassign(item1, b)).status).toBe(200)
    expect((await getQueue()).body.items.map((i: any) => i.item_id)).toEqual([item2])

    // Thử chuyển item 2 sang C thiếu skill.
    const failed = await postReassign(item2, cStaff)
    expect(failed.status).toBe(409)
    expect(failed.body.error.code).toBe('STAFF_LACKS_SKILL')

    // Hàng chờ vẫn còn đúng 1 item chưa xử lý — công việc dở dang phải nhìn thấy được.
    expect((await getQueue()).body.items).toHaveLength(1)
    expect((await itemRow(item2)).staff_id).toBe(a)
  })
})
