import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { localDayBounds } from '../../src/worker/lib/time.ts'

// R1a serial-combo endpoints, against the REAL worker + D1 (no mocking) — same
// harness style as tests/api/appointment-items.test.ts. Each test builds its
// own skills/staff/services so it is isolated from the shared seed (which wipes
// tables) and from tracks running in parallel.

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
  for (const stmt of splitStatements(migrationSql)) await db.prepare(stmt).run()
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
async function insertBusyItem(staffId: number, variantId: number, startAt: number, durationMin: number, bufferMin: number) {
  const cust = await db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, NULL) RETURNING id')
    .bind(`C-${Math.random()}`)
    .first<{ id: number }>()
  const appt = await db
    .prepare(
      `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
       VALUES (?, ?, ?, 'booked', 'admin', 0) RETURNING id`,
    )
    .bind(cust!.id, startAt, startAt + durationMin * 60)
    .first<{ id: number }>()
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  await db
    .prepare(
      `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'booked')`,
    )
    .bind(appt!.id, staffId, variantId, startAt, endAt, blockEndAt)
    .run()
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

// 7 ngày tới, tính động (giống appointment-items.test.ts) để test không tự hết
// hạn theo đồng hồ.
const DATE = (() => {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
})()

describe('POST /api/combo/availability', () => {
  beforeEach(wipe)

  it('happy: một KTV làm được cả hai kỹ năng → coverable:true và có slot', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage, nails]) // holds BOTH
    await insertAllDayShift(lan)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const { status, body } = await post('/api/combo/availability', {
      variant_ids: [vMassage, vNails],
      date: DATE,
    })
    expect(status).toBe(200)
    expect(body.coverable).toBe(true)
    expect(body.slots.length).toBeGreaterThan(0)
    // Only Lan can serve the whole combo.
    for (const s of body.slots) expect(s.staff_ids).toEqual([lan])
  })

  it('SKILL-COVERAGE FAILURE: không KTV nào làm được cả hai → coverable:false, slots rỗng (báo TRƯỚC khi đặt)', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const huong = await insertStaff('Huong', [massage]) // massage only
    const mai = await insertStaff('Mai', [nails]) // nails only — nobody holds both
    await insertAllDayShift(huong)
    await insertAllDayShift(mai)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const { status, body } = await post('/api/combo/availability', {
      variant_ids: [vMassage, vNails],
      date: DATE,
    })
    expect(status).toBe(200)
    expect(body.coverable).toBe(false)
    expect(body.slots).toEqual([])
  })

  it('NO-WINDOW-FITS: KTV đủ kỹ năng nhưng không cửa sổ nào đủ dài cho cả chuỗi → coverable:true, slots rỗng', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage, nails])
    // Shift chỉ 1 tiếng mỗi ngày (weekday nào cũng 09:00–10:00), combo cần >1h.
    for (let wd = 0; wd < 7; wd++) {
      await db
        .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, ?, 540, 600)')
        .bind(lan, wd)
        .run()
    }
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const { status, body } = await post('/api/combo/availability', {
      variant_ids: [vMassage, vNails],
      date: DATE,
    })
    expect(status).toBe(200)
    expect(body.coverable).toBe(true) // someone CAN do it in principle…
    expect(body.slots).toEqual([]) // …just not within any window this day
  })

  it('variant không tồn tại → 404', async () => {
    const { status, body } = await post('/api/combo/availability', { variant_ids: [999999], date: DATE })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('variant_ids rỗng → 422 VALIDATION', async () => {
    const { status, body } = await post('/api/combo/availability', { variant_ids: [], date: DATE })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })
})

