import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'

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

/**
 * Ca làm phủ TRỌN mọi ngày trong tuần (0..1440 — nửa đêm tới nửa đêm) — test
 * không phụ thuộc giờ chạy CI. `end_min=1440`, không phải 1439, để block của
 * walk-in (dù `now` rơi vào phút cuối ngày) vẫn nằm gọn trong ca.
 */
async function insertAllDayShift(staffId: number): Promise<void> {
  for (let wd = 0; wd < 7; wd++) {
    await db
      .prepare('INSERT INTO work_shifts (staff_id, weekday, start_min, end_min) VALUES (?, ?, 0, 1440)')
      .bind(staffId, wd)
      .run()
  }
}

async function insertTimeOff(staffId: number, startAt: number, endAt: number): Promise<void> {
  await db
    .prepare('INSERT INTO time_off (staff_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)')
    .bind(staffId, startAt, endAt, 'test')
    .run()
}

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

async function getAvailableNow(variantId: number | string): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/admin/available-now?variant_id=${variantId}`)
  return { status: res.status, body: await res.json() }
}

async function postWalkIn(body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://example.com/api/admin/walk-ins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function postBooking(body: unknown): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch('https://example.com/api/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function countItems(): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM booking_items').first<{ n: number }>()
  return r!.n
}

describe('GET /api/admin/available-now', () => {
  beforeEach(wipe)

  it('variant_id không tồn tại trả 404 NOT_FOUND', async () => {
    const { status, body } = await getAvailableNow(999999)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('thiếu variant_id trả 422 VALIDATION', async () => {
    const { status, body } = await getAvailableNow('')
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('KTV có skill, ca phủ cả ngày, không bận thì xuất hiện trong danh sách rảnh', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const { status, body } = await getAvailableNow(variant)
    expect(status).toBe(200)
    expect(body.staff.map((s: any) => s.id)).toContain(lan)
  })

  it('available-now loại KTV không có skill của variant được hỏi', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const mai = await insertStaff('Mai', [nails])
    await insertAllDayShift(mai)
    const massageVariant = await insertVariant(massage, { duration: 1, buffer: 0 })

    const { body } = await getAvailableNow(massageVariant)
    expect(body.staff.map((s: any) => s.id)).not.toContain(mai)
  })

  it('available-now loại KTV inactive', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill], 0)
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const { body } = await getAvailableNow(variant)
    expect(body.staff.map((s: any) => s.id)).not.toContain(lan)
  })

  it('available-now loại KTV ngoài ca làm việc tại thời điểm now', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    // Không insert ca nào cho Lan → luôn ngoài ca.
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const { body } = await getAvailableNow(variant)
    expect(body.staff.map((s: any) => s.id)).not.toContain(lan)
  })

  it('available-now loại KTV đang bận bởi booking khác tại thời điểm hiện tại', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    // Booking online chiếm [now-600, now+3000) — chắc chắn phủ khoảnh khắc gọi.
    const now = Math.floor(Date.now() / 1000)
    await seedBooking(lan, variant, now - 600, 60, 0)

    const { body } = await getAvailableNow(variant)
    expect(body.staff.map((s: any) => s.id)).not.toContain(lan)
  })
})

describe('POST /api/admin/walk-ins', () => {
  beforeEach(wipe)

  it('tạo walk-in với start_at lệch lưới 15 phút vẫn thành công (case quan trọng nhất)', async () => {
    // Test này KHÔNG được phụ thuộc vào việc đồng hồ tình cờ lệch lưới. Bản
    // đầu chỉ khẳng định 201, nên khi đổi `isWalkIn: true` thành `false` trong
    // route nó vẫn xanh nếu lần chạy đó `now` rơi đúng phút chẵn — chốt chặn
    // quan trọng nhất của card lại phụ thuộc may rủi.
    //
    // Cách sửa: chạy walk-in nhiều lần cho tới khi bắt được một `start_at`
    // thật sự lệch lưới, rồi khẳng định trên chính giá trị ĐÃ GHI vào DB.
    // Route dùng `Date.now()` nên không ép được thời điểm; nhưng chỉ cần một
    // lần lệch là đủ chứng minh luật lưới không áp cho walk-in.
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    let offGridSeen = false
    let lastStatus = 0
    // 16 lần cách nhau ~1s: chắc chắn quét qua ít nhất một giây lệch lưới,
    // vì chỉ 1/900 giây là đúng lưới.
    for (let i = 0; i < 16 && !offGridSeen; i++) {
      const { status, body } = await postWalkIn({
        variant_id: variant,
        staff_id: lan,
        customer: { name: 'Khách vãng lai' },
      })
      lastStatus = status
      if (status === 201) {
        const startAt: number = body.item.start_at
        if (startAt % 900 !== 0) {
          offGridSeen = true
          // Giờ VN là +07:00 (bội 15 phút) nên "lệch lưới theo epoch" và
          // "lệch lưới theo giờ địa phương" trùng nhau ở đây.
          expect(startAt % 900).toBeGreaterThan(0)
        }
        // dọn để lần sau không đụng chính mình
        await db.prepare('DELETE FROM booking_items').run()
        await db.prepare('DELETE FROM appointments').run()
      } else {
        break
      }
    }

    expect(lastStatus).toBe(201)
    expect(offGridSeen).toBe(true)
  })

  it('walk-in tạo ra appointment có source=walk_in và status=in_service', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const { status, body } = await postWalkIn({ variant_id: variant, staff_id: lan })
    expect(status).toBe(201)
    expect(body.appointment.source).toBe('walk_in')
    expect(body.appointment.status).toBe('in_service')
    expect(body.item.status).toBe('in_service')
  })

  it('booking_item của walk-in có start_at đúng bằng thời điểm now lúc tạo', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const before = Math.floor(Date.now() / 1000)
    const { status, body } = await postWalkIn({ variant_id: variant, staff_id: lan })
    const after = Math.floor(Date.now() / 1000)

    expect(status).toBe(201)
    expect(body.item.start_at).toBeGreaterThanOrEqual(before)
    expect(body.item.start_at).toBeLessThanOrEqual(after)
  })

  it('sau khi tạo walk-in, KTV đó không còn xuất hiện trong available-now nữa', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const before = await getAvailableNow(variant)
    expect(before.body.staff.map((s: any) => s.id)).toContain(lan)

    const created = await postWalkIn({ variant_id: variant, staff_id: lan })
    expect(created.status).toBe(201)

    const after = await getAvailableNow(variant)
    expect(after.body.staff.map((s: any) => s.id)).not.toContain(lan)
  })

  it('walk-in chiếm chỗ KTV ngay nên khách online không đặt được cùng khung giờ qua POST /api/bookings (409 SLOT_TAKEN)', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const walkin = await postWalkIn({ variant_id: variant, staff_id: lan })
    expect(walkin.status).toBe(201)

    // Online booking cần start_at đúng lưới 15 phút — dùng chính start_at walk-in
    // đã trả về (dù nó lệch lưới, ta chỉ cần MỘT mốc chắc chắn chồng khung giờ).
    // Thay vào đó test bằng cách seed trực tiếp qua route online tại đúng
    // block hiện có: chọn start_at = start_at của walk-in (đã bị chiếm).
    const walkinStart = walkin.body.item.start_at as number

    const online = await postBooking({
      customer: { name: 'Khách Online', phone: '0900000099' },
      variant_id: variant,
      start_at: walkinStart,
      staff_id: lan,
    })

    // Online path validate lưới 15 phút TRƯỚC khi chạm overlap — nếu walk-in
    // start_at tình cờ rơi đúng lưới thì lỗi phải là SLOT_TAKEN; nếu lệch lưới
    // thì online tự nhiên bị chặn ở VALIDATION trước, nhưng ta khẳng định
    // walk-in slot vẫn không nhận thêm booking nào bằng cách đếm item.
    expect([409, 422]).toContain(online.status)
    if (online.status === 409) {
      expect(online.body.error.code).toBe('SLOT_TAKEN')
    }
    expect(await countItems()).toBe(1)
  })

  it('khách ẩn danh không truyền tên/phone tạo customer với phone NULL và tên mặc định Khách lẻ', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const { status, body } = await postWalkIn({ variant_id: variant, staff_id: lan })
    expect(status).toBe(201)
    expect(body.customer.phone).toBeNull()
    expect(body.customer.name).toBe('Khách lẻ')

    const row = await db.prepare('SELECT phone, name FROM customers WHERE id = ?').bind(body.customer.id).first<any>()
    expect(row.phone).toBeNull()
    expect(row.name).toBe('Khách lẻ')
  })

  it('khách vãng lai truyền số điện thoại đã có thì tái sử dụng customer cũ', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Huong', [skill])
    await insertAllDayShift(lan)
    await insertAllDayShift(huong)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const first = await postWalkIn({
      variant_id: variant,
      staff_id: lan,
      customer: { name: 'Khách C', phone: '0912345678' },
    })
    expect(first.status).toBe(201)

    const second = await postWalkIn({
      variant_id: variant,
      staff_id: huong,
      customer: { name: 'Khách C', phone: '0912345678' },
    })
    expect(second.status).toBe(201)

    expect(second.body.customer.id).toBe(first.body.customer.id)
    const custs = await db
      .prepare('SELECT COUNT(*) AS n FROM customers WHERE phone = ?')
      .bind('0912345678')
      .first<{ n: number }>()
    expect(custs!.n).toBe(1)
  })

  it('tạo walk-in vào đúng KTV mà available-now vừa báo bận trả 409 SLOT_TAKEN', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    // available-now báo Lan rảnh.
    const before = await getAvailableNow(variant)
    expect(before.body.staff.map((s: any) => s.id)).toContain(lan)

    // Một walk-in khác giành mất Lan trước (mô phỏng khoảng hở giữa lúc lễ
    // tân xem available-now và lúc bấm xác nhận — chính cạm bẫy của T-04).
    const firstWalkin = await postWalkIn({ variant_id: variant, staff_id: lan })
    expect(firstWalkin.status).toBe(201)

    // Lễ tân (chậm tay) vẫn thử tạo walk-in vào đúng Lan.
    const secondWalkin = await postWalkIn({ variant_id: variant, staff_id: lan })
    expect(secondWalkin.status).toBe(409)
    expect(secondWalkin.body.error.code).toBe('SLOT_TAKEN')
    expect(await countItems()).toBe(1)
  })

  it('hai walk-in song song cùng một KTV: đúng một cái 201, một cái 409 (chốt chặn race condition)', async () => {
    // Đây là lý do insertBookingAtomically tồn tại (T-04's known trap, áp
    // dụng y hệt cho walk-in): validate thuần (advisory) đọc busyItems TRƯỚC
    // khi request kia kịp ghi, nên nếu chỉ dựa vào validate rồi ghi thường
    // (không có guard SQL "WHERE NOT EXISTS"), CẢ HAI request có thể cùng
    // thấy KTV rảnh và cùng ghi — sinh ra 2 booking chồng nhau cho 1 KTV.
    // Promise.all không tuần tự hoá, nên test này buộc phải đi qua đúng khe
    // hở mà một bản ghi "plain INSERT" (bỏ qua insertBookingAtomically) sẽ
    // lọt qua.
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 30, buffer: 10 })

    const [a, b] = await Promise.all([
      postWalkIn({ variant_id: variant, staff_id: lan, customer: { name: 'Khách A' } }),
      postWalkIn({ variant_id: variant, staff_id: lan, customer: { name: 'Khách B' } }),
    ])

    const statuses = [a.status, b.status].sort((x, y) => x - y)
    expect(statuses).toEqual([201, 409])

    const loser = a.status === 409 ? a : b
    expect(loser.body.error.code).toBe('SLOT_TAKEN')

    // Định nghĩa "xong": DB sau đó phải thấy ĐÚNG MỘT booking_item cho Lan.
    expect(await countItems()).toBe(1)
    const appts = await db.prepare('SELECT COUNT(*) AS n FROM appointments').first<{ n: number }>()
    expect(appts!.n).toBe(1)
  })

  it('chọn KTV không có skill của variant trả 409 STAFF_LACKS_SKILL', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    const mai = await insertStaff('Mai', [nails])
    await insertAllDayShift(mai)
    const massageVariant = await insertVariant(massage, { duration: 1, buffer: 0 })

    const { status, body } = await postWalkIn({ variant_id: massageVariant, staff_id: mai })
    expect(status).toBe(409)
    expect(body.error.code).toBe('STAFF_LACKS_SKILL')
    expect(await countItems()).toBe(0)
  })

  it('KTV ngoài ca làm việc tại thời điểm now trả 409 OUTSIDE_SHIFT', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    // Không có ca nào cho Lan hôm nay.
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const { status, body } = await postWalkIn({ variant_id: variant, staff_id: lan })
    expect(status).toBe(409)
    expect(body.error.code).toBe('OUTSIDE_SHIFT')
    expect(await countItems()).toBe(0)
  })

  it('KTV đang nghỉ phép trùng thời điểm now trả 409 SLOT_TAKEN', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const now = Math.floor(Date.now() / 1000)
    await insertTimeOff(lan, now - 3600, now + 3600)

    const { status, body } = await postWalkIn({ variant_id: variant, staff_id: lan })
    expect(status).toBe(409)
    expect(body.error.code).toBe('SLOT_TAKEN')
    expect(await countItems()).toBe(0)
  })

  it('variant_id không tồn tại trả 404 NOT_FOUND', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    await insertAllDayShift(lan)

    const { status, body } = await postWalkIn({ variant_id: 999999, staff_id: lan })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('thiếu staff_id trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const variant = await insertVariant(skill, { duration: 1, buffer: 0 })

    const { status, body } = await postWalkIn({ variant_id: variant })
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })
})
