import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { insertBookingAtomically } from '../../src/worker/db/bookings.ts'
import { localDayBounds, localToEpoch } from '../../src/worker/lib/time.ts'
import { validateBooking } from '../../src/worker/lib/validate-booking.ts'

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

async function insertTimeOff(staffId: number, startAt: number, endAt: number): Promise<void> {
  await db
    .prepare('INSERT INTO time_off (staff_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)')
    .bind(staffId, startAt, endAt, 'test')
    .run()
}

/**
 * Seeds a pre-existing booking directly. `end_at` is the service end WITHOUT
 * buffer on purpose, so any code reading the wrong column gives a visibly
 * wrong answer.
 */
async function seedBooking(
  staffId: number,
  variantId: number,
  startAt: number,
  durationMin: number,
  bufferMin: number,
  status = 'booked',
): Promise<void> {
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
  await db
    .prepare(
      `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(appt!.id, staffId, variantId, startAt, endAt, blockEndAt, status)
    .run()
}

interface PostBody {
  customer: { name: string; phone: string }
  variant_id: number
  start_at: number
  staff_id?: number
}

async function postBooking(body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://example.com/api/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function getBookings(query: string): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/bookings?${query}`)
  return { status: res.status, body: await res.json() }
}

// A fixed FUTURE Monday so "no booking in the past" never interferes.
const FUTURE_DATE = '2026-08-03'
const FUTURE_WEEKDAY = 1
const { start: FUTURE_DAY_START } = localDayBounds(FUTURE_DATE)

/** Local wall-clock on FUTURE_DATE → epoch seconds. */
function at(hour: number, minute = 0): number {
  return localToEpoch(2026, 8, 3, hour, minute, 0)
}

async function countItems(): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM booking_items').first<{ n: number }>()
  return r!.n
}

describe('POST /api/bookings — đường ghi cơ bản', () => {
  beforeEach(wipe)

  it('đặt lịch hợp lệ trả 201 và tạo đúng 1 appointment + 1 booking_item', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    } satisfies PostBody)

    expect(status).toBe(201)
    expect(body.appointment).toBeDefined()
    expect(body.item).toBeDefined()
    expect(body.staff.id).toBe(lan)

    const appts = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(appts!.n).toBe(1)
    expect(await countItems()).toBe(1)

    const item = await db.prepare('SELECT * FROM booking_items').first<any>()
    expect(item.staff_id).toBe(lan)
    expect(item.start_at).toBe(at(10, 0))
    expect(item.status).toBe('booked')
  })

  it('booking_item lưu đúng cả end_at lẫn block_end_at, block_end_at = end_at + buffer', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    // duration 60, buffer 15 — cố ý khác nhau để hai cột không thể trùng nhau.
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { status } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    })
    expect(status).toBe(201)

    const item = await db.prepare('SELECT * FROM booking_items').first<any>()
    // end_at = start + duration (KHÔNG gồm buffer) — chỉ để hiển thị.
    expect(item.end_at).toBe(at(11, 0))
    // block_end_at = end_at + buffer — mốc thật sự dùng để chiếm chỗ.
    expect(item.block_end_at).toBe(at(11, 15))
    expect(item.block_end_at - item.end_at).toBe(15 * 60)
  })

  it('variant_id không tồn tại trả 404 NOT_FOUND', async () => {
    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: 999999,
      start_at: at(10, 0),
    })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('khách đã có số điện thoại thì tái sử dụng customer cũ, không tạo bản ghi mới', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const first = await postBooking({
      customer: { name: 'Khách A', phone: '0911222333' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    })
    expect(first.status).toBe(201)

    const second = await postBooking({
      customer: { name: 'Khách A', phone: '0911222333' },
      variant_id: variant,
      start_at: at(14, 0),
      staff_id: lan,
    })
    expect(second.status).toBe(201)

    const custs = await db
      .prepare('SELECT COUNT(*) AS n FROM customers WHERE phone = ?')
      .bind('0911222333')
      .first<{ n: number }>()
    expect(custs!.n).toBe(1)
    // Và cả hai lịch phải trỏ về đúng một customer.
    expect(second.body.appointment.customer_id).toBe(first.body.appointment.customer_id)
  })
})

