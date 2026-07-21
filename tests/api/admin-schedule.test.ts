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

async function seedBooking(
  staffId: number,
  variantId: number,
  startAt: number,
  durationMin: number,
  bufferMin: number,
  status = 'booked',
  customerName = 'Khách A',
): Promise<number> {
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const cust = await db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, NULL) RETURNING id')
    .bind(customerName)
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

async function getSchedule(date: string | undefined): Promise<{ status: number; body: any }> {
  const url =
    date === undefined
      ? 'https://example.com/api/admin/schedule'
      : `https://example.com/api/admin/schedule?date=${encodeURIComponent(date)}`
  const res = await exports.default.fetch(url)
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
