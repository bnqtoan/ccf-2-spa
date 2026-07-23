import { env, exports } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import migrationSql from '../../migrations/0001_init.sql?raw'
import { localDayBounds, localToEpoch, weekdayOf } from '../../src/worker/lib/time.ts'

const db = env.DB

// vitest-pool-workers does not auto-apply migrations_dir from wrangler.jsonc,
// so the migration is applied here once per file (same approach as
// tests/api/schema.test.ts). Comments are stripped LINE BY LINE before
// splitting on ';' — splitting first would let the file's leading comment
// block swallow the `CREATE TABLE skills` statement.
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

// --- fixture helpers -------------------------------------------------------
//
// Every test wipes and builds its own world, so no test depends on run order
// (CONVENTIONS §8). D1 storage is shared across `it()` blocks in this file.

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

/** Shift in LOCAL minutes-from-midnight, e.g. 9:00-19:00 → (540, 1140). */
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
 * Inserts a booking whose occupation is `[startAt, startAt + duration + buffer)`.
 * `end_at` is set to the service end (WITHOUT buffer) on purpose: it is
 * deliberately different from `block_end_at` so any code that reads the wrong
 * column produces a visibly wrong answer.
 */
async function insertBooking(
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

interface SlotsBody {
  slots: { start_at: number; staff_ids: number[] }[]
}

async function getAvailability(query: string): Promise<{ status: number; body: any }> {
  const res = await exports.default.fetch(`https://example.com/api/availability?${query}`)
  return { status: res.status, body: await res.json() }
}

// Ngày TƯƠNG LAI để bộ lọc "slot trong quá khứ" không bao giờ can thiệp.
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
// Weekday PHẢI suy ra từ chính FUTURE_DATE, không được để cứng. Bản trước ghi
// `= 1` vì ngày cứng '2026-08-03' tình cờ là thứ Hai; khi đổi sang ngày động
// thì ca làm việc tạo cho weekday 1 không còn khớp ngày được hỏi, và mọi test
// availability trả mảng rỗng — trông y hệt lỗi engine chứ không như lỗi fixture.
const FUTURE_WEEKDAY = weekdayOf(FUTURE_DATE)
const { start: FUTURE_DAY_START } = localDayBounds(FUTURE_DATE)

/**
 * Giờ đồng hồ địa phương trên FUTURE_DATE → epoch giây.
 *
 * Neo vào FUTURE_DAY_START, KHÔNG được viết `localToEpoch(2026, 8, 3, …)`:
 * bản trước để cứng đúng ngày đó, nên khi FUTURE_DATE thành ngày động thì mọi
 * mốc giờ lệch đi vài ngày và test đỏ với thông báo kiểu "expected [...] to
 * include 1785726000" — trông như availability engine sai, thực ra là fixture
 * trỏ sang ngày khác.
 */
function at(hour: number, minute = 0): number {
  return FUTURE_DAY_START + hour * 3600 + minute * 60
}

function startsOf(body: SlotsBody): number[] {
  return body.slots.map((s) => s.start_at)
}

describe('GET /api/availability — lọc ứng viên', () => {
  beforeEach(wipe)

  it('KTV không có ca ngày đó thì không xuất hiện slot nào', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })
    // Ca chỉ có vào Chủ nhật (weekday 0), còn ngày hỏi là thứ Hai.
    await insertShift(staff, 0, 540, 1140)

    const { status, body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    expect(status).toBe(200)
    expect(body.slots).toEqual([])
  })

  it('KTV có ca nhưng không có skill của service thì bị loại', async () => {
    const massage = await insertSkill('Massage')
    const nails = await insertSkill('Móng')
    // Mai chỉ biết làm móng, nhưng vẫn có ca cả ngày.
    const mai = await insertStaff('Mai', [nails])
    await insertShift(mai, FUTURE_WEEKDAY, 540, 1140)
    const massageVariant = await insertVariant(massage, { duration: 60, buffer: 10 })

    const { body } = await getAvailability(`variant_id=${massageVariant}&date=${FUTURE_DATE}`)
    expect(body.slots).toEqual([])
  })

  it('KTV inactive bị loại', async () => {
    const skill = await insertSkill('Massage')
    const off = await insertStaff('Nghi viec', [skill], 0)
    await insertShift(off, FUTURE_WEEKDAY, 540, 1140)
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    expect(body.slots).toEqual([])
  })
})