describe('POST /api/bookings — auto-assign (PRD §4)', () => {
  beforeEach(wipe)

  it('không truyền staff_id thì auto-assign chọn KTV ít phút đặt nhất trong ngày', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Huong', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // Lan (id nhỏ hơn) đã bận 2 ca sáng → nhiều phút hơn hẳn Huong.
    await seedBooking(lan, variant, at(9, 0), 60, 15)
    await seedBooking(lan, variant, at(12, 0), 60, 15)

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(15, 0),
    })

    expect(status).toBe(201)
    // Phải chọn Huong dù Lan có staff_id nhỏ hơn — luật "ít phút nhất" thắng
    // luật phá hoà.
    expect(body.staff.id).toBe(huong)
    expect(body.item.staff_id).toBe(huong)
  })

  it('auto-assign hoà thì chọn staff_id nhỏ hơn (tất định, chạy 2 lần cùng kết quả)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Huong', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    const lower = Math.min(lan, huong)

    // Cả hai đều rảnh hoàn toàn → hoà 0 phút.
    const first = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(10, 0),
    })
    expect(first.status).toBe(201)
    expect(first.body.staff.id).toBe(lower)

    // Chạy lại từ đầu với cùng thế giới: kết quả phải y hệt, không phụ thuộc
    // thứ tự SQL trả về.
    await wipe()
    const skill2 = await insertSkill('Massage')
    const lan2 = await insertStaff('Lan', [skill2])
    const huong2 = await insertStaff('Huong', [skill2])
    await insertShift(lan2, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    await insertShift(huong2, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant2 = await insertVariant(skill2, { duration: 60, buffer: 15 })

    const second = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant2,
      start_at: at(10, 0),
    })
    expect(second.status).toBe(201)
    expect(second.body.staff.id).toBe(Math.min(lan2, huong2))
  })

  it('không ai rảnh khung giờ đó thì auto-assign trả 409 SLOT_TAKEN', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await seedBooking(lan, variant, at(10, 0), 60, 15)

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(10, 0),
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
  })
})

describe('POST /api/bookings — chiếm chỗ và xung đột', () => {
  beforeEach(wipe)

  it('đặt vào slot đã có người trả 409 SLOT_TAKEN', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await seedBooking(lan, variant, at(10, 0), 60, 15)

    const { status, body } = await postBooking({
      customer: { name: 'Khách B', phone: '0900000002' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    })

    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
    // Và tuyệt đối không được ghi thêm gì.
    expect(await countItems()).toBe(1)
  })

  it('đặt chồng lên phần buffer của booking trước trả 409 SLOT_TAKEN', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    // Booking cũ: 10:00, end_at 11:00, block_end_at 11:15.
    await seedBooking(lan, variant, at(10, 0), 60, 15)

    // 11:00 là ĐÚNG end_at. Nếu code lỡ dùng end_at thay block_end_at thì đây
    // sẽ thành 201 và test đỏ — đó chính là mục đích của case này.
    const { status, body } = await postBooking({
      customer: { name: 'Khách B', phone: '0900000002' },
      variant_id: variant,
      start_at: at(11, 0),
      staff_id: lan,
    })

    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
    expect(await countItems()).toBe(1)
  })

  it('đặt ngay tại block_end_at của booking trước thành công (kề nhau hợp lệ)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await seedBooking(lan, variant, at(10, 0), 60, 15)

    // 11:15 = đúng block_end_at. Nửa mở ⇒ kề nhau, KHÔNG chồng.
    const { status } = await postBooking({
      customer: { name: 'Khách B', phone: '0900000002' },
      variant_id: variant,
      start_at: at(11, 15),
      staff_id: lan,
    })

    expect(status).toBe(201)
    expect(await countItems()).toBe(2)
  })

  it('đặt trùng giờ nghỉ phép của KTV trả 409 SLOT_TAKEN', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await insertTimeOff(lan, at(12, 0), at(14, 0))

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(12, 30),
      staff_id: lan,
    })

    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
    expect(await countItems()).toBe(0)
  })

  it('booking đã huỷ không chiếm chỗ nữa', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await seedBooking(lan, variant, at(10, 0), 60, 15, 'cancelled')

    const { status } = await postBooking({
      customer: { name: 'Khách B', phone: '0900000002' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    })
    expect(status).toBe(201)
  })
})

