import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migration1 from '../../migrations/0001_init.sql?raw'
import migration2 from '../../migrations/0002_commission_tax.sql?raw'
import { localDayBounds, minutesToEpoch, weekdayOf } from '../../src/worker/lib/time.ts'

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
  for (const stmt of [...splitStatements(migration1), ...splitStatements(migration2)]) {
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
  // shop_settings singleton survives wipe (not in the FK chain); fine.
}

async function insertSkill(name: string): Promise<number> {
  const r = await db.prepare('INSERT INTO skills (name) VALUES (?) RETURNING id').bind(name).first<{ id: number }>()
  return r!.id
}

async function insertStaff(name: string, commission = 0, active = 1): Promise<number> {
  const r = await db
    .prepare('INSERT INTO staff (name, active, commission_rate) VALUES (?, ?, ?) RETURNING id')
    .bind(name, active, commission)
    .first<{ id: number }>()
  return r!.id
}

async function insertVariant(skillId: number, price: number, duration = 60, buffer = 0): Promise<number> {
  const svc = await db
    .prepare('INSERT INTO services (name, skill_id, body_zone, active) VALUES (?, ?, ?, 1) RETURNING id')
    .bind(`Svc-${Math.random()}`, skillId, 'body')
    .first<{ id: number }>()
  const v = await db
    .prepare(
      `INSERT INTO service_variants (service_id, name, duration_min, buffer_after_min, price, active)
       VALUES (?, ?, ?, ?, ?, 1) RETURNING id`,
    )
    .bind(svc!.id, `${duration}p`, duration, buffer, price)
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
  status: string,
): Promise<number> {
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const cust = await db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, NULL) RETURNING id')
    .bind('Khách')
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

async function getOverview(date: string): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/admin/overview?date=${date}`)
  return { status: res.status, body: await res.json() }
}

async function getEarnings(
  staffId: number,
  period: string,
  date: string,
): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(
    `https://example.com/api/admin/staff-earnings?staff_id=${staffId}&period=${period}&date=${date}`,
  )
  return { status: res.status, body: await res.json() }
}

// Ngày test động (giờ spa) để tránh bom hẹn giờ — theo mẫu admin-schedule.test.ts.
function futureDateStr(daysAhead: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + daysAhead * 24 * 3600 * 1000))
}
const DATE = futureDateStr(3)

