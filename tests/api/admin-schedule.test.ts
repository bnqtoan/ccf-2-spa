import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { localDayBounds, weekdayOf } from '../../src/worker/lib/time.ts'
import { issueSessionToken, SESSION_COOKIE, type AuthUser } from '../../src/worker/lib/auth.ts'
import { adminCookieHeader } from './_authCookie.ts'

const SECRET = 'test-session-secret' // khớp vitest.config.ts miniflare.bindings

/** T-32: cookie technician thuần ký bằng payload AuthUser — KHÔNG cần chèn
 *  bảng `users`, vì `adminAuthGuard` chỉ verify chữ ký + đọc role/staffId từ
 *  payload đã ký (xem src/worker/routes/index.ts, `app.use('/api/admin/*',
 *  adminAuthGuard)`), không tra DB. */
async function technicianCookieHeader(staffId: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const user: AuthUser = { userId: 999, role: 'technician', staffId }
  const token = await issueSessionToken(SECRET, now, 12 * 3600, user)
  return `${SESSION_COOKIE}=${token}`
}

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

async function insertTimeOff(staffId: number, startAt: number, endAt: number, reason = 'nghỉ'): Promise<number> {
  const r = await db
    .prepare('INSERT INTO time_off (staff_id, start_at, end_at, reason) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(staffId, startAt, endAt, reason)
    .first<{ id: number }>()
  return r!.id
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
  customerName = 'Khách A',
  customerPhone: string | null = null,
): Promise<number> {
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const cust = await db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id')
    .bind(customerName, customerPhone)
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
  return item!.id
}

async function getSchedule(
  date: string | undefined,
  cookie?: string,
): Promise<{ status: number; body: any }> {
  const url =
    date === undefined
      ? 'https://example.com/api/admin/schedule'
      : `https://example.com/api/admin/schedule?date=${encodeURIComponent(date)}`
  const res = await exports.default.fetch(url, { headers: { cookie: cookie ?? (await adminCookieHeader()) } })
  return { status: res.status, body: await res.json() }
}

/** T-31: chế độ range `?from=&to=` trên CÙNG route — dùng cho week view. */
async function getScheduleRange(
  from: string,
  to: string,
  cookie?: string,
): Promise<{ status: number; body: any }> {
  const url = `https://example.com/api/admin/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  const res = await exports.default.fetch(url, { headers: { cookie: cookie ?? (await adminCookieHeader()) } })
  return { status: res.status, body: await res.json() }
}

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
const DATE = futureDateStr(7)
const OTHER_DATE = futureDateStr(5)

describe('GET /api/admin/schedule', () => {
  beforeEach(wipe)

  it('trả mọi KTV active kèm item của họ trong ngày', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })
    const { start: dayStart } = localDayBounds(DATE)
    const itemId = await seedBooking(lan, variant, dayStart + 3600, 60, 10)

    const { status, body } = await getSchedule(DATE)
    expect(status).toBe(200)
    expect(body.date).toBe(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry).toBeDefined()
    expect(lanEntry.items.map((i: any) => i.id)).toContain(itemId)
  })

  it('KTV không có lịch vẫn xuất hiện với mảng items rỗng', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry).toBeDefined()
    expect(lanEntry.items).toEqual([])
  })

  it('KTV CÓ ca weekday của ngày → trả shift {start_min,end_min}', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertShift(lan, weekdayOf(DATE), 540, 1140) // 09:00–19:00 đúng weekday

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.shift).toEqual({ start_min: 540, end_min: 1140 })
  })

  it('KTV KHÔNG có ca weekday của ngày → shift = null (client tô mờ cột)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    // Ca chỉ có ở weekday KHÁC → không áp cho DATE.
    await insertShift(lan, (weekdayOf(DATE) + 1) % 7, 540, 1140)

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.shift).toBeNull()
  })

  it('nhiều dòng ca cùng weekday → shift bao ngoài [min start, max end]', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const wd = weekdayOf(DATE)
    await insertShift(lan, wd, 540, 720) // sáng 09:00–12:00
    await insertShift(lan, wd, 780, 1140) // chiều 13:00–19:00

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.shift).toEqual({ start_min: 540, end_min: 1140 })
  })

  it('KTV inactive không xuất hiện trên lịch', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill], 0)

    const { body } = await getSchedule(DATE)
    expect(body.staff.find((s: any) => s.id === lan)).toBeUndefined()
  })

  it('item của ngày khác không lọt vào', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: otherDayStart } = localDayBounds(OTHER_DATE)
    await seedBooking(lan, variant, otherDayStart + 3600, 60, 0)

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.items).toEqual([])
  })

  it('booking vắt qua nửa đêm vẫn xuất hiện ở ngày hôm sau', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 30 })
    const { start: dayStart } = localDayBounds(DATE)
    // Bắt đầu 23:30 hôm trước (start_at < dayStart), block kéo dài qua dayStart.
    const startAt = dayStart - 30 * 60
    const itemId = await seedBooking(lan, variant, startAt, 60, 30)

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.items.map((i: any) => i.id)).toContain(itemId)
  })

  it('item cancelled không xuất hiện trên lịch', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)
    await seedBooking(lan, variant, dayStart + 3600, 60, 0, 'cancelled')

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.items).toEqual([])
  })

  it('item trả đủ start_at, end_at và block_end_at để UI vẽ được buffer', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600
    await seedBooking(lan, variant, startAt, 60, 10)

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    const item = lanEntry.items[0]
    expect(item.start_at).toBe(startAt)
    expect(item.end_at).toBe(startAt + 60 * 60)
    expect(item.block_end_at).toBe(startAt + 70 * 60)
    expect(item.block_end_at).toBeGreaterThan(item.end_at)
    expect(item.customer_name).toBeDefined()
    expect(item.service_name).toBeDefined()
    expect(item.variant_name).toBeDefined()
    expect(item.status).toBeDefined()
    expect(item.source).toBeDefined()
  })

  // T-32: sheet chi tiết cần SĐT để lễ tân gọi khách ngay từ lịch bình
  // thường (trước đây chỉ hàng chờ reassign mới thấy số).
  it('item trả kèm customer_phone khi khách có số', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)
    const itemId = await seedBooking(lan, variant, dayStart + 3600, 60, 0, 'booked', 'Khách A', '0909111222')

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    const item = lanEntry.items.find((i: any) => i.id === itemId)
    expect(item.customer_phone).toBe('0909111222')
  })

  it('item trả customer_phone null khi khách lẻ không có số (CONVENTIONS §4)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)
    const itemId = await seedBooking(lan, variant, dayStart + 3600, 60, 0, 'booked', 'Khách vãng lai', null)

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    const item = lanEntry.items.find((i: any) => i.id === itemId)
    expect(item.customer_phone).toBeNull()
  })

  it('technician xem lịch CỦA MÌNH vẫn thấy customer_phone (mặc định phục vụ khách đó)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)
    const itemId = await seedBooking(lan, variant, dayStart + 3600, 60, 0, 'booked', 'Khách A', '0909111222')

    const { status, body } = await getSchedule(DATE, await technicianCookieHeader(lan))
    expect(status).toBe(200)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    const item = lanEntry.items.find((i: any) => i.id === itemId)
    expect(item.customer_phone).toBe('0909111222')
  })

  // T-25: sheet "+ Thêm dịch vụ" gọi POST /api/admin/appointments/:id/items —
  // cần appointment_id của item để biết gọi đúng appointment nào.
  it('item trả kèm appointment_id để UI gọi được API thêm dịch vụ vào đúng appointment', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 0 })
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600
    const itemId = await seedBooking(lan, variant, startAt, 60, 0)

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    const item = lanEntry.items.find((i: any) => i.id === itemId)
    expect(item.appointment_id).toBeDefined()
    expect(Number.isInteger(item.appointment_id)).toBe(true)
  })

  it('time_off của KTV trong ngày được trả kèm', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const { start: dayStart } = localDayBounds(DATE)
    const timeOffId = await insertTimeOff(lan, dayStart + 3600, dayStart + 7200, 'khám bệnh')

    const { body } = await getSchedule(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.time_off.map((t: any) => t.id)).toContain(timeOffId)
    const off = lanEntry.time_off.find((t: any) => t.id === timeOffId)
    expect(off.reason).toBe('khám bệnh')
  })

  it('thiếu date trả 422 VALIDATION', async () => {
    const { status, body } = await getSchedule(undefined)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('date sai định dạng trả 422 VALIDATION', async () => {
    const { status, body } = await getSchedule('22-07-2026')
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })
})

describe('GET /api/admin/schedule — giới hạn bound params của D1', () => {
  beforeEach(wipe)

  // D1 chỉ cho 100 bound params mỗi statement (không phải 999 như SQLite bản
  // thường). Bản đầu bind từng staff_id qua `IN (?, ?, …)` nên spa có ~98+ KTV
  // active nhận HTTP 500 — đã tái hiện thật với 120 KTV, và nó chặn đứng cả
  // trang /admin/timeline. Query giờ lọc bằng JOIN staff active nên số param
  // cố định là 2.
  it('spa có 120 kỹ thuật viên active vẫn trả 200, không vỡ vì giới hạn tham số', async () => {
    const skill = await insertSkill('Massage')
    for (let i = 0; i < 120; i++) await insertStaff(`KTV${i}`, [skill])

    const { status, body } = await getSchedule(DATE)
    expect(status).toBe(200)
    expect(body.staff.length).toBe(120)
  })

  it('với nhiều KTV, booking vẫn về đúng cột của đúng người', async () => {
    const skill = await insertSkill('Massage')
    const ids: number[] = []
    for (let i = 0; i < 110; i++) ids.push(await insertStaff(`KTV${i}`, [skill]))
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })
    const { start: dayStart } = localDayBounds(DATE)
    await seedBooking(ids[77]!, variant, dayStart + 3600, 60, 10)

    const { body } = await getSchedule(DATE)
    const withItems = body.staff.filter((s: any) => s.items.length > 0)
    expect(withItems.length).toBe(1)
    expect(withItems[0].id).toBe(ids[77])
  })
})

// T-31: chế độ range `?from=&to=` — week view. Ngày ĐỘNG (futureDateStr),
// không hard-code (CONVENTIONS §8).
function addDaysStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y!, m! - 1, d! + delta))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

describe('GET /api/admin/schedule?from=&to= — chế độ range (T-31 week view)', () => {
  beforeEach(wipe)

  const FROM = futureDateStr(10)
  const TO = addDaysStr(FROM, 6) // đúng 7 ngày (inclusive)

  it('trả đúng 7 ngày liên tiếp, mỗi ngày kèm mọi KTV active', async () => {
    const skill = await insertSkill('Massage')
    await insertStaff('Lan', [skill])

    const { status, body } = await getScheduleRange(FROM, TO)
    expect(status).toBe(200)
    expect(body.from).toBe(FROM)
    expect(body.to).toBe(TO)
    expect(body.days.length).toBe(7)
    expect(body.days.map((d: any) => d.date)).toEqual([
      FROM,
      addDaysStr(FROM, 1),
      addDaysStr(FROM, 2),
      addDaysStr(FROM, 3),
      addDaysStr(FROM, 4),
      addDaysStr(FROM, 5),
      TO,
    ])
    for (const day of body.days) {
      expect(day.staff.find((s: any) => s.name === 'Lan')).toBeDefined()
    }
  })

  it('ngày có lịch và ngày trống trả khác nhau — item chỉ nằm đúng ngày của nó', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })
    const day3 = addDaysStr(FROM, 3)
    const { start: day3Start } = localDayBounds(day3)
    const itemId = await seedBooking(lan, variant, day3Start + 3600, 60, 10)

    const { body } = await getScheduleRange(FROM, TO)
    const busyDay = body.days.find((d: any) => d.date === day3)
    const emptyDay = body.days.find((d: any) => d.date === FROM)

    const busyLan = busyDay.staff.find((s: any) => s.id === lan)
    const emptyLan = emptyDay.staff.find((s: any) => s.id === lan)
    expect(busyLan.items.map((i: any) => i.id)).toContain(itemId)
    expect(emptyLan.items).toEqual([])
  })

  it('range hơn 7 ngày bị từ chối 422 VALIDATION', async () => {
    const tooFar = addDaysStr(FROM, 8)
    const { status, body } = await getScheduleRange(FROM, tooFar)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('to trước from bị từ chối 422 VALIDATION', async () => {
    const { status, body } = await getScheduleRange(TO, FROM)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('from/to sai định dạng trả 422 VALIDATION', async () => {
    const { status, body } = await getScheduleRange('10-08-2026', TO)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('chỉ truyền from (thiếu to) trả 422 VALIDATION', async () => {
    const res = await exports.default.fetch(
      `https://example.com/api/admin/schedule?from=${encodeURIComponent(FROM)}`,
      { headers: { cookie: await adminCookieHeader() } },
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect((body as any).error.code).toBe('VALIDATION')
  })

  // T-32: giữ hình dạng payload nhất quán giữa `?date=` và `?from=&to=` —
  // week view không cần RENDER phone nhưng field vẫn phải có mặt trong data.
  it('item trong chế độ range cũng kèm customer_phone (nhất quán với chế độ ngày)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })
    const day3 = addDaysStr(FROM, 3)
    const { start: day3Start } = localDayBounds(day3)
    const itemId = await seedBooking(lan, variant, day3Start + 3600, 60, 10, 'booked', 'Khách A', '0909111222')

    const { body } = await getScheduleRange(FROM, TO)
    const busyDay = body.days.find((d: any) => d.date === day3)
    const busyLan = busyDay.staff.find((s: any) => s.id === lan)
    const item = busyLan.items.find((i: any) => i.id === itemId)
    expect(item.customer_phone).toBe('0909111222')
  })

  it('booking vắt qua nửa đêm ở đầu range vẫn xuất hiện đúng ngày nó chiếm chỗ', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 30 })
    const { start: fromStart } = localDayBounds(FROM)
    // Bắt đầu 23:30 hôm trước FROM (start_at < fromStart), block kéo dài qua fromStart.
    const startAt = fromStart - 30 * 60
    const itemId = await seedBooking(lan, variant, startAt, 60, 30)

    const { body } = await getScheduleRange(FROM, TO)
    const firstDay = body.days.find((d: any) => d.date === FROM)
    const lanEntry = firstDay.staff.find((s: any) => s.id === lan)
    expect(lanEntry.items.map((i: any) => i.id)).toContain(itemId)
  })
})