describe('POST /api/bookings — điều kiện tranh chấp (chốt chặn)', () => {
  beforeEach(wipe)

  it('hai request song song cùng slot: đúng một cái 201, một cái 409', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // ĐÚNG MỘT KTV rảnh, hai khách bắn cùng lúc vào cùng một mốc.
    // Promise.all — KHÔNG tuần tự hoá. Đây là lý do tồn tại của cả task này:
    // nếu kiểm tra rảnh/bận nằm NGOÀI transaction thì cả hai đều thấy trống và
    // cả hai đều ghi.
    const [a, b] = await Promise.all([
      postBooking({
        customer: { name: 'Khách A', phone: '0900000001' },
        variant_id: variant,
        start_at: at(10, 0),
        staff_id: lan,
      }),
      postBooking({
        customer: { name: 'Khách B', phone: '0900000002' },
        variant_id: variant,
        start_at: at(10, 0),
        staff_id: lan,
      }),
    ])

    const statuses = [a.status, b.status].sort((x, y) => x - y)
    expect(statuses).toEqual([201, 409])

    const loser = a.status === 409 ? a : b
    expect(loser.body.error.code).toBe('SLOT_TAKEN')

    // Định nghĩa "xong" của card: DB sau đó phải thấy ĐÚNG MỘT item.
    expect(await countItems()).toBe(1)
    // Và không được sót appointment mồ côi từ request thua cuộc.
    const appts = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(appts!.n).toBe(1)
  })

  it('năm request song song cùng slot: đúng một cái 201, bốn cái 409', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        postBooking({
          customer: { name: `Khách ${n}`, phone: `090000000${n}` },
          variant_id: variant,
          start_at: at(10, 0),
          staff_id: lan,
        }),
      ),
    )

    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(4)
    expect(await countItems()).toBe(1)
  })

  it('hai request song song lệch nhau nửa block vẫn chỉ một cái thắng', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // 10:00 chiếm [10:00, 11:15); 10:30 chiếm [10:30, 11:45) — chồng nhau.
    const [a, b] = await Promise.all([
      postBooking({
        customer: { name: 'A', phone: '0900000001' },
        variant_id: variant,
        start_at: at(10, 0),
        staff_id: lan,
      }),
      postBooking({
        customer: { name: 'B', phone: '0900000002' },
        variant_id: variant,
        start_at: at(10, 30),
        staff_id: lan,
      }),
    ])

    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409])
    expect(await countItems()).toBe(1)
  })

  it('hai request song song vào hai mốc kề nhau thì cả hai đều thành công', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // [10:00, 11:15) và [11:15, 12:30) — kề nhau, không chồng. Guard không được
    // "chặn nhầm cho chắc": chặn quá tay cũng là lỗi.
    const [a, b] = await Promise.all([
      postBooking({
        customer: { name: 'A', phone: '0900000001' },
        variant_id: variant,
        start_at: at(10, 0),
        staff_id: lan,
      }),
      postBooking({
        customer: { name: 'B', phone: '0900000002' },
        variant_id: variant,
        start_at: at(11, 15),
        staff_id: lan,
      }),
    ])

    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(await countItems()).toBe(2)
  })
})

// --- điều kiện chống chồng NGAY TRONG câu INSERT ---------------------------
//
// Các test song song ở trên đi qua tầng route, nên chúng chạm tới validate
// thuần TRƯỚC khi chạm tới SQL. Nếu request A kịp ghi xong trước khi request B
// validate, thì chính validate (chứ không phải SQL) là cái chặn B — và lỗi
// trong điều kiện SQL sẽ không lộ ra. Việc A có kịp hay không phụ thuộc timing
// của isolate, tức là KHÔNG tất định.
//
// Nên lớp bảo vệ cuối cùng được kiểm tra thẳng ở tầng DB, bỏ qua route. Ở đây
// không cần chạy song song: chỉ cần seed sẵn một item rồi gọi hàm ghi và xem
// nó có tự chặn không. Đây mới là chốt chặn tất định cho câu lệnh SQL.

