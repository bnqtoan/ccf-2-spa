// Serial-combo engine (R1a) — PURE, no D1 (CONVENTIONS §7).
//
// A "serial combo" is ONE customer picking MULTIPLE service variants for ONE
// visit, served by ONE technician back-to-back. The whole chain therefore
// behaves as a single indivisible block on that technician's calendar:
//
//   totalBlock = Σ (duration_min_i + buffer_after_min_i)   (CONVENTIONS §2)
//
// and the items are laid out with no gaps — item k+1 starts exactly where
// item k's block ends. That is the entire meaning of "serial": the buffer of
// each item is honoured (the tech cleans up), then the next item begins.
//
// TWO constraints make a combo bookable, and BOTH must be visible to the
// customer BEFORE they commit (PLAYBOOK-GATE Gate-1 §3):
//   1. SKILL COVERAGE — a SINGLE technician must hold EVERY skill the chosen
//      variants require. If no active technician covers the whole set, the
//      combo is impossible for everyone; the caller reports that up front.
//   2. WINDOW FIT — that technician must have ONE continuous free window
//      (inside a single shift, minus time-off and existing bookings) long
//      enough for the whole `totalBlock`.
//
// This module reuses the SAME free-interval maths as computeAvailability so a
// combo slot can never disagree with a single-service slot: build each
// technician's free intervals from shifts − timeOff − busyItems, then walk the
// 15-minute grid checking the whole chain fits in one interval.

import type { Staff, WorkShift } from '../db/types.ts'
import type { BusyItem, TimeOffInterval } from './availability.ts'
import { type Interval, subtractAll } from './intervals.ts'
import { GRID_MIN, ceilToGrid, minutesToEpoch } from './time.ts'

/** One leg of the chain — only the fields that set its block length + skill. */
export interface ComboLeg {
  variant_id: number
  duration_min: number
  buffer_after_min: number
  /** Skill the leg's service requires — used for the coverage check. */
  skill_id: number
}

/** Total occupied seconds of the whole chain: Σ(duration+buffer)·60. */
export function comboTotalBlockSec(legs: ComboLeg[]): number {
  let sec = 0
  for (const leg of legs) sec += (leg.duration_min + leg.buffer_after_min) * 60
  return sec
}

/**
 * The distinct set of skill ids the chain needs. A single technician must hold
 * ALL of them to serve the whole combo alone (serial, one tech — R1a).
 */
export function requiredSkillIds(legs: ComboLeg[]): number[] {
  return [...new Set(legs.map((l) => l.skill_id))]
}

/** A technician plus the set of skill ids they hold — for coverage filtering. */
export interface StaffWithSkills {
  id: number
  active: number | boolean
  skillIds: Set<number>
}

/** Does this technician hold EVERY required skill? */
export function coversAllSkills(staff: StaffWithSkills, required: number[]): boolean {
  for (const s of required) if (!staff.skillIds.has(s)) return false
  return true
}

export interface ComboAvailabilityInput {
  legs: ComboLeg[]
  /** Active staff with their held skill ids (unfiltered — this fn filters). */
  staff: StaffWithSkills[]
  shifts: Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>[]
  timeOff: TimeOffInterval[]
  busyItems: BusyItem[]
  dayStart: number
  dayEnd: number
  now: number
}

export interface ComboSlot {
  start_at: number
  /** Technicians who can serve the WHOLE chain starting here, ascending. */
  staff_ids: number[]
}

/**
 * Which 15-minute grid start times let a SINGLE technician serve the whole
 * chain back-to-back, and who those technicians are.
 *
 * Only technicians covering every required skill are considered — so a slot is
 * never offered to a customer that a later write would reject for
 * STAFF_LACKS_SKILL. Returned ascending by start; each `staff_ids` ascending
 * (deterministic auto-assign downstream).
 */
