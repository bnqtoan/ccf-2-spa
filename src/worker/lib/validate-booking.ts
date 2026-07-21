// Booking validation — PRD §11, verbatim. PURE: receives already-loaded rows
// and never touches D1 (CONVENTIONS §7).
//
// This is the SINGLE place the booking rules live. T-04 (online booking) and
// T-08 (walk-in) both call it; that is the entire reason for the `isWalkIn`
// flag below rather than a second copy of the rules.
//
// CONVENTIONS §2 governs occupancy: a technician is busy for
// `[start_at, block_end_at)`. `end_at` is a display value and is never read
// here — `BusyItem` (from ./availability.ts) does not even carry it.

import type { ServiceVariant, WorkShift } from '../db/types.ts'
import type { BusyItem, TimeOffInterval } from './availability.ts'
import { type Interval, contains, overlaps } from './intervals.ts'
import { isOnGrid } from './time.ts'

/** Error codes this function may return — a subset of PRD §9. */
export type BookingErrorCode = 'VALIDATION' | 'STAFF_LACKS_SKILL' | 'OUTSIDE_SHIFT' | 'SLOT_TAKEN'

export interface BookingValidationError {
  code: BookingErrorCode
  message: string
}

export interface ValidateBookingInput {
  /** Only `duration_min` + `buffer_after_min` are read — they set block length. */
  variant: Pick<ServiceVariant, 'duration_min' | 'buffer_after_min'>
  /** Proposed start, epoch seconds. */
  start_at: number
  /** The technician being assigned. */
  staff_id: number
  /** True when `staff_id` holds the skill `services.skill_id` requires. */
  staffHasSkill: boolean
  /** Shifts of THIS technician on the weekday of `start_at`. */
  shifts: Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>[]
  /**
   * Concrete `[start, end)` epoch windows those shifts occupy on the day in
   * question. The caller anchors `start_min`/`end_min` onto the day via
   * `minutesToEpoch` so no timezone maths happens in here (CONVENTIONS §1).
   */
  shiftWindows: Interval[]
  /** Time-off rows for THIS technician overlapping the day. */
  timeOff: TimeOffInterval[]
  /** Items with status IN ('booked','in_service') for THIS technician. */
  busyItems: BusyItem[]
  /** "Now" in epoch seconds. */
  now: number
  /**
   * Walk-in exemption (PRD §11 / §7). When true, exactly TWO rules are
   * skipped: the 15-minute grid and "not in the past" — a walk-in starts at
   * `now`, whenever the customer actually walked in. EVERY other rule (skill,
   * shift containment, time-off, overlap) still applies, because a walk-in can
   * double-book a technician just as easily as an online booking can.
   */
  isWalkIn?: boolean
}

/** `block_end_at = start_at + duration_min + buffer_after_min` (CONVENTIONS §2). */
export function blockEndAt(
  start_at: number,
  variant: Pick<ServiceVariant, 'duration_min' | 'buffer_after_min'>,
): number {
  return start_at + (variant.duration_min + variant.buffer_after_min) * 60
}

/** `end_at = start_at + duration_min`. Display only — never an occupancy bound. */
export function endAt(start_at: number, variant: Pick<ServiceVariant, 'duration_min'>): number {
  return start_at + variant.duration_min * 60
}

/**
 * Applies PRD §11 to one proposed booking item.
 *
 * Returns `null` when the booking is acceptable, otherwise the FIRST rule it
 * violates. Order is deliberate: cheap structural checks (grid, past) precede
 * capability (skill), which precedes scheduling (shift, overlap), so the
 * message a client sees names the most fundamental problem rather than an
 * incidental downstream one.
 */
export function validateBooking(input: ValidateBookingInput): BookingValidationError | null {
  const {
    variant,
    start_at,
    staffHasSkill,
    shiftWindows,
    timeOff,
    busyItems,
    staff_id,
    now,
    isWalkIn = false,
  } = input

  if (!Number.isInteger(start_at)) {
    return { code: 'VALIDATION', message: 'start_at phải là epoch giây (số nguyên)' }
  }
  if (variant.duration_min <= 0) {
    return { code: 'VALIDATION', message: 'Dịch vụ phải có thời lượng dương' }
  }

  // --- the two walk-in exemptions -----------------------------------------
  if (!isWalkIn) {
    if (!isOnGrid(start_at)) {
      return { code: 'VALIDATION', message: 'start_at phải rơi đúng lưới 15 phút' }
    }
    if (start_at < now) {
      return { code: 'VALIDATION', message: 'Không thể đặt lịch trong quá khứ' }
    }
  }

  // --- rules that apply to walk-ins too ------------------------------------
  if (!staffHasSkill) {
    return { code: 'STAFF_LACKS_SKILL', message: 'Kỹ thuật viên không có kỹ năng của dịch vụ này' }
  }

  const block: Interval = { start: start_at, end: blockEndAt(start_at, variant) }

  // The WHOLE block — service plus buffer — must fit inside ONE shift. A block
  // spanning two adjacent shifts is rejected on purpose: the gap between them
  // exists for a reason even when the epochs happen to touch.
  const fitsAShift = shiftWindows.some((w) => contains(w, block))
  if (!fitsAShift) {
    return { code: 'OUTSIDE_SHIFT', message: 'Khoảng đặt không nằm gọn trong một ca làm việc' }
  }

  for (const off of timeOff) {
    if (off.staff_id !== staff_id) continue
    if (overlaps(block, { start: off.start_at, end: off.end_at })) {
      return { code: 'SLOT_TAKEN', message: 'Kỹ thuật viên đang nghỉ phép trong khoảng này' }
    }
  }

  for (const item of busyItems) {
    if (item.staff_id !== staff_id) continue
    // block_end_at, never end_at — the buffer occupies the technician too.
    if (overlaps(block, { start: item.start_at, end: item.block_end_at })) {
      return { code: 'SLOT_TAKEN', message: 'Kỹ thuật viên đã có lịch trong khoảng này' }
    }
  }

  return null
}