describe('insertBookingAtomically — điều kiện chống chồng trong câu INSERT', () => {
  beforeEach(wipe)

  async function seedWorld(duration: number, buffer: number) {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration, buffer })
    const cust = await db
      .prepare("INSERT INTO customers (name, phone) VALUES ('X', '0900000009') RETURNING id")
      .bind()
      .first<{ id: number }>()
    return { skill, lan, variant, customerId: cust!.id }
  }

  function write(w: { customerId: number; lan: number; variant: number }, startAt: number, duration: number, buffer: number) {
    return insertBookingAtomically(db, {
      customer_id: w.customerId,
      staff_id: w.lan,
      variant_id: w.variant,
      start_at: startAt,
      end_at: startAt + duration * 60,
      block_end_at: startAt + (duration + buffer) * 60,
      source: 'online',
      status: 'booked',
      created_at: 0,
    })
  }

  it('chồng lên phần buffer của item có sẵn thì câu INSERT tự từ chối', async () => {
    const w = await seedWorld(60, 30)
    // Item có sẵn: [10:00, 11:30) — end_at 11:00, buffer tới 11:30.
    await seedBooking(w.lan, w.variant, at(10, 0), 60, 30)

    // Ghi vào 11:00 = ĐÚNG end_at của item cũ, nhưng vẫn nằm trong buffer.
    // Nếu điều kiện SQL dùng end_at thay block_end_at thì nó sẽ cho qua.
    const r = await write(w, at(11, 0), 60, 30)

    expect(r.ok).toBe(false)
    expect(await countItems()).toBe(1)
  })

  it('bắt đầu đúng block_end_at của item có sẵn thì câu INSERT cho qua (kề nhau)', async () => {
    const w = await seedWorld(60, 30)
    await seedBooking(w.lan, w.variant, at(10, 0), 60, 30)

    // 11:30 = đúng block_end_at. Nửa mở ⇒ hợp lệ. Điều kiện SQL không được
    // chặn quá tay: chặn nhầm cũng là lỗi, chỉ là lỗi im lặng hơn.
    const r = await write(w, at(11, 30), 60, 30)

    expect(r.ok).toBe(true)
    expect(await countItems()).toBe(2)
  })

  it('trùng giờ nghỉ phép thì câu INSERT tự từ chối, không ghi dòng nào', async () => {
    const w = await seedWorld(60, 15)
    await insertTimeOff(w.lan, at(12, 0), at(14, 0))

    // Nghỉ phép có thể được tạo (T-07) SAU khi client đã cầm availability, nên
    // điều kiện time_off trong câu INSERT là lớp chặn cuối cùng.
    const r = await write(w, at(12, 30), 60, 15)

    expect(r.ok).toBe(false)
    expect(await countItems()).toBe(0)
    // Và không được sót appointment mồ côi.
    const appts = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(appts!.n).toBe(0)
  })

  it('kề đúng biên giờ nghỉ phép thì câu INSERT cho qua', async () => {
    const w = await seedWorld(60, 15)
    await insertTimeOff(w.lan, at(12, 0), at(14, 0))

    // [10:30, 11:45) kết thúc trước 12:00 → không chồng.
    const r = await write(w, at(10, 30), 60, 15)
    expect(r.ok).toBe(true)
  })

  it('item đã huỷ không làm câu INSERT từ chối', async () => {
    const w = await seedWorld(60, 15)
    await seedBooking(w.lan, w.variant, at(10, 0), 60, 15, 'cancelled')

    const r = await write(w, at(10, 0), 60, 15)
    expect(r.ok).toBe(true)
  })

  it('request thua cuộc không để lại appointment mồ côi', async () => {
    const w = await seedWorld(60, 15)
    await seedBooking(w.lan, w.variant, at(10, 0), 60, 15)
    const before = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()

    const r = await write(w, at(10, 0), 60, 15)
    expect(r.ok).toBe(false)

    // Cả hai câu INSERT dùng CHUNG một điều kiện, nên bên thua không ghi gì cả
    // — không có dòng appointment nào phát sinh để phải dọn.
    const after = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })
})

