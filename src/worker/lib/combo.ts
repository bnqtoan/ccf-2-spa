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