describe('POST /api/combo/bookings', () => {
  beforeEach(wipe)

  it('happy 2-service chain: tạo 1 appointment với 2 items nối tiếp trên cùng 1 KTV', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage, nails])
    await insertAllDayShift(lan)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const avail = await post('/api/combo/availability', { variant_ids: [vMassage, vNails], date: DATE })
    const startAt = avail.body.slots[0].start_at as number

    const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Nguyen Thu Ha', phone },
      variant_ids: [vMassage, vNails],
      start_at: startAt,
    })
    expect(status).toBe(201)
    expect(body.staff.id).toBe(lan)
    expect(body.items).toHaveLength(2)
    // Serial: item 2 starts exactly where item 1's block ends.
    const [i1, i2] = body.items
    expect(i1.start_at).toBe(startAt)
    expect(i1.block_end_at).toBe(startAt + (60 + 10) * 60)
    expect(i2.start_at).toBe(i1.block_end_at)
    expect(i2.end_at).toBe(i2.start_at + 45 * 60)
    // Both items belong to the SAME appointment.
    expect(i1.appointment_id).toBe(body.appointment.id)
    expect(i2.appointment_id).toBe(body.appointment.id)

    // The whole combo is retrievable by phone as two items.
    const look = await exports.default.fetch(`https://example.com/api/bookings?phone=${phone}`)
    const lookBody = (await look.json()) as { bookings: unknown[] }
    expect(lookBody.bookings).toHaveLength(2)
  })

  it('skill-coverage fail: đặt combo không KTV nào đủ kỹ năng → 409 STAFF_LACKS_SKILL, KHÔNG tạo gì (no orphan)', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const huong = await insertStaff('Huong', [massage])
    const mai = await insertStaff('Mai', [nails])
    await insertAllDayShift(huong)
    await insertAllDayShift(mai)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600 // 01:00 local — on grid, in future given DATE is +7 days

    const before = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Khach Combo', phone: '0912345000' },
      variant_ids: [vMassage, vNails],
      start_at: startAt,
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')
    // No silent side-effect: not a single appointment or item was created.
    const after = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
    const items = await db.prepare('SELECT COUNT(*) AS n FROM booking_items').first<{ n: number }>()
    expect(items!.n).toBe(0)
  })

  it('no-window-fits: giờ được chọn không có KTV rảnh trọn combo → 409 SLOT_TAKEN, no orphan', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage, nails])
    await insertAllDayShift(lan)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    // Occupy Lan for a huge block covering the chosen start so no window fits.
    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 10 * 3600 // 10:00 local
    await insertBusyItem(lan, vMassage, startAt, 60, 10) // Lan busy right at startAt

    const before = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Khach Combo', phone: '0912345111' },
      variant_ids: [vMassage, vNails],
      start_at: startAt,
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
    const after = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    // Only the pre-existing busy appointment remains; no new combo appointment.
    expect(after!.n).toBe(before!.n)
  })

  it('chọn KTV cụ thể thiếu một skill → 409 STAFF_LACKS_SKILL', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage, nails]) // could do it
    const huong = await insertStaff('Huong', [massage]) // cannot (no nails)
    await insertAllDayShift(lan)
    await insertAllDayShift(huong)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const avail = await post('/api/combo/availability', { variant_ids: [vMassage, vNails], date: DATE })
    const startAt = avail.body.slots[0].start_at as number

    // Force the technician who lacks the nails skill.
    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Khach', phone: '0912300000' },
      variant_ids: [vMassage, vNails],
      start_at: startAt,
      staff_id: huong,
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')
  })
})