describe('POST /api/bookings — validation PRD §11', () => {
  beforeEach(wipe)

  it('chọn KTV không có skill trả 409 STAFF_LACKS_SKILL', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const mai = await insertStaff('Mai', [nails])
    await insertShift(mai, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const massageVariant = await insertVariant(massage, { duration: 60, buffer: 15 })

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: massageVariant,
      start_at: at(10, 0),
      staff_id: mai,
    })

    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')
    expect(await countItems()).toBe(0)
  })

  it('đặt ngoài ca làm việc trả 409 OUTSIDE_SHIFT', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    // Ca chỉ 09:00–12:00.
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 12 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(15, 0),
      staff_id: lan,
    })

    expect(status).toBe(409)
    expect(body.error.code).toBe('OUTSIDE_SHIFT')
    expect(await countItems()).toBe(0)
  })

  it('buffer tràn qua giờ đóng cửa cũng là OUTSIDE_SHIFT', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    // Ca 09:00–11:00; block = 60 + 15 = 75 phút.
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 11 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // 10:00 + 75' = 11:15 — phần tràn ra chỉ là buffer dọn dẹp, vẫn phải chặn.
    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('OUTSIDE_SHIFT')

    // Còn 09:45 + 75' = 11:00 đúng biên đóng cửa → hợp lệ (nửa mở).
    const ok = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(9, 45),
      staff_id: lan,
    })
    expect(ok.status).toBe(201)
  })

  it('start_at lệch lưới 15 phút trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(10, 7),
      staff_id: lan,
    })

    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
    expect(await countItems()).toBe(0)
  })

  it('đặt trong quá khứ trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    // Ca phủ trọn mọi ngày trong tuần để lỗi không phải là OUTSIDE_SHIFT.
    for (let wd = 0; wd < 7; wd++) await insertShift(lan, wd, 0, 1439)

    // Một mốc trên lưới 15 phút nhưng thuộc quá khứ (2020).
    const past = localToEpoch(2020, 1, 6, 10, 0, 0)

    const { status, body } = await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: past,
      staff_id: lan,
    })

    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
    expect(await countItems()).toBe(0)
  })

  it('thiếu tên khách trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { status, body } = await postBooking({
      customer: { phone: '0900000001' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('thiếu số điện thoại trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { status, body } = await postBooking({
      customer: { name: 'Khách A' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })
})

// --- validateBooking: cờ isWalkIn (T-08 sẽ dùng lại) ------------------------
//
// Kiểm tra thẳng hàm thuần, vì T-04 không có endpoint walk-in. Đây là hợp đồng
// mà T-08 sẽ gọi — nếu nó trôi, T-08 sẽ phải copy-paste luật lần hai.