describe('GET /api/availability — biên ca làm việc', () => {
  beforeEach(wipe)

  it('slot cuối ngày bị loại nếu buffer tràn qua giờ đóng cửa', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    // Ca 09:00–11:00. Block = 60 + 15 = 75 phút.
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 11 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const starts = startsOf(body)

    // 09:45 + 75' = 11:00 đúng biên đóng cửa → hợp lệ (nửa mở).
    expect(starts).toContain(at(9, 45))
    // 10:00 + 75' = 11:15 vượt giờ đóng cửa → phải bị loại, kể cả khi phần
    // tràn ra chỉ là buffer dọn dẹp.
    expect(starts).not.toContain(at(10, 0))
    expect(starts[starts.length - 1]).toBe(at(9, 45))
  })

  it('mọi start_at trả về đều rơi đúng lưới 15 phút', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 45, buffer: 10 })

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    expect(body.slots.length).toBeGreaterThan(0)
    for (const slot of body.slots as SlotsBody['slots']) {
      // Lưới tính theo giờ ĐỊA PHƯƠNG: số phút kể từ nửa đêm local phải chia
      // hết cho 15.
      const minutesFromLocalMidnight = (slot.start_at - FUTURE_DAY_START) / 60
      expect(Number.isInteger(minutesFromLocalMidnight)).toBe(true)
      expect(minutesFromLocalMidnight % 15).toBe(0)
    }
  })

  it('ca bắt đầu lệch lưới thì slot đầu tiên được đẩy lên mốc 15 phút kế tiếp', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    // Ca bắt đầu 09:05 — không rơi vào lưới.
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60 + 5, 12 * 60)
    const variant = await insertVariant(skill, { duration: 30, buffer: 0 })

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    expect(startsOf(body)[0]).toBe(at(9, 15))
  })
})

describe('GET /api/availability — booking đã có chiếm chỗ', () => {
  beforeEach(wipe)

  it('booking đã có che đúng khoảng bận, kể cả phần buffer', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // Booking 10:00–11:00, block tới 11:15.
    await insertBooking(staff, variant, at(10, 0), 60, 15)

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const starts = startsOf(body)

    // Ca mở lúc 09:00, block dài 75'. Mốc sớm nhất là 09:00 nhưng nó kết thúc
    // lúc 10:15, CHỒNG booking [10:00, 11:15) → bị loại. Muốn kết thúc kịp
    // trước 10:00 thì phải bắt đầu <= 08:45, mà lúc đó chưa mở cửa. Vậy trước
    // booking không còn mốc nào cả — mọi slot đều phải nằm sau block_end_at.
    expect(starts).not.toContain(at(9, 0))
    expect(starts).not.toContain(at(9, 45))
    for (const s of starts) {
      expect(s).toBeGreaterThanOrEqual(at(11, 15))
    }
    // Phần buffer [11:00, 11:15) thật sự bị chiếm: 10:15 (kết thúc 11:30)
    // và mọi slot chồng lên buffer đều vắng mặt.
    expect(starts).not.toContain(at(10, 15))
    expect(starts).not.toContain(at(11, 0))
  })

  it('slot ngay sau block_end_at của booking trước là hợp lệ (kề nhau, không chồng)', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // Booking 10:00 → end_at 11:00, block_end_at 11:15.
    await insertBooking(staff, variant, at(10, 0), 60, 15)

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const starts = startsOf(body)

    // CHỐT CHẶN chống lỗi im lặng dùng end_at thay block_end_at:
    // - 11:15 (đúng block_end_at) phải CÓ: kề nhau không phải chồng nhau.
    // - 11:00 (đúng end_at) phải KHÔNG CÓ: buffer vẫn đang chiếm chỗ. Nếu
    //   code lỡ dùng end_at thì 11:00 sẽ xuất hiện và test này đỏ.
    expect(starts).toContain(at(11, 15))
    expect(starts).not.toContain(at(11, 0))
  })

  it('hai booking sát nhau chỉ chừa đúng khe hợp lệ ở giữa', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 30, buffer: 15 })

    // Booking A: 10:00, block tới 10:45. Booking B: 12:00, block tới 12:45.
    await insertBooking(staff, variant, at(10, 0), 30, 15)
    await insertBooking(staff, variant, at(12, 0), 30, 15)

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const starts = startsOf(body)

    // Khe rảnh [10:45, 12:00) dài 75'. Block 45' nên các mốc hợp lệ là
    // 10:45, 11:00, 11:15 (kết thúc 12:00 đúng biên, hợp lệ).
    expect(starts).toContain(at(10, 45))
    expect(starts).toContain(at(11, 15))
    // 11:30 + 45' = 12:15 chồng booking B → loại.
    expect(starts).not.toContain(at(11, 30))
  })

  it('booking status cancelled không chiếm chỗ', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await insertBooking(staff, variant, at(10, 0), 60, 15, 'cancelled')

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    // Slot đã huỷ trả chỗ lại ngay lập tức (PRD §5).
    expect(startsOf(body)).toContain(at(10, 0))
  })

  it('booking status no_show không chiếm chỗ', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await insertBooking(staff, variant, at(10, 0), 60, 15, 'no_show')

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    expect(startsOf(body)).toContain(at(10, 0))
  })

  it('booking status done không chiếm chỗ', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await insertBooking(staff, variant, at(10, 0), 60, 15, 'done')

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    expect(startsOf(body)).toContain(at(10, 0))
  })

  it('booking status in_service vẫn chiếm chỗ', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })
    await insertBooking(staff, variant, at(10, 0), 60, 15, 'in_service')

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const starts = startsOf(body)
    expect(starts).not.toContain(at(10, 0))
    // Vẫn phải tôn trọng buffer như booking thường.
    expect(starts).not.toContain(at(11, 0))
    expect(starts).toContain(at(11, 15))
  })
})