export function computeComboAvailability(input: ComboAvailabilityInput): ComboSlot[] {
  const { legs, staff, shifts, timeOff, busyItems, dayStart, dayEnd, now } = input

  const blockSec = comboTotalBlockSec(legs)
  if (blockSec <= 0) return []
  const required = requiredSkillIds(legs)

  const gridSec = GRID_MIN * 60
  const earliest = now > dayStart ? ceilToGrid(now) : dayStart

  const byStart = new Map<number, number[]>()

  for (const person of staff) {
    if (!person.active) continue
    if (!coversAllSkills(person, required)) continue // skill-coverage gate

    const windows: Interval[] = []
    for (const shift of shifts) {
      if (shift.staff_id !== person.id) continue
      const start = Math.max(minutesToEpoch(dayStart, shift.start_min), dayStart)
      const end = Math.min(minutesToEpoch(dayStart, shift.end_min), dayEnd)
      if (end > start) windows.push({ start, end })
    }
    if (windows.length === 0) continue

    const holes: Interval[] = []
    for (const off of timeOff) {
      if (off.staff_id === person.id) holes.push({ start: off.start_at, end: off.end_at })
    }
    for (const item of busyItems) {
      if (item.staff_id === person.id) holes.push({ start: item.start_at, end: item.block_end_at })
    }

    const free = subtractAll(windows, holes)

    for (const gap of free) {
      if (gap.end - gap.start < blockSec) continue
      let t = ceilToGrid(gap.start)
      if (t < earliest) t = ceilToGrid(earliest)
      for (; t + blockSec <= gap.end; t += gridSec) {
        const existing = byStart.get(t)
        if (existing === undefined) byStart.set(t, [person.id])
        else existing.push(person.id)
      }
    }
  }

  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start_at, staff_ids]) => ({ start_at, staff_ids: staff_ids.slice().sort((x, y) => x - y) }))
}

// ===========================================================================
// PARALLEL combo (R1b) — MULTIPLE technicians serving the legs AT THE SAME TIME
// ===========================================================================
//
// A "parallel combo" is ONE customer picking MULTIPLE service variants for ONE
// visit, served by DIFFERENT technicians ALL STARTING AT THE SAME instant, so
// the customer is done in the time of the LONGEST leg instead of the sum. This
// is a fundamentally different shape from serial (R1a) — do not confuse them:
//
//   serial   : ONE tech holds EVERY skill, legs laid out back-to-back.
//   parallel : each leg gets its OWN tech holding just THAT leg's skill; the
//              techs are DISTINCT (one body, one tech at a time — you cannot be
//              two places at once) and every leg starts at the same `start_at`.
//
// Because every leg runs over the SAME window `[start_at, start_at + leg.block)`,
// EVERY pair of legs overlaps in time. The intra-appointment zone rule
// (CONVENTIONS §6: overlapping items must differ in body_zone) therefore means
// ALL legs must have DISTINCT body_zones — you cannot do two things on the same
// body zone simultaneously. That is a property of the CHOSEN SET, independent of
// the day/time, so it is reported up front as "not coverable" (see routes).
//
// A start time is FEASIBLE only when the legs can be matched one-to-one to
// DISTINCT free qualified technicians — a bipartite matching. `assignParallel`
// below is the single place that matching lives; both the availability search
// and the write re-run it so a slot offered can never be a slot the write
// rejects.

/** A leg carrying its body_zone too — parallel needs the zone for the set-level
 *  distinctness check (serial does not, so ComboLeg stays zone-free). */
export interface ZonedComboLeg extends ComboLeg {
  body_zone: string
}

/**
 * Do the chosen legs have PAIRWISE-DISTINCT body_zones? Parallel legs all share
 * the same time window, so any two sharing a zone is an unresolvable conflict
 * for the whole set — shown before the customer commits, never after.
 */
export function parallelZonesDistinct(legs: ZonedComboLeg[]): boolean {
  const seen = new Set<string>()
  for (const leg of legs) {
    if (seen.has(leg.body_zone)) return false
    seen.add(leg.body_zone)
  }
  return true
}

/** The longest leg block (seconds) — the wall-clock length of the parallel
 *  combo, since all legs start together and end when the longest finishes. */
export function parallelSpanSec(legs: ComboLeg[]): number {
  let max = 0
  for (const leg of legs) {
    const block = (leg.duration_min + leg.buffer_after_min) * 60
    if (block > max) max = block
  }
  return max
}

/** Is a technician free for the whole window `[start, blockEnd)` (half-open,
 *  CONVENTIONS §2) given their busy items? Time-off is folded into busyItems by
 *  the caller when needed, but here we take only staff-specific busy holes. */
function staffFreeInWindow(
  staffId: number,
  start: number,
  blockEnd: number,
  busyByStaff: Map<number, Interval[]>,
): boolean {
  const holes = busyByStaff.get(staffId)
  if (holes === undefined) return true
  for (const h of holes) {
    if (start < h.end && h.start < blockEnd) return false // half-open overlap
  }
  return true
}

