import { describe, expect, it } from 'vitest'
import { validateBooking } from '../../src/worker/lib/validate-booking.ts'

/**
 * Hợp đồng `isWalkIn` (PRD §11: "trừ `source='walk_in'`").
 *
 * Vì sao có file này: test tương ứng ở tầng API (`tests/api/walkin.test.ts`)
 * dùng `Date.now()` thật, nên nó chỉ phân biệt được đúng/sai khi đồng hồ tình
 * cờ rơi vào phút lệch lưới. Đã kiểm bằng mutation — đổi `isWalkIn: true`
 * thành `false` trong route mà 21/21 test API vẫn xanh, vì lần chạy đó `now`
 * không lệch lưới. Chốt chặn quan trọng nhất của T-08 phụ thuộc may rủi.
 *
 * Ở đây `now` và `start_at` là hằng số do test chọn, nên kết quả tất định:
 * đổi cờ là đỏ ngay, bất kể chạy lúc mấy giờ.
 */

// 2026-07-22 03:00:00 UTC = 10:00 giờ VN, thứ Tư. Đúng lưới 15 phút.
const ON_GRID = 1784862000
const OFF_GRID = ON_GRID + 7 * 60 // 10:07 — lệch lưới

const base = {
  variant: { duration_min: 30, buffer_after_min: 10 },
  staff_id: 1,
  staffHasSkill: true,
  shifts: [{ staff_id: 1, start_min: 0, end_min: 1440 }],
  // ca phủ trọn ngày chứa cả hai mốc trên
  shiftWindows: [{ start: ON_GRID - 10 * 3600, end: ON_GRID + 13 * 3600 }],
  timeOff: [],
  busyItems: [],
}

describe('validateBooking — hợp đồng isWalkIn', () => {
  it('booking thường lệch lưới 15 phút bị từ chối', () => {
    const err = validateBooking({ ...base, start_at: OFF_GRID, now: OFF_GRID - 3600 })
    expect(err?.code).toBe('VALIDATION')
  })

  it('walk-in lệch lưới 15 phút được chấp nhận — luật lưới được miễn', () => {
    const err = validateBooking({
      ...base,
      start_at: OFF_GRID,
      now: OFF_GRID,
      isWalkIn: true,
    })
    expect(err).toBeNull()
  })

  it('booking thường trong quá khứ bị từ chối', () => {
    const err = validateBooking({ ...base, start_at: ON_GRID, now: ON_GRID + 3600 })
    expect(err?.code).toBe('VALIDATION')
  })

  it('walk-in bắt đầu tại chính now được chấp nhận — luật quá khứ được miễn', () => {
    const err = validateBooking({
      ...base,
      start_at: OFF_GRID,
      now: OFF_GRID + 120, // now đã trôi qua start_at
      isWalkIn: true,
    })
    expect(err).toBeNull()
  })

  // Cờ chỉ được miễn ĐÚNG HAI luật. Bốn test dưới khoá phần còn lại.
  it('walk-in vẫn bị chặn khi KTV không có skill', () => {
    const err = validateBooking({
      ...base,
      start_at: OFF_GRID,
      now: OFF_GRID,
      staffHasSkill: false,
      isWalkIn: true,
    })
    expect(err?.code).toBe('STAFF_LACKS_SKILL')
  })

  it('walk-in vẫn bị chặn khi ngoài ca làm việc', () => {
    const err = validateBooking({
      ...base,
      start_at: OFF_GRID,
      now: OFF_GRID,
      shiftWindows: [{ start: ON_GRID + 20 * 3600, end: ON_GRID + 22 * 3600 }],
      isWalkIn: true,
    })
    expect(err?.code).toBe('OUTSIDE_SHIFT')
  })

  it('walk-in vẫn bị chặn khi KTV đang bận khách khác', () => {
    const err = validateBooking({
      ...base,
      start_at: OFF_GRID,
      now: OFF_GRID,
      busyItems: [{ staff_id: 1, start_at: OFF_GRID - 600, block_end_at: OFF_GRID + 600 }],
      isWalkIn: true,
    })
    expect(err?.code).toBe('SLOT_TAKEN')
  })

  it('walk-in vẫn bị chặn khi KTV đang nghỉ phép', () => {
    const err = validateBooking({
      ...base,
      start_at: OFF_GRID,
      now: OFF_GRID,
      timeOff: [{ staff_id: 1, start_at: OFF_GRID - 3600, end_at: OFF_GRID + 3600 }],
      isWalkIn: true,
    })
    expect(err?.code).toBe('SLOT_TAKEN')
  })
})