// ===========================================================================
// PARALLEL combo (R1b) — many services, DIFFERENT techs, SAME start. The core
// safety property is ATOMICITY: all legs book, or none — never a half-combo.
// ===========================================================================
describe('POST /api/combo/availability?mode=parallel', () => {
  beforeEach(wipe)

  it('song song 2 dịch vụ, 2 KTV đủ skill, khác zone → coverable:true, slot có 2 KTV KHÁC NHAU', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const huong = await insertStaff('Huong', [massage]) // leg1 only
    const mai = await insertStaff('Mai', [nails]) // leg2 only
    await insertAllDayShift(huong)
    await insertAllDayShift(mai)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const { status, body } = await post('/api/combo/availability', {
      variant_ids: [vMassage, vNails],
      date: DATE,
      mode: 'parallel',
    })
    expect(status).toBe(200)
    expect(body.coverable).toBe(true)
    expect(body.slots.length).toBeGreaterThan(0)
    for (const s of body.slots) {
      expect(s.staff_ids).toHaveLength(2)
      expect(new Set(s.staff_ids).size).toBe(2) // distinct techs, one per leg
    }
  })

  it('song song mà chỉ đủ 1 KTV rảnh (dù đủ mọi skill) → coverable:true nhưng slots rỗng (báo trước khi đặt)', async () => {
    // ONE super-tech holds both skills. Serial would work; parallel needs TWO
    // bodies at once → no slot. coverable:true (skills exist, zones ok), 0 slots.
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage, nails])
    await insertAllDayShift(lan)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const { status, body } = await post('/api/combo/availability', {
      variant_ids: [vMassage, vNails],
      date: DATE,
      mode: 'parallel',
    })
    expect(status).toBe(200)
    expect(body.coverable).toBe(true)
    expect(body.slots).toEqual([])
  })

  it('song song 2 dịch vụ CÙNG body_zone → coverable:false (không làm cùng vùng cùng lúc)', async () => {
    const massage = await insertSkill('Massage')
    const scrub = await insertSkill('Tẩy da') // different skill, SAME zone 'body'
    const huong = await insertStaff('Huong', [massage])
    const mai = await insertStaff('Mai', [scrub])
    await insertAllDayShift(huong)
    await insertAllDayShift(mai)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vScrub = await insertVariant(scrub, { duration: 45, buffer: 5, zone: 'body' }) // same zone

    const { status, body } = await post('/api/combo/availability', {
      variant_ids: [vMassage, vScrub],
      date: DATE,
      mode: 'parallel',
    })
    expect(status).toBe(200)
    expect(body.coverable).toBe(false)
    expect(body.slots).toEqual([])
  })
})