describe('validateBooking — cờ isWalkIn', () => {
  const variant = { duration_min: 60, buffer_after_min: 15 }
  const NOW = at(10, 0)
  // Ca 09:00–19:00 dưới dạng khoảng epoch cụ thể.
  const shiftWindows = [{ start: at(9, 0), end: at(19, 0) }]
  const shifts = [{ staff_id: 1, start_min: 9 * 60, end_min: 19 * 60 }]

  const base = {
    variant,
    staff_id: 1,
    staffHasSkill: true,
    shifts,
    shiftWindows,
    timeOff: [],
    busyItems: [],
    now: NOW,
  }

  it('validate với isWalkIn=true chấp nhận start_at lệch lưới 15 phút', async () => {
    const offGrid = at(10, 7)

    // Đường online: lệch lưới → VALIDATION.
    expect(validateBooking({ ...base, start_at: offGrid, isWalkIn: false })).toEqual({
      code: 'VALIDATION',
      message: expect.any(String),
    })

    // Walk-in: cùng mốc đó phải được chấp nhận.
    expect(validateBooking({ ...base, start_at: offGrid, isWalkIn: true })).toBeNull()
  })

  it('validate với isWalkIn=true chấp nhận start_at ở quá khứ gần (khách vừa tới)', () => {
    const justNow = at(9, 52) // vài phút trước NOW, lệch lưới luôn
    expect(validateBooking({ ...base, start_at: justNow, isWalkIn: false })?.code).toBe('VALIDATION')
    expect(validateBooking({ ...base, start_at: justNow, isWalkIn: true })).toBeNull()
  })

  it('validate với isWalkIn=true vẫn chặn KTV thiếu skill', () => {
    const r = validateBooking({
      ...base,
      start_at: at(10, 7),
      staffHasSkill: false,
      isWalkIn: true,
    })
    expect(r?.code).toBe('STAFF_LACKS_SKILL')
  })

  it('validate với isWalkIn=true vẫn chặn khi KTV đang bận', () => {
    const r = validateBooking({
      ...base,
      start_at: at(10, 7),
      busyItems: [{ staff_id: 1, start_at: at(10, 0), block_end_at: at(11, 15) }],
      isWalkIn: true,
    })
    expect(r?.code).toBe('SLOT_TAKEN')
  })

  it('validate với isWalkIn=true vẫn chặn khi ra ngoài ca làm việc', () => {
    const r = validateBooking({
      ...base,
      start_at: at(20, 7),
      now: at(20, 0),
      isWalkIn: true,
    })
    expect(r?.code).toBe('OUTSIDE_SHIFT')
  })

  it('validate với isWalkIn=true vẫn chặn khi trùng giờ nghỉ phép', () => {
    const r = validateBooking({
      ...base,
      start_at: at(10, 7),
      timeOff: [{ staff_id: 1, start_at: at(10, 0), end_at: at(12, 0) }],
      isWalkIn: true,
    })
    expect(r?.code).toBe('SLOT_TAKEN')
  })

  it('mặc định không truyền cờ thì áp luật online (lưới 15 phút vẫn bị chặn)', () => {
    // Chữ ký để mặc định false — T-04 gọi mà quên truyền vẫn phải an toàn.
    const r = validateBooking({ ...base, start_at: at(10, 7) })
    expect(r?.code).toBe('VALIDATION')
  })

  it('booking hợp lệ đúng lưới trả null', () => {
    expect(validateBooking({ ...base, start_at: at(10, 0) })).toBeNull()
  })

  it('kề đúng block_end_at của item trước là hợp lệ, không phải chồng', () => {
    const r = validateBooking({
      ...base,
      start_at: at(11, 15),
      busyItems: [{ staff_id: 1, start_at: at(10, 0), block_end_at: at(11, 15) }],
    })
    expect(r).toBeNull()
  })
})

describe('GET /api/bookings?phone=', () => {
  beforeEach(wipe)

  it('GET /api/bookings?phone= trả đúng lịch của số đó, không lẫn số khác', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(10, 0),
      staff_id: lan,
    })
    await postBooking({
      customer: { name: 'Khách A', phone: '0900000001' },
      variant_id: variant,
      start_at: at(14, 0),
      staff_id: lan,
    })
    await postBooking({
      customer: { name: 'Khách B', phone: '0900000002' },
      variant_id: variant,
      start_at: at(16, 0),
      staff_id: lan,
    })

    const { status, body } = await getBookings('phone=0900000001')
    expect(status).toBe(200)
    expect(body.bookings).toHaveLength(2)
    // Sắp xếp tăng dần theo start_at.
    expect(body.bookings.map((b: any) => b.start_at)).toEqual([at(10, 0), at(14, 0)])
    // Không lẫn lịch 16:00 của số khác.
    expect(body.bookings.map((b: any) => b.start_at)).not.toContain(at(16, 0))
    // Kèm tên KTV và tên dịch vụ.
    expect(body.bookings[0].staff_name).toBe('Lan')
    expect(typeof body.bookings[0].service_name).toBe('string')
  })

  it('GET /api/bookings thiếu phone trả 422 VALIDATION', async () => {
    const { status, body } = await getBookings('')
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('số điện thoại chưa từng đặt trả danh sách rỗng, không phải lỗi', async () => {
    const { status, body } = await getBookings('phone=0999999999')
    expect(status).toBe(200)
    expect(body.bookings).toEqual([])
  })
})
