// GET /api/availability?variant_id&date[&staff_id]
//
// This layer only LOADS and FORMATS. Every scheduling decision lives in the
// pure `computeAvailability` (CONVENTIONS §7), so T-04's write-path re-check
// and T-07's reassignment reuse exactly the same logic.
//
// Query budget is fixed at 5 regardless of how many candidates exist — no N+1
// (the card's known trap). Each batched query hits an index declared in
// 0001_init.sql: staff_skills(skill_id), work_shifts(staff_id, weekday),
// time_off(staff_id, start_at), booking_items(staff_id, start_at).

import { Hono } from 'hono'
import type { ServiceVariant, Staff, WorkShift } from '../db/types.ts'
import {
  type BusyItem,
  type TimeOffInterval,
  computeAvailability,
} from '../lib/availability.ts'
import { localDayBounds, parseDateStr, weekdayOf } from '../lib/time.ts'
import { serverNow } from '../lib/clock.ts'

type Bindings = { DB: D1Database }

/**
 * Lý do lưới slot RỖNG — chỉ có mặt khi `slots` rỗng. Để UI nói ĐÚNG nguyên
 * nhân thay vì "hết giờ" chung chung:
 *  - no_staff_skilled : không KTV nào (active) có kỹ năng của dịch vụ này.
 *  - no_staff_on_shift: có KTV đủ kỹ năng nhưng không ai vào ca ngày đó.
 *  - day_over         : có chỗ trong ngày nhưng giờ hiện tại đã qua mốc cuối
 *                       (chỉ xảy ra khi hỏi NGÀY HÔM NAY vào cuối ca).
 *  - fully_booked     : có KTV vào ca nhưng booking/nghỉ đã chiếm hết.
 */
export type EmptyReason = 'no_staff_skilled' | 'no_staff_on_shift' | 'day_over' | 'fully_booked'

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

/** Positional placeholders for a batched `IN (...)`. Ids are numbers we
 * produced ourselves, but they still go through `.bind()` — never inlined. */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

