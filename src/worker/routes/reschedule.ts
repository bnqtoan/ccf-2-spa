// POST /api/bookings/:id/reschedule  body { start_at, staff_id? } — khách tự
// ĐỔI GIỜ lịch của mình (T-24 / G5).
//
// Đây KHÔNG phải huỷ-rồi-đặt-lại. Đổi giờ bằng HAI request (huỷ item cũ, đặt
// item mới) mở ra đúng thảm hoạ card gọi tên: nếu request đặt fail (slot mới
// vừa bị cướp, KTV kẹt lịch...), khách MẤT LỊCH ÂM THẦM — item cũ đã huỷ, item
// mới không có. Nên toàn bộ việc đổi là MỘT câu UPDATE có guard (xem
// db/bookings.ts::rescheduleItemAtomically): hoặc dời được, hoặc item cũ Y
// NGUYÊN. Không có trạng thái nửa vời.
//
// Thứ tự, giống write-path của POST /api/bookings:
//   1. parse + shape-validate                              → 422 VALIDATION
//   2. load item hiện tại + variant/skill của nó           → 404 NOT_FOUND
//   3. transition guard (chỉ 'booked' đổi được)            → 409 INVALID_TRANSITION
//   4. cutoff 2h SERVER-side, đồng hồ server               → 409 CANCEL_TOO_LATE
//   5. validateBooking(slot mới) — ADVISORY, cho mã lỗi đẹp → 422 / 409
//   6. UPDATE có guard nguyên tử — TRỌNG TÀI chống-race     → 409 SLOT_TAKEN
//
// Bước 5 chỉ để khách nhận STAFF_LACKS_SKILL / OUTSIDE_SHIFT thay vì SLOT_TAKEN
// trơ. Bước 6 mới là sự thật: mọi thứ bước 5 thấy có thể đã cũ khi tới lúc ghi.

import { Hono } from 'hono'
import {
  loadStaffWindowContext,
  loadVariantWithSkill,
  rescheduleItemAtomically,
  staffHasSkill,
} from '../db/bookings.ts'
import { serverNow } from '../lib/clock.ts'
import type { Interval } from '../lib/intervals.ts'
import { canCustomerCancel, canTransition } from '../lib/status.ts'
import { localDayBounds, localParts, minutesToEpoch } from '../lib/time.ts'
import { blockEndAt, endAt, validateBooking } from '../lib/validate-booking.ts'
import type { BookingItem } from '../db/types.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

