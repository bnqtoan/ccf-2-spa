// Reassign candidate evaluation — PURE, no D1 (CONVENTIONS §7).
//
// ============================================================================
// THIS FILE DELIBERATELY CONTAINS NO SCHEDULING RULES.
// ============================================================================
// It calls `validateBooking` from ./validate-booking.ts — the same function
// POST /api/bookings calls — once per candidate technician, and translates the
// answer into something a receptionist can read.
//
// Re-implementing "is she free / does she have the skill / is she on shift"
// here would make reassign a second, quieter path into the booking rules, and
// the two copies would drift. The card names that as the single most dangerous
// mistake available in this task: reassign would become a detour that creates
// exactly the double-booking it exists to repair. So the only thing this module
// owns is the MAPPING from a validation error code to a human reason, plus the
// one distinction validateBooking cannot make on its own — leave versus a
// clashing appointment, which arrive as the same `SLOT_TAKEN`.

import type { ServiceVariant } from '../db/types.ts'
import type { BusyItem, TimeOffInterval } from './availability.ts'
import { type Interval, overlaps } from './intervals.ts'
import { blockEndAt, validateBooking } from './validate-booking.ts'

/** Why a technician cannot take this item. `null` when she can. */
export type IneligibleReason = 'STAFF_LACKS_SKILL' | 'OUTSIDE_SHIFT' | 'ON_TIME_OFF' | 'SLOT_TAKEN' | 'VALIDATION'

export interface CandidateStaff {
  id: number
  name: string
  active: number
}

export interface CandidateInput {
  /** Drives block length — the moved item keeps its original variant. */
  variant: Pick<ServiceVariant, 'duration_min' | 'buffer_after_min'>
  /** The item's existing start; reassign never moves an item in TIME. */
  start_at: number
  /** Technicians to evaluate (the current owner is excluded by the caller). */
  staff: CandidateStaff[]
  /** Ids among `staff` holding the skill this service requires. */
  skilled: Set<number>
  /** Concrete `[start,end)` shift windows on the day, keyed by staff_id. */
  shiftWindowsByStaff: Map<number, Interval[]>
  /** Leave rows intersecting the block, any of `staff`. */
  timeOff: TimeOffInterval[]
  /** Live items intersecting the block, any of `staff`, EXCLUDING this item. */
  busyItems: BusyItem[]
}

export interface Candidate {
  staff: CandidateStaff
  eligible: boolean
  /** `null` when eligible. */
  reason: IneligibleReason | null
  /** Vietnamese explanation for the desk. `null` when eligible. */
  message: string | null
}

const MESSAGES: Record<IneligibleReason, string> = {
  STAFF_LACKS_SKILL: 'Không có kỹ năng của dịch vụ này',
  OUTSIDE_SHIFT: 'Không có ca làm việc phủ trọn khung giờ này',
  ON_TIME_OFF: 'Đang nghỉ phép trong khung giờ này',
  SLOT_TAKEN: 'Đã có lịch khác trong khung giờ này',
  VALIDATION: 'Khung giờ không hợp lệ với kỹ thuật viên này',
}

/**
 * Evaluates every candidate for one item, in the order given.
 *
 * `now` is pinned to `start_at` rather than to the wall clock: the item ALREADY
 * EXISTS at that time. Judging it against the real "now" would make every
 * booking that has already begun un-reassignable ("cannot book in the past"),
 * which is precisely the situation a sick technician creates — the desk is
 * scrambling to move appointments that start in minutes. The past-check belongs
 * to creating new bookings, not to rescuing existing ones; every other rule
 * (skill, shift, leave, overlap) still applies in full.
 */
export function findCandidates(input: CandidateInput): Candidate[] {
  const { variant, start_at, staff, skilled, shiftWindowsByStaff, timeOff, busyItems } = input

  const block: Interval = { start: start_at, end: blockEndAt(start_at, variant) }

  return staff.map((person) => {
    if (!person.active) {
      return { staff: person, eligible: false, reason: 'VALIDATION', message: 'Kỹ thuật viên đã nghỉ việc' }
    }

    const problem = validateBooking({
      variant,
      start_at,
      staff_id: person.id,
      staffHasSkill: skilled.has(person.id),
      shifts: [],
      shiftWindows: shiftWindowsByStaff.get(person.id) ?? [],
      timeOff,
      busyItems,
      now: start_at,
      // The grid rule is irrelevant here: the item's start was already accepted
      // when it was created, and a walk-in's off-grid start must stay movable.
      isWalkIn: true,
    })

    if (problem === null) {
      return { staff: person, eligible: true, reason: null, message: null }
    }

    // `validateBooking` reports leave and a clashing appointment with the same
    // SLOT_TAKEN code. The desk needs them apart — "she's off today" and "she's
    // with another customer" lead to different phone calls — so we ask the
    // leave rows directly, using the same half-open overlap test.
    let reason: IneligibleReason = problem.code
    if (problem.code === 'SLOT_TAKEN') {
      const onLeave = timeOff.some(
        (off) => off.staff_id === person.id && overlaps(block, { start: off.start_at, end: off.end_at }),
      )
      if (onLeave) reason = 'ON_TIME_OFF'
    }

    return { staff: person, eligible: false, reason, message: MESSAGES[reason] }
  })
}