routes.get('/api/availability', async (c) => {
  const rawVariantId = c.req.query('variant_id')
  const rawDate = c.req.query('date')
  const rawStaffId = c.req.query('staff_id')

  if (rawVariantId === undefined || rawVariantId === '') {
    return c.json(errorBody('VALIDATION', 'variant_id là bắt buộc'), 422)
  }
  const variantId = Number(rawVariantId)
  if (!Number.isInteger(variantId) || variantId <= 0) {
    return c.json(errorBody('VALIDATION', 'variant_id phải là số nguyên dương'), 422)
  }

  if (rawDate === undefined || rawDate === '') {
    return c.json(errorBody('VALIDATION', 'date là bắt buộc'), 422)
  }
  if (parseDateStr(rawDate) === null) {
    return c.json(errorBody('VALIDATION', 'date phải có dạng YYYY-MM-DD và là ngày có thật'), 422)
  }

  let staffId: number | null = null
  if (rawStaffId !== undefined && rawStaffId !== '') {
    staffId = Number(rawStaffId)
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
    }
  }

  const db = c.env.DB

  // (1) variant + the skill its service requires.
  const variant = await db
    .prepare(
      `SELECT sv.id, sv.duration_min, sv.buffer_after_min, s.skill_id
       FROM service_variants sv
       JOIN services s ON s.id = sv.service_id
       WHERE sv.id = ?`,
    )
    .bind(variantId)
    .first<Pick<ServiceVariant, 'id' | 'duration_min' | 'buffer_after_min'> & { skill_id: number }>()

  if (variant === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy service variant ${variantId}`), 404)
  }

  const { start: dayStart, end: dayEnd } = localDayBounds(rawDate)
  const weekday = weekdayOf(rawDate)

  // (2) candidates: active staff holding the required skill, narrowed to the
  // preferred technician when asked. Filtering `active` in SQL keeps the
  // batched follow-up queries small; the pure function re-checks it anyway.
  const candidateSql =
    `SELECT st.id, st.active, st.name
     FROM staff st
     JOIN staff_skills ss ON ss.staff_id = st.id
     WHERE ss.skill_id = ? AND st.active = 1` + (staffId === null ? '' : ' AND st.id = ?')
  const candidateStmt =
    staffId === null
      ? db.prepare(candidateSql).bind(variant.skill_id)
      : db.prepare(candidateSql).bind(variant.skill_id, staffId)
  const candidates = (await candidateStmt.all<Pick<Staff, 'id' | 'active' | 'name'>>()).results

  // Bản đồ id→tên của các ứng viên → client hiện TÊN thật thay vì "KTV #id"
  // (bug: trang đặt lịch của khách chỉ có staff_ids, phải bịa "Kỹ thuật viên #2").
  const staffNames = candidates.map((s) => ({ id: s.id, name: s.name }))

  // No candidate (unknown/inactive/unskilled staff, or nobody has the skill)
  // is a legitimate empty answer, not an error. `reason` lets the UI phrase WHY
  // it's empty (không có KTV phục vụ dịch vụ) instead of a generic "hết giờ".
  if (candidates.length === 0) {
    return c.json({ slots: [], reason: 'no_staff_skilled' as EmptyReason })
  }

  const ids = candidates.map((s) => s.id)
  const ph = placeholders(ids.length)

  // (3)(4)(5) one batched query per kind of constraint.
  const [shiftRes, timeOffRes, busyRes] = await Promise.all([
    db
      .prepare(
        `SELECT staff_id, start_min, end_min FROM work_shifts
         WHERE weekday = ? AND staff_id IN (${ph})`,
      )
      .bind(weekday, ...ids)
      .all<Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>>(),
    db
      .prepare(
        `SELECT staff_id, start_at, end_at FROM time_off
         WHERE staff_id IN (${ph}) AND start_at < ? AND end_at > ?`,
      )
      .bind(...ids, dayEnd, dayStart)
      .all<TimeOffInterval>(),
    // block_end_at, never end_at (CONVENTIONS §2). The overlap predicate is
    // half-open on both sides: an item finishing exactly at dayStart, or
    // starting exactly at dayEnd, does not belong to this day.
    db
      .prepare(
        `SELECT staff_id, start_at, block_end_at FROM booking_items
         WHERE staff_id IN (${ph})
           AND status IN ('booked','in_service')
           AND start_at < ? AND block_end_at > ?`,
      )
      .bind(...ids, dayEnd, dayStart)
      .all<BusyItem>(),
  ])

  const engineInput = {
    variant: { duration_min: variant.duration_min, buffer_after_min: variant.buffer_after_min },
    staff: candidates,
    shifts: shiftRes.results,
    timeOff: timeOffRes.results,
    busyItems: busyRes.results,
    dayStart,
    dayEnd,
  }

  const slots = computeAvailability({ ...engineInput, now: serverNow(c) })

  if (slots.length > 0) return c.json({ slots, staff: staffNames })

  // Rỗng dù có KTV đủ kỹ năng → nói ĐÚNG nguyên nhân. Phân biệt bốn ca:
  //  - no_staff_on_shift: không ai vào ca ngày đó (shiftRes rỗng).
  //  - day_over: CÓ chỗ trong ngày nhưng giờ hiện tại đã qua mốc cuối cùng
  //    (tính lại với now=dayStart mà VẪN có slot ⇒ chỉ bị cắt bởi quá-khứ, KHÔNG
  //    phải do kín). Đây là ca khiến "hết giờ nhưng lịch trống" trước đây gây
  //    hiểu nhầm là fully_booked.
  //  - fully_booked: kể cả bỏ mốc quá-khứ vẫn rỗng ⇒ booking/nghỉ chiếm hết.
  let reason: EmptyReason
  if (shiftRes.results.length === 0) {
    reason = 'no_staff_on_shift'
  } else {
    const ignoringPast = computeAvailability({ ...engineInput, now: dayStart })
    reason = ignoringPast.length > 0 ? 'day_over' : 'fully_booked'
  }
  return c.json({ slots, reason })
})

export default routes