describe('GET /api/availability — nghỉ phép', () => {
  beforeEach(wipe)

  it('time_off cắt đúng khoảng rảnh trong ca', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 30, buffer: 0 })

    // Nghỉ 12:00–14:00.
    await insertTimeOff(staff, at(12, 0), at(14, 0))

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const starts = startsOf(body)

    // 11:30 + 30' = 12:00 kề đúng biên nghỉ → hợp lệ.
    expect(starts).toContain(at(11, 30))
    // 11:45 + 30' = 12:15 lấn vào giờ nghỉ → loại.
    expect(starts).not.toContain(at(11, 45))
    // Trong giờ nghỉ: không có slot nào.
    expect(starts).not.toContain(at(12, 0))
    expect(starts).not.toContain(at(13, 30))
    // Ngay khi hết nghỉ thì rảnh lại.
    expect(starts).toContain(at(14, 0))
  })
})

describe('GET /api/availability — nhóm theo giờ và chọn KTV', () => {
  beforeEach(wipe)

  it('hai KTV cùng rảnh một giờ thì slot đó có 2 staff_ids', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Huong', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const slot = (body.slots as SlotsBody['slots']).find((s) => s.start_at === at(10, 0))

    expect(slot).toBeDefined()
    expect(slot!.staff_ids).toEqual([lan, huong].sort((a, b) => a - b))
  })

  it('KTV bận thì slot vẫn còn nhưng chỉ còn KTV rảnh', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Huong', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    await insertBooking(lan, variant, at(10, 0), 60, 15)

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const slot = (body.slots as SlotsBody['slots']).find((s) => s.start_at === at(10, 0))

    expect(slot).toBeDefined()
    expect(slot!.staff_ids).toEqual([huong])
  })

  it('truyền staff_id thì chỉ trả slot của đúng người đó', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Huong', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    // Huong ca ngắn hơn để tập slot khác hẳn.
    await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 11 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}&staff_id=${huong}`)
    const slots = body.slots as SlotsBody['slots']

    expect(slots.length).toBeGreaterThan(0)
    for (const s of slots) {
      expect(s.staff_ids).toEqual([huong])
    }
    // Ca Huong hết lúc 11:00, block 75' → mốc cuối là 09:45.
    expect(slots[slots.length - 1]!.start_at).toBe(at(9, 45))
  })

  it('slot trả về được sắp xếp tăng dần theo start_at', async () => {
    const skill = await insertSkill('Massage')
    const lan = await insertStaff('Lan', [skill])
    const huong = await insertStaff('Huong', [skill])
    await insertShift(lan, FUTURE_WEEKDAY, 14 * 60, 19 * 60)
    await insertShift(huong, FUTURE_WEEKDAY, 9 * 60, 12 * 60)
    const variant = await insertVariant(skill, { duration: 30, buffer: 0 })

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const starts = startsOf(body)
    const sorted = [...starts].sort((a, b) => a - b)
    expect(starts).toEqual(sorted)
  })
})

describe('GET /api/availability — thời gian và quá khứ', () => {
  beforeEach(wipe)

  it('slot trong quá khứ của ngày hôm nay bị loại', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 30, buffer: 0 })

    // Ngày "hôm nay" theo giờ địa phương — phải tự suy ra, không dùng
    // toISOString() (đó là ngày UTC, lệch múi giờ VN).
    const nowSec = Math.floor(Date.now() / 1000)
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const todayStr = fmt.format(new Date(nowSec * 1000))
    const { start: todayStart } = localDayBounds(todayStr)
    const todayWeekday = new Date(`${todayStr}T00:00:00Z`).getUTCDay()

    // Ca phủ trọn ngày để chắc chắn có slot cả trước lẫn sau "bây giờ".
    await insertShift(staff, todayWeekday, 0, 1439)

    const { body } = await getAvailability(`variant_id=${variant}&date=${todayStr}`)
    const starts = startsOf(body)

    // Không slot nào được bắt đầu trước thời điểm hiện tại.
    for (const s of starts) {
      expect(s).toBeGreaterThanOrEqual(nowSec)
    }
    // Và mốc nửa đêm chắc chắn đã qua (trừ đúng lúc 00:00, khi đó
    // todayStart === nowSec vẫn thoả assertion trên).
    if (nowSec > todayStart) {
      expect(starts).not.toContain(todayStart)
    }
  })

  it('ngày hỏi tính theo giờ Việt Nam, không theo ngày UTC', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    const variant = await insertVariant(skill, { duration: 30, buffer: 0 })

    // Ca được tạo cho ĐÚNG weekday của FUTURE_DATE tính theo giờ VN. Nếu ai đó
    // tính weekday bằng new Date(epoch).getDay() trên máy chạy UTC thì dayStart
    // (17:00 UTC hôm trước) sẽ ra weekday lùi một ngày và test này đỏ.
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 11 * 60)

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    expect(body.slots.length).toBeGreaterThan(0)
    // Slot đầu phải đúng 09:00 GIỜ VN = 02:00 UTC.
    expect(startsOf(body)[0]).toBe(at(9, 0))
    expect((at(9, 0) - FUTURE_DAY_START) / 3600).toBe(9)
  })

  it('booking sát nửa đêm hôm trước vẫn chiếm chỗ đầu ngày hôm sau', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 0, 12 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 15 })

    // Booking bắt đầu 23:30 hôm trước, block kéo sang 00:45 ngày được hỏi.
    // Neo vào FUTURE_DAY_START (23:30 hôm trước = 30 phút trước nửa đêm), không
    // để cứng ngày — xem ghi chú ở hàm `at()`.
    const prevDay2330 = FUTURE_DAY_START - 30 * 60
    await insertBooking(staff, variant, prevDay2330, 60, 15)

    const { body } = await getAvailability(`variant_id=${variant}&date=${FUTURE_DATE}`)
    const starts = startsOf(body)

    // 00:00 và 00:30 bị block hôm trước che; 00:45 mới rảnh.
    expect(starts).not.toContain(at(0, 0))
    expect(starts).not.toContain(at(0, 30))
    expect(starts).toContain(at(0, 45))
  })
})

describe('GET /api/availability — variant khác nhau', () => {
  beforeEach(wipe)

  it('variant duration khác nhau cho ra tập slot khác nhau (90 phút ít slot hơn 45 phút)', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const short = await insertVariant(skill, { duration: 45, buffer: 10, name: 'ngan' })
    const long = await insertVariant(skill, { duration: 90, buffer: 15, name: 'dai' })

    const shortRes = await getAvailability(`variant_id=${short}&date=${FUTURE_DATE}`)
    const longRes = await getAvailability(`variant_id=${long}&date=${FUTURE_DATE}`)

    const shortStarts = startsOf(shortRes.body)
    const longStarts = startsOf(longRes.body)

    // Block dài hơn ⇒ ít mốc vừa khít hơn trong cùng một ca.
    expect(longStarts.length).toBeLessThan(shortStarts.length)
    // Ca 09:00–19:00 = 600'. Block 55' → mốc cuối 18:00; block 105' → 17:15.
    expect(shortStarts[shortStarts.length - 1]).toBe(at(18, 0))
    expect(longStarts[longStarts.length - 1]).toBe(at(17, 15))
  })
})

describe('GET /api/availability — lỗi đầu vào', () => {
  beforeEach(wipe)

  it('variant_id không tồn tại trả 404 NOT_FOUND', async () => {
    const { status, body } = await getAvailability(`variant_id=999999&date=${FUTURE_DATE}`)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('thiếu date trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })

    const { status, body } = await getAvailability(`variant_id=${variant}`)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('thiếu variant_id trả 422 VALIDATION', async () => {
    const { status, body } = await getAvailability(`date=${FUTURE_DATE}`)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('date sai định dạng trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })

    const { status, body } = await getAvailability(`variant_id=${variant}&date=03-08-2026`)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('date không có thật (2026-02-31) trả 422 VALIDATION', async () => {
    const skill = await insertSkill('Massage')
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })

    const { status, body } = await getAvailability(`variant_id=${variant}&date=2026-02-31`)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('variant_id không phải số trả 422 VALIDATION', async () => {
    const { status, body } = await getAvailability(`variant_id=abc&date=${FUTURE_DATE}`)
    expect(status).toBe(422)
    expect(body.error.code).toBe('VALIDATION')
  })

  it('staff_id không tồn tại trả danh sách slot rỗng, không phải lỗi', async () => {
    const skill = await insertSkill('Massage')
    const staff = await insertStaff('Lan', [skill])
    await insertShift(staff, FUTURE_WEEKDAY, 9 * 60, 19 * 60)
    const variant = await insertVariant(skill, { duration: 60, buffer: 10 })

    const { status, body } = await getAvailability(
      `variant_id=${variant}&date=${FUTURE_DATE}&staff_id=999999`,
    )
    expect(status).toBe(200)
    expect(body.slots).toEqual([])
  })
})