/**
 * Bipartite matching: assign EACH leg to a DISTINCT technician who (a) holds the
 * leg's skill and (b) is free for that leg's window `[start_at, start_at+block)`
 * AND inside a working shift (encoded by the caller as "candidate ids" per leg).
 *
 * `candidatesPerLeg[i]` is the set of staff ids eligible for leg i at this
 * start (already filtered to skill + shift-fit + free). Returns an assignment
 * `staffIdPerLeg` (same order as legs) or `null` when no perfect matching
 * exists — i.e. the parallel combo cannot be staffed at this start.
 *
 * Kabuki-simple augmenting-path (Hungarian/Kuhn) — leg count is tiny (a combo
 * is a handful of services), so this is trivially fast and, crucially,
 * DETERMINISTIC: candidate lists are ascending, so the first feasible matching
 * found is stable across the preview and the write.
 */
export function assignParallel(candidatesPerLeg: number[][]): number[] | null {
  const n = candidatesPerLeg.length
  const matchStaffToLeg = new Map<number, number>() // staff id -> leg index
  const legStaff = new Array<number>(n).fill(-1)

  function augment(leg: number, visited: Set<number>): boolean {
    for (const staffId of candidatesPerLeg[leg]!) {
      if (visited.has(staffId)) continue
      visited.add(staffId)
      const taken = matchStaffToLeg.get(staffId)
      if (taken === undefined || augment(taken, visited)) {
        matchStaffToLeg.set(staffId, leg)
        legStaff[leg] = staffId
        return true
      }
    }
    return false
  }

  for (let leg = 0; leg < n; leg++) {
    if (!augment(leg, new Set<number>())) return null
  }
  return legStaff
}

export interface ParallelAvailabilityInput {
  legs: ZonedComboLeg[]
  /** Active staff with their held skill ids (unfiltered — this fn filters). */
  staff: StaffWithSkills[]
  shifts: Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>[]
  timeOff: TimeOffInterval[]
  busyItems: BusyItem[]
  dayStart: number
  dayEnd: number
  now: number
}

export interface ParallelSlot {
  start_at: number
  /** The concrete leg→staff assignment for THIS start (same order as legs). */
  staff_ids: number[]
}

/**
 * Which 15-minute grid start times let the parallel combo be staffed by DISTINCT
 * qualified free technicians, and one concrete assignment for each.
 *
 * For every grid start we:
 *   1. build, per leg, the set of technicians who hold that leg's skill AND have
 *      the whole leg window inside one shift AND are free of prior bookings/
 *      time-off across it;
 *   2. run `assignParallel` to see if the legs can be matched to DISTINCT techs.
 *
 * A start survives only when a perfect matching exists. Returned ascending by
 * start; each assignment is the deterministic first matching. The zone-set check
 * is NOT done here (it is a set-level property handled by the route as an
 * up-front "not coverable"); this function assumes the set already passed it.
 */