describe('POST /api/combo/bookings mode=parallel', () => {
  beforeEach(wipe)

  it('happy: đặt song song → 1 appointment, 2 items cùng start, KTV KHÁC NHAU', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const huong = await insertStaff('Huong', [massage])
    const mai = await insertStaff('Mai', [nails])
    await insertAllDayShift(huong)
    await insertAllDayShift(mai)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const avail = await post('/api/combo/availability', { variant_ids: [vMassage, vNails], date: DATE, mode: 'parallel' })
    const startAt = avail.body.slots[0].start_at as number

    const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Nguyen Song Song', phone },
      variant_ids: [vMassage, vNails],
      start_at: startAt,
      mode: 'parallel',
    })
    expect(status).toBe(201)
    expect(body.items).toHaveLength(2)
    const [i1, i2] = body.items
    // Parallel: BOTH items start at the SAME instant.
    expect(i1.start_at).toBe(startAt)
    expect(i2.start_at).toBe(startAt)
    // Different technicians (one per leg).
    expect(i1.staff_id).not.toBe(i2.staff_id)
    expect(new Set([i1.staff_id, i2.staff_id])).toEqual(new Set([huong, mai]))
    // Same appointment.
    expect(i1.appointment_id).toBe(body.appointment.id)
    expect(i2.appointment_id).toBe(body.appointment.id)
    // Response exposes the per-tech roster so UI shows "ai làm gì".
    expect(body.staff_by_id).toBeDefined()
    expect(new Set(body.staff_by_id.map((s: { id: number }) => s.id))).toEqual(new Set([huong, mai]))
  })

  it('ATOMIC: 1 leg bị cướp KTV giữa preview và đặt → KHÔNG leg nào được đặt (no half-combo)', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const huong = await insertStaff('Huong', [massage]) // ONLY tech for leg1
    const mai = await insertStaff('Mai', [nails]) // ONLY tech for leg2
    await insertAllDayShift(huong)
    await insertAllDayShift(mai)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const avail = await post('/api/combo/availability', { variant_ids: [vMassage, vNails], date: DATE, mode: 'parallel' })
    const startAt = avail.body.slots[0].start_at as number

    // SIMULATE THE RACE: after preview, someone books Mai (leg2's only tech) at
    // exactly startAt for an overlapping block. Now leg2 cannot be staffed.
    await insertBusyItem(mai, vNails, startAt, 45, 5)

    const before = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    const itemsBefore = await db.prepare('SELECT COUNT(*) AS n FROM booking_items').first<{ n: number }>()

    const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Khach Song Song', phone },
      variant_ids: [vMassage, vNails],
      start_at: startAt,
      mode: 'parallel',
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')

    // THE CORE ASSERTION: no half-combo. leg1 (Huong, still free) must NOT be
    // booked on its own — either both legs or none. Only the pre-existing Mai
    // booking may remain; NO new combo appointment, NO new massage item.
    const after = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(after!.n).toBe(before!.n) // no new appointment
    const itemsAfter = await db.prepare('SELECT COUNT(*) AS n FROM booking_items').first<{ n: number }>()
    expect(itemsAfter!.n).toBe(itemsBefore!.n) // no new item at all (leg1 not booked)
    // Huong (leg1's tech) has NO booking → she was not half-committed.
    const huongItems = await db.prepare('SELECT COUNT(*) AS n FROM booking_items WHERE staff_id = ?').bind(huong).first<{ n: number }>()
    expect(huongItems!.n).toBe(0)
  })

  it('đặt song song cùng body_zone → 409 ZONE_CONFLICT, không tạo gì', async () => {
    const massage = await insertSkill('Massage')
    const scrub = await insertSkill('Tẩy da')
    const huong = await insertStaff('Huong', [massage])
    const mai = await insertStaff('Mai', [scrub])
    await insertAllDayShift(huong)
    await insertAllDayShift(mai)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vScrub = await insertVariant(scrub, { duration: 45, buffer: 5, zone: 'body' }) // same zone

    const { start: dayStart } = localDayBounds(DATE)
    const startAt = dayStart + 3600 // 01:00 local, on grid, future

    const before = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Khach', phone: '0912345222' },
      variant_ids: [vMassage, vScrub],
      start_at: startAt,
      mode: 'parallel',
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('ZONE_CONFLICT')
    const after = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(after!.n).toBe(before!.n)
  })

  it('song song không nhận staff_id → 422 VALIDATION', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const huong = await insertStaff('Huong', [massage])
    const mai = await insertStaff('Mai', [nails])
    await insertAllDayShift(huong)
    await insertAllDayShift(mai)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Khach', phone: '0912345333' },
      variant_ids: [vMassage, vNails],
      start_at: localDayBounds(DATE).start + 3600,
      mode: 'parallel',
      staff_id: huong,
    })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })
})

// SERIAL R1a NON-REGRESSION: a booking WITHOUT mode (or mode:'serial') still
// behaves exactly as before — one tech, contiguous items.
describe('serial R1a không hồi quy khi thêm mode', () => {
  beforeEach(wipe)

  it("mode:'serial' tường minh == bỏ trống mode: 1 KTV, 2 item nối tiếp", async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const lan = await insertStaff('Lan', [massage, nails])
    await insertAllDayShift(lan)
    const vMassage = await insertVariant(massage, { duration: 60, buffer: 10, zone: 'body' })
    const vNails = await insertVariant(nails, { duration: 45, buffer: 5, zone: 'hands' })

    const avail = await post('/api/combo/availability', { variant_ids: [vMassage, vNails], date: DATE, mode: 'serial' })
    expect(avail.body.coverable).toBe(true)
    const startAt = avail.body.slots[0].start_at as number

    const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
    const { status, body } = await post('/api/combo/bookings', {
      customer: { name: 'Serial Khach', phone },
      variant_ids: [vMassage, vNails],
      start_at: startAt,
      mode: 'serial',
    })
    expect(status).toBe(201)
    expect(body.staff.id).toBe(lan) // ONE tech for the whole serial combo
    expect(body.items).toHaveLength(2)
    const [i1, i2] = body.items
    expect(i2.start_at).toBe(i1.block_end_at) // contiguous (serial)
    expect(i1.staff_id).toBe(lan)
    expect(i2.staff_id).toBe(lan)
  })
})
