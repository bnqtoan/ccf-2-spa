// The availability engine — PRD §4, verbatim. PURE: it receives already-loaded
// rows and never touches D1 (CONVENTIONS §7). T-04 re-runs it as the
// authoritative pre-write check; T-07 re-runs it to find a replacement KTV.
//
// The one rule that governs everything here (CONVENTIONS §2): a technician is
// occupied for `[start_at, block_end_at)`. `end_at` is a display value and is
// NEVER read in this file — the input type deliberately does not even carry it,
// so the mistake is unrepresentable rather than merely discouraged.

import type { ServiceVariant, Staff, WorkShift } from '../db/types.ts'
import { type Interval, subtract, subtractAll } from './intervals.ts'
import { GRID_MIN, ceilToGrid, minutesToEpoch } from './time.ts'

/** A technician-occupying booking item, reduced to what availability needs. */
export interface BusyItem {
  staff_id: number
  start_at: number
  /** Occupation ends here — service duration + buffer. Never `end_at`. */
  block_end_at: number
}

export interface TimeOffInterval {
  staff_id: number
  start_at: number
  end_at: number
}

export interface AvailabilityInput {
  /** Drives block length. Only `duration_min` + `buffer_after_min` are read. */
  variant: Pick<ServiceVariant, 'duration_min' | 'buffer_after_min'>
  /** Candidate staff, already filtered to those holding `service.skill_id`. */
  staff: Pick<Staff, 'id' | 'active'>[]
  /** Shifts for the requested weekday only, any staff in `staff`. */
  shifts: Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>[]
  /** Time-off rows intersecting the day, any staff in `staff`. */
  timeOff: TimeOffInterval[]
  /** Items with status IN ('booked','in_service') only — CONVENTIONS §3. */
  busyItems: BusyItem[]
  /** `[dayStart, dayEnd)` epoch bounds of the LOCAL day being asked about. */
  dayStart: number
  dayEnd: number
  /** "Now" in epoch seconds. Slots starting before this are dropped. */
  now: number
}

export interface AvailabilitySlot {
  start_at: number
  staff_ids: number[]
}

/**
 * Answers: on this day, for this variant, which 15-minute-grid start times
 * work, and who can take them?
 *
 * Returned slots are sorted ascending by `start_at`; each slot's `staff_ids`
 * is sorted ascending so auto-assign tie-breaking (PRD §4: fewest booked
 * minutes, then lowest staff id) is deterministic downstream.
 */
export function computeAvailability(input: AvailabilityInput): AvailabilitySlot[] {
  const { variant, staff, shifts, timeOff, busyItems, dayStart, dayEnd, now } = input

  const blockSec = (variant.duration_min + variant.buffer_after_min) * 60
  // A zero-length block would make every grid point trivially "available",
  // which is never a real answer.
  if (blockSec <= 0) return []

  const gridSec = GRID_MIN * 60
  // Slot start times are grid-aligned in LOCAL time and never in the past.
  const earliest = now > dayStart ? ceilToGrid(now) : dayStart

  // start_at -> staff ids. Insertion is per-staff, so values are deduped by
  // construction and sorted at the end.
  const byStart = new Map<number, number[]>()

  for (const person of staff) {
    if (!person.active) continue

    // (a) working window(s) for the day, clipped to the day itself.
    const windows: Interval[] = []
    for (const shift of shifts) {
      if (shift.staff_id !== person.id) continue
      const start = Math.max(minutesToEpoch(dayStart, shift.start_min), dayStart)
      const end = Math.min(minutesToEpoch(dayStart, shift.end_min), dayEnd)
      if (end > start) windows.push({ start, end })
    }
    if (windows.length === 0) continue // no shift → no slots for this KTV

    // (b) + (c) holes: time off, then existing bookings via block_end_at.
    const holes: Interval[] = []
    for (const off of timeOff) {
      if (off.staff_id === person.id) holes.push({ start: off.start_at, end: off.end_at })
    }
    for (const item of busyItems) {
      if (item.staff_id === person.id) {
        holes.push({ start: item.start_at, end: item.block_end_at })
      }
    }

    const free = subtractAll(windows, holes)

    // (d) walk the grid inside each free interval; a start survives only when
    // the ENTIRE block fits within that single free interval. Half-open, so a
    // block ending exactly at the interval's end still fits.
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

/**
 * Auto-assign pick (PRD §4): fewest minutes already booked that day, ties
 * broken by the lower `staff_id`. Kept beside the engine because T-04 needs
 * exactly this rule and it must not drift from a second implementation.
 *
 * `busyItems` should be the same day-scoped, status-filtered list handed to
 * `computeAvailability`.
 */
export function pickStaff(staffIds: number[], busyItems: BusyItem[]): number | null {
  if (staffIds.length === 0) return null
  const load = new Map<number, number>()
  for (const id of staffIds) load.set(id, 0)
  for (const item of busyItems) {
    const cur = load.get(item.staff_id)
    if (cur !== undefined) load.set(item.staff_id, cur + (item.block_end_at - item.start_at))
  }
  return [...load.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0]![0]
}