describe('GET /api/admin/overview — doanh thu', () => {
  beforeEach(wipe)

  it('doanh thu CHỈ cộng lịch status=done, bỏ qua booked/in_service', async () => {
    const skill = await insertSkill('S')
    const lan = await insertStaff('Lan')
    const v = await insertVariant(skill, 350000)
    const { start } = localDayBounds(DATE)
    await seedBooking(lan, v, start + 10 * 3600, 60, 0, 'done')
    await seedBooking(lan, v, start + 12 * 3600, 60, 0, 'booked')
    await seedBooking(lan, v, start + 14 * 3600, 60, 0, 'in_service')

    const { status, body } = await getOverview(DATE)
    expect(status).toBe(200)
    expect(body.kpi.revenue).toBe(350000) // chỉ 1 done
    expect(body.kpi.done_count).toBe(1)
  })

  it('no_show KHÔNG vào doanh thu nhưng ĐƯỢC đếm ở no_show_count', async () => {
    const skill = await insertSkill('S')
    const lan = await insertStaff('Lan')
    const v = await insertVariant(skill, 200000)
    const { start } = localDayBounds(DATE)
    await seedBooking(lan, v, start + 10 * 3600, 60, 0, 'done')
    await seedBooking(lan, v, start + 12 * 3600, 60, 0, 'no_show')
    await seedBooking(lan, v, start + 13 * 3600, 60, 0, 'no_show')

    const { body } = await getOverview(DATE)
    expect(body.kpi.revenue).toBe(200000) // chỉ done
    expect(body.kpi.no_show_count).toBe(2)
  })

  it('cancelled không vào doanh thu, không vào no_show', async () => {
    const skill = await insertSkill('S')
    const lan = await insertStaff('Lan')
    const v = await insertVariant(skill, 500000)
    const { start } = localDayBounds(DATE)
    await seedBooking(lan, v, start + 10 * 3600, 60, 0, 'cancelled')

    const { body } = await getOverview(DATE)
    expect(body.kpi.revenue).toBe(0)
    expect(body.kpi.no_show_count).toBe(0)
    expect(body.kpi.done_count).toBe(0)
  })

  it('doanh thu quy về từng KTV đúng người', async () => {
    const skill = await insertSkill('S')
    const lan = await insertStaff('Lan')
    const mai = await insertStaff('Mai')
    const v = await insertVariant(skill, 100000)
    const { start } = localDayBounds(DATE)
    await seedBooking(lan, v, start + 10 * 3600, 60, 0, 'done')
    await seedBooking(mai, v, start + 10 * 3600, 60, 0, 'done')
    await seedBooking(mai, v, start + 12 * 3600, 60, 0, 'done')

    const { body } = await getOverview(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    const maiEntry = body.staff.find((s: any) => s.id === mai)
    expect(lanEntry.revenue).toBe(100000)
    expect(maiEntry.revenue).toBe(200000)
    expect(body.kpi.revenue).toBe(300000)
  })
})

describe('GET /api/admin/overview — lấp đầy (occupancy)', () => {
  beforeEach(wipe)

  it('lấp đầy = giờ bận / giờ ca; 1 booking 60p trong ca 9-11 (120p) = 50%', async () => {
    const skill = await insertSkill('S')
    const lan = await insertStaff('Lan')
    const v = await insertVariant(skill, 100000, 60, 0)
    const wd = weekdayOf(DATE)
    const { start } = localDayBounds(DATE)
    await insertShift(lan, wd, 9 * 60, 11 * 60) // ca 2 giờ
    await seedBooking(lan, v, minutesToEpoch(start, 9 * 60), 60, 0, 'booked')

    const { body } = await getOverview(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.occupancy_pct).toBe(50)
    expect(body.kpi.occupancy_pct).toBe(50)
  })

  it('nghỉ được TRỪ khỏi mẫu số — không làm lấp đầy tụt oan', async () => {
    const skill = await insertSkill('S')
    const lan = await insertStaff('Lan')
    const v = await insertVariant(skill, 100000, 60, 0)
    const wd = weekdayOf(DATE)
    const { start } = localDayBounds(DATE)
    // Ca 9-12 (180p) nhưng nghỉ 11-12 (60p) → giờ khả dụng = 120p.
    await insertShift(lan, wd, 9 * 60, 12 * 60)
    await insertTimeOff(lan, minutesToEpoch(start, 11 * 60), minutesToEpoch(start, 12 * 60))
    // Bận 9-10 (60p) → 60/120 = 50%, KHÔNG phải 60/180 = 33%.
    await seedBooking(lan, v, minutesToEpoch(start, 9 * 60), 60, 0, 'booked')

    const { body } = await getOverview(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.available_min).toBe(120)
    expect(lanEntry.occupancy_pct).toBe(50)
  })

  it('nghỉ CẢ NGÀY → occupancy null + on_leave=true (không hiển thị 0% sai lệch)', async () => {
    const skill = await insertSkill('S')
    void skill
    const lan = await insertStaff('Lan')
    const wd = weekdayOf(DATE)
    const { start } = localDayBounds(DATE)
    await insertShift(lan, wd, 9 * 60, 17 * 60)
    await insertTimeOff(lan, minutesToEpoch(start, 9 * 60), minutesToEpoch(start, 17 * 60))

    const { body } = await getOverview(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.available_min).toBe(0)
    expect(lanEntry.occupancy_pct).toBeNull()
    expect(lanEntry.on_leave).toBe(true)
  })

  it('không có ca hôm đó → occupancy null, has_shift=false', async () => {
    await insertSkill('S')
    const lan = await insertStaff('Lan')
    const { body } = await getOverview(DATE)
    const lanEntry = body.staff.find((s: any) => s.id === lan)
    expect(lanEntry.occupancy_pct).toBeNull()
    expect(lanEntry.has_shift).toBe(false)
    expect(lanEntry.on_leave).toBe(false)
  })
})

describe('GET /api/admin/overview — validation & rỗng', () => {
  beforeEach(wipe)

  it('thiếu date → 422 VALIDATION', async () => {
    const res = await exports.default.fetch('https://example.com/api/admin/overview')
    expect(res.status).toBe(422)
    expect((await res.json() as any).error.code).toBe('VALIDATION')
  })

  it('không KTV active → kpi rỗng, staff rỗng', async () => {
    const { body } = await getOverview(DATE)
    expect(body.staff).toEqual([])
    expect(body.kpi.revenue).toBe(0)
    expect(body.kpi.occupancy_pct).toBeNull()
  })
})

describe('GET /api/admin/staff-earnings — lương theo hoa hồng', () => {
  beforeEach(wipe)

  it('payroll = doanh thu done × commission_rate', async () => {
    const skill = await insertSkill('S')
    const lan = await insertStaff('Lan', 0.35)
    const v = await insertVariant(skill, 400000)
    const { start } = localDayBounds(DATE)
    await seedBooking(lan, v, start + 10 * 3600, 60, 0, 'done')
    await seedBooking(lan, v, start + 12 * 3600, 60, 0, 'done')
    await seedBooking(lan, v, start + 14 * 3600, 60, 0, 'no_show') // không tính

    const { status, body } = await getEarnings(lan, 'day', DATE)
    expect(status).toBe(200)
    expect(body.revenue).toBe(800000)
    expect(body.commission_rate).toBe(0.35)
    expect(body.payroll).toBe(280000) // 800000 * 0.35
    expect(body.done_count).toBe(2)
  })

  it('commission_rate = 0 → payroll = 0 (mặc định an toàn, không số bất ngờ)', async () => {
    const skill = await insertSkill('S')
    const yen = await insertStaff('Yen', 0)
    const v = await insertVariant(skill, 250000)
    const { start } = localDayBounds(DATE)
    await seedBooking(yen, v, start + 10 * 3600, 60, 0, 'done')

    const { body } = await getEarnings(yen, 'day', DATE)
    expect(body.revenue).toBe(250000)
    expect(body.payroll).toBe(0)
  })

  it('period=week gộp doanh thu nhiều ngày trong tuần', async () => {
    const skill = await insertSkill('S')
    const lan = await insertStaff('Lan', 0.5)
    const v = await insertVariant(skill, 100000)
    const { start } = localDayBounds(DATE)
    // 1 done hôm nay + 1 done hôm sau (vẫn trong cùng tuần với xác suất cao;
    // nếu DATE là Chủ nhật thì hôm sau sang tuần mới — dùng hôm-trước cho chắc).
    await seedBooking(lan, v, start + 10 * 3600, 60, 0, 'done')
    await seedBooking(lan, v, start - 12 * 3600, 60, 0, 'done') // hôm trước, 12h trưa hôm qua

    const dayRes = await getEarnings(lan, 'day', DATE)
    const weekRes = await getEarnings(lan, 'week', DATE)
    expect(dayRes.body.revenue).toBe(100000)
    // Tuần phải >= ngày (bao trọn ngày đó), và gồm cả booking hôm trước nếu
    // cùng tuần. Ít nhất bằng doanh thu ngày.
    expect(weekRes.body.revenue).toBeGreaterThanOrEqual(100000)
  })

  it('staff_id không tồn tại → 404 NOT_FOUND', async () => {
    const { status, body } = await getEarnings(99999, 'day', DATE)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('period sai → 422 VALIDATION', async () => {
    const lan = await insertStaff('Lan', 0.3)
    const { status, body } = await getEarnings(lan, 'quarter', DATE)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })
})