/** `YYYY-MM-DD` of an epoch, in SPA_TZ. */
function localDateStr(epochSec: number): string {
  const p = localParts(epochSec)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Weekday (0=Sun..6=Sat) of the LOCAL day containing `epochSec`. */
function localWeekday(epochSec: number): number {
  const p = localParts(epochSec)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

interface ReschedulePayload {
  start_at?: unknown
  staff_id?: unknown
}

routes.post('/api/bookings/:id/reschedule', async (c) => {
  const itemId = Number(c.req.param('id'))
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return c.json(errorBody('NOT_FOUND', 'booking_item id không hợp lệ'), 404)
  }

  const db = c.env.DB

  // --- 1. shape validation -------------------------------------------------
  let payload: ReschedulePayload
  try {
    payload = (await c.req.json()) as ReschedulePayload
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const startAt = Number(payload.start_at)
  if (!Number.isInteger(startAt) || startAt <= 0) {
    return c.json(errorBody('VALIDATION', 'start_at phải là epoch giây (số nguyên dương)'), 422)
  }

  // staff_id tuỳ chọn: không gửi = giữ nguyên KTV cũ (khách chỉ đổi GIỜ).
  let requestedStaffId: number | null = null
  if (payload.staff_id !== undefined && payload.staff_id !== null) {
    requestedStaffId = Number(payload.staff_id)
    if (!Number.isInteger(requestedStaffId) || requestedStaffId <= 0) {
      return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
    }
  }

  // --- 2. load the existing item + its variant/skill -----------------------
  const item = await db
    .prepare(
      `SELECT id, appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status, cancelled_at
       FROM booking_items WHERE id = ?`,
    )
    .bind(itemId)
    .first<BookingItem>()

  if (item === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy booking_item ${itemId}`), 404)
  }

  // --- 3. transition guard: only a live 'booked' item can be rescheduled ---
  // cancelled / done / in_service / no_show → INVALID_TRANSITION, đúng như huỷ.
  if (!canTransition(item.status as any, 'cancelled')) {
    return c.json(
      errorBody('INVALID_TRANSITION', `Không thể đổi giờ booking đang ở trạng thái ${item.status}`),
      409,
    )
  }

  // --- 4. cutoff 2h, SERVER clock, never trust the client ------------------
  // Đổi giờ cũng là "rời khỏi giờ cũ" nên áp đúng cutoff huỷ: dưới 2h → khách
  // gọi điện để lễ tân sắp, y hệt luồng huỷ.
  const now = serverNow(c)
  if (!canCustomerCancel(item.start_at, now)) {
    return c.json(
      errorBody('CANCEL_TOO_LATE', 'Chỉ còn dưới 2 tiếng trước giờ hẹn, vui lòng gọi điện cho spa để đổi lịch'),
      409,
    )
  }

  // Đổi DỊCH VỤ không thuộc phạm vi (card: chỉ đổi GIỜ). Item giữ nguyên
  // variant; ta chỉ cần variant để tính block mới + skill của KTV.
  const variant = await loadVariantWithSkill(db, item.variant_id)
  if (variant === null) {
    // Dữ liệu hỏng — variant của item đã biến mất. Không nên xảy ra.
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy service variant ${item.variant_id}`), 404)
  }

  // KTV đích: giữ KTV cũ nếu không chỉ định.
  const targetStaffId = requestedStaffId ?? item.staff_id

  const newEndAt = endAt(startAt, variant)
  const newBlockEndAt = blockEndAt(startAt, variant)

  // --- 5. advisory validation of the NEW slot, for a precise error code ----
  const dateStr = localDateStr(startAt)
  const { start: dayStart } = localDayBounds(dateStr)
  const weekday = localWeekday(startAt)

  const hasSkill = await staffHasSkill(db, targetStaffId, variant.skill_id)
  // Loại chính item đang dời ra khỏi busyItems: giữ KTV cũ và dời một chút
  // trong block của chính nó thì không được tự chặn mình. Guard SQL ở bước 6
  // cũng loại `bi.id != item.id` vì đúng lý do đó.
  const windowCtx = await loadStaffWindowContext(db, targetStaffId, startAt, newBlockEndAt, weekday, item.id)
  const shiftWindows: Interval[] = windowCtx.shifts.map((s) => ({
    start: minutesToEpoch(dayStart, s.start_min),
    end: minutesToEpoch(dayStart, s.end_min),
  }))

  const problem = validateBooking({
    variant: { duration_min: variant.duration_min, buffer_after_min: variant.buffer_after_min },
    start_at: startAt,
    staff_id: targetStaffId,
    staffHasSkill: hasSkill,
    shifts: windowCtx.shifts,
    shiftWindows,
    timeOff: windowCtx.timeOff,
    busyItems: windowCtx.busyItems,
    now,
    isWalkIn: false,
  })

  if (problem !== null) {
    const status = problem.code === 'VALIDATION' ? 422 : 409
    return c.json(errorBody(problem.code, problem.message), status)
  }

  // --- 6. the atomic move — the authoritative check ------------------------
  // Nếu slot mới vừa bị cướp (hoặc item không còn 'booked'): changes=0 →
  // SLOT_TAKEN, item CŨ GIỮ NGUYÊN. Đây là bất biến quan trọng nhất của card.
  const moved = await rescheduleItemAtomically(db, {
    item_id: item.id,
    staff_id: targetStaffId,
    start_at: startAt,
    end_at: newEndAt,
    block_end_at: newBlockEndAt,
  })

  if (!moved.ok) {
    return c.json(errorBody('SLOT_TAKEN', 'Khung giờ này vừa có người đặt mất'), 409)
  }

  const staffRow = await db
    .prepare('SELECT id, name FROM staff WHERE id = ?')
    .bind(targetStaffId)
    .first<{ id: number; name: string }>()

  return c.json({ item: moved.item, staff: staffRow }, 200)
})

export default routes