export function computeParallelAvailability(input: ParallelAvailabilityInput): ParallelSlot[] {
  const { legs, staff, shifts, timeOff, busyItems, dayStart, dayEnd, now } = input
  if (legs.length === 0) return []

  const gridSec = GRID_MIN * 60
  const earliest = now > dayStart ? ceilToGrid(now) : dayStart

  // Per-staff working windows (as intervals) and busy holes (bookings+timeoff).
  const activeStaff = staff.filter((s) => s.active)
  const shiftsByStaff = new Map<number, Interval[]>()
  for (const shift of shifts) {
    const start = Math.max(minutesToEpoch(dayStart, shift.start_min), dayStart)
    const end = Math.min(minutesToEpoch(dayStart, shift.end_min), dayEnd)
    if (end > start) {
      const arr = shiftsByStaff.get(shift.staff_id)
      if (arr === undefined) shiftsByStaff.set(shift.staff_id, [{ start, end }])
      else arr.push({ start, end })
    }
  }
  const busyByStaff = new Map<number, Interval[]>()
  const pushHole = (staffId: number, h: Interval) => {
    const arr = busyByStaff.get(staffId)
    if (arr === undefined) busyByStaff.set(staffId, [h])
    else arr.push(h)
  }
  for (const off of timeOff) pushHole(off.staff_id, { start: off.start_at, end: off.end_at })
  for (const item of busyItems) pushHole(item.staff_id, { start: item.start_at, end: item.block_end_at })

  // Pre-compute, per leg, the technicians holding that leg's skill (parallel:
  // ONE skill per leg, NOT every skill — the serial/parallel distinction).
  const qualifiedPerLeg = legs.map((leg) =>
    activeStaff.filter((s) => s.skillIds.has(leg.skill_id)).map((s) => s.id),
  )
  // If any leg has NO qualified technician at all, no start can ever work.
  for (const q of qualifiedPerLeg) if (q.length === 0) return []

  const legBlockSec = legs.map((l) => (l.duration_min + l.buffer_after_min) * 60)

  // The search only needs to consider grid starts inside the UNION of shifts of
  // any staff that could serve any leg; walking the whole day grid is fine too,
  // but bounding to [earliest, dayEnd) keeps it tight.
  const slots: ParallelSlot[] = []
  const spanSec = parallelSpanSec(legs)
  let t = ceilToGrid(earliest)
  for (; t + spanSec <= dayEnd; t += gridSec) {
    const candidatesPerLeg: number[][] = []
    let anyLegEmpty = false
    for (let i = 0; i < legs.length; i++) {
      const blockEnd = t + legBlockSec[i]!
      const cands: number[] = []
      for (const staffId of qualifiedPerLeg[i]!) {
        // whole leg window must sit inside ONE shift of this staff
        const windows = shiftsByStaff.get(staffId)
        if (windows === undefined) continue
        const inShift = windows.some((w) => w.start <= t && blockEnd <= w.end)
        if (!inShift) continue
        if (!staffFreeInWindow(staffId, t, blockEnd, busyByStaff)) continue
        cands.push(staffId)
      }
      if (cands.length === 0) {
        anyLegEmpty = true
        break
      }
      candidatesPerLeg.push(cands) // already ascending (qualifiedPerLeg is)
    }
    if (anyLegEmpty) continue

    const assignment = assignParallel(candidatesPerLeg)
    if (assignment !== null) slots.push({ start_at: t, staff_ids: assignment })
  }

  return slots
}

/** One concrete item once the chain is anchored at a start time. */
export interface LaidOutItem {
  variant_id: number
  start_at: number
  end_at: number
  block_end_at: number
}

/**
 * Lays the chain out from `startAt`, back-to-back: each item begins where the
 * previous item's block (service + buffer) ended. Returns items in order plus
 * the chain's overall end/block-end. This is the SINGLE place the serial
 * layout is computed, shared by the write path and any preview.
 */
export function layoutChain(
  legs: ComboLeg[],
  startAt: number,
): { items: LaidOutItem[]; endAt: number; blockEndAt: number } {
  const items: LaidOutItem[] = []
  let cursor = startAt
  let lastEndAt = startAt
  for (const leg of legs) {
    const start = cursor
    const endAt = start + leg.duration_min * 60
    const blockEndAt = endAt + leg.buffer_after_min * 60
    items.push({ variant_id: leg.variant_id, start_at: start, end_at: endAt, block_end_at: blockEndAt })
    lastEndAt = endAt
    cursor = blockEndAt // next leg starts after this leg's buffer (serial)
  }
  return { items, endAt: lastEndAt, blockEndAt: cursor }
}

/** One parallel item: same `start_at` as the whole combo, its own block, plus
 *  the technician assigned to it (parallel legs each ride a DIFFERENT tech). */
export interface ParallelItem extends LaidOutItem {
  staff_id: number
}

/**
 * Lays the parallel combo out: EVERY leg starts at `startAt` and runs for its
 * own `duration+buffer`, on the technician `staffIds[i]` assigned to leg i (from
 * `assignParallel`). The overall `endAt` (display) is the LONGEST leg's service
 * end; `blockEndAt` is the longest block end — the customer is done then.
 *
 * This is the SINGLE place the parallel layout is computed, shared by the write
 * path and any preview, mirroring `layoutChain` for serial.
 */
export function layoutParallel(
  legs: ComboLeg[],
  startAt: number,
  staffIds: number[],
): { items: ParallelItem[]; endAt: number; blockEndAt: number } {
  const items: ParallelItem[] = []
  let maxEndAt = startAt
  let maxBlockEndAt = startAt
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    const endAt = startAt + leg.duration_min * 60
    const blockEndAt = endAt + leg.buffer_after_min * 60
    items.push({ variant_id: leg.variant_id, start_at: startAt, end_at: endAt, block_end_at: blockEndAt, staff_id: staffIds[i]! })
    if (endAt > maxEndAt) maxEndAt = endAt
    if (blockEndAt > maxBlockEndAt) maxBlockEndAt = blockEndAt
  }
  return { items, endAt: maxEndAt, blockEndAt: maxBlockEndAt }
}
