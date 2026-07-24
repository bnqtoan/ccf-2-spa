import { describe, expect, it } from 'vitest'
import {
  comboTotalBlockSec,
  computeComboAvailability,
  coversAllSkills,
  layoutChain,
  requiredSkillIds,
  type ComboLeg,
  type StaffWithSkills,
} from '../../src/worker/lib/combo.ts'
import { localDayBounds, minutesToEpoch } from '../../src/worker/lib/time.ts'

// Pure serial-combo engine (R1a). No D1 — same style as tests/unit/intervals.test.ts.
//
// Day + wall-clock instants are derived through the SAME time helpers the
// engine uses (never hand-computed epoch arithmetic, which breaks on the
// historical VN offset around 1970). Shifts are expressed in minutes-from-
// local-midnight (540 = 09:00, 1140 = 19:00) and anchored with minutesToEpoch.
const DATE = '2026-08-03' // a Monday, well in the future
const { start: DAY_START, end: DAY_END } = localDayBounds(DATE)
const NINE = minutesToEpoch(DAY_START, 540) // 09:00 local
const TEN = minutesToEpoch(DAY_START, 600) // 10:00 local

function shift(staff_id: number, startMin = 540, endMin = 1140) {
  return { staff_id, start_min: startMin, end_min: endMin }
}
function staff(id: number, skillIds: number[]): StaffWithSkills {
  return { id, active: 1, skillIds: new Set(skillIds) }
}

describe('comboTotalBlockSec + requiredSkillIds', () => {
  it('sums duration + buffer of every leg', () => {
    const legs: ComboLeg[] = [
      { variant_id: 1, duration_min: 60, buffer_after_min: 10, skill_id: 1 },
      { variant_id: 2, duration_min: 45, buffer_after_min: 5, skill_id: 2 },
    ]
    expect(comboTotalBlockSec(legs)).toBe((60 + 10 + 45 + 5) * 60)
  })

  it('required skills are the distinct set', () => {
    const legs: ComboLeg[] = [
      { variant_id: 1, duration_min: 30, buffer_after_min: 0, skill_id: 1 },
      { variant_id: 2, duration_min: 30, buffer_after_min: 0, skill_id: 2 },
      { variant_id: 3, duration_min: 30, buffer_after_min: 0, skill_id: 1 },
    ]
    expect(requiredSkillIds(legs).sort()).toEqual([1, 2])
  })
})

describe('coversAllSkills', () => {
  it('true only when the technician holds every required skill', () => {
    expect(coversAllSkills(staff(1, [1, 2]), [1, 2])).toBe(true)
    expect(coversAllSkills(staff(1, [1]), [1, 2])).toBe(false)
    expect(coversAllSkills(staff(1, [1, 2, 3]), [2])).toBe(true)
  })
})

describe('layoutChain', () => {
  it('lays items back-to-back, each starting after the previous block (service+buffer)', () => {
    const legs: ComboLeg[] = [
      { variant_id: 10, duration_min: 60, buffer_after_min: 10, skill_id: 1 }, // 00:00–01:00, block →01:10
      { variant_id: 20, duration_min: 45, buffer_after_min: 5, skill_id: 2 }, // 01:10–01:55, block →02:00
    ]
    const { items, endAt, blockEndAt } = layoutChain(legs, 0)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ variant_id: 10, start_at: 0, end_at: 3600, block_end_at: 4200 })
    // second leg starts exactly at first leg's block_end (serial, no gap)
    expect(items[1]).toMatchObject({ variant_id: 20, start_at: 4200 })
    expect(items[1]!.end_at).toBe(4200 + 45 * 60)
    expect(items[1]!.block_end_at).toBe(4200 + 45 * 60 + 5 * 60)
    expect(endAt).toBe(4200 + 45 * 60) // last item's service end (display)
    expect(blockEndAt).toBe(4200 + 45 * 60 + 5 * 60) // whole chain block end
  })
})

describe('computeComboAvailability — skill coverage', () => {
  const legs: ComboLeg[] = [
    { variant_id: 1, duration_min: 60, buffer_after_min: 10, skill_id: 1 }, // skill 1 (massage)
    { variant_id: 2, duration_min: 45, buffer_after_min: 5, skill_id: 2 }, // skill 2 (nails)
  ]

  it('NO single technician holds both skills → zero slots (the uncoverable case)', () => {
    // Two techs, each with only ONE of the two skills — like seed's massage vs
    // nails split (nobody holds Massage+Móng together).
    const slots = computeComboAvailability({
      legs,
      staff: [staff(1, [1]), staff(2, [2])],
      shifts: [shift(1), shift(2)],
      timeOff: [],
      busyItems: [],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      now: DAY_START,
    })
    expect(slots).toEqual([])
  })

  it('one technician holds BOTH skills → slots offered, and only that tech appears', () => {
    const slots = computeComboAvailability({
      legs,
      staff: [staff(1, [1, 2]), staff(2, [1])],
      shifts: [shift(1), shift(2)],
      timeOff: [],
      busyItems: [],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      now: DAY_START,
    })
    expect(slots.length).toBeGreaterThan(0)
    for (const s of slots) expect(s.staff_ids).toEqual([1]) // tech 2 lacks skill 2
    // First slot is 09:00 local (shift start), whole chain (120 min block) fits.
    expect(slots[0]!.start_at).toBe(NINE)
  })
})

describe('computeComboAvailability — window fit', () => {
  const legs: ComboLeg[] = [
    { variant_id: 1, duration_min: 90, buffer_after_min: 15, skill_id: 1 },
    { variant_id: 2, duration_min: 75, buffer_after_min: 10, skill_id: 2 },
  ]
  // total block = (90+15+75+10) = 190 min = 11400 s

  it('a day whose only free window is shorter than the whole chain yields NO slot', () => {
    // Shift 09:00–11:00 local = 120 min, but the chain needs 190 min → nothing fits,
    // even though the technician covers both skills.
    const slots = computeComboAvailability({
      legs,
      staff: [staff(1, [1, 2])],
      shifts: [shift(1, 540, 660)], // 09:00–11:00
      timeOff: [],
      busyItems: [],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      now: DAY_START,
    })
    expect(slots).toEqual([])
  })

  it('an existing booking that fragments the day below chain length blocks those starts', () => {
    // Full 09:00–19:00 shift, but a booking occupies 10:00 onward, leaving only
    // 09:00–10:00 (60 min) free before it — too short for a 190-min chain. The
    // only viable window is after the booking's block ends.
    const slots = computeComboAvailability({
      legs,
      staff: [staff(1, [1, 2])],
      shifts: [shift(1)], // 09:00–19:00
      timeOff: [],
      busyItems: [{ staff_id: 1, start_at: TEN, block_end_at: TEN + 6 * 3600 /* occupies 10:00–16:00 */ }],
      dayStart: DAY_START,
      dayEnd: DAY_END,
      now: DAY_START,
    })
    const CHAIN = 11400 // total block seconds
    // Every offered start must fit its whole chain either fully before the
    // 10:00 booking, or fully after that booking's block ends (16:00).
    expect(slots.every((s) => s.start_at + CHAIN <= TEN || s.start_at >= TEN + 6 * 3600)).toBe(true)
    // 09:00 start (chain runs to ~10:10) would collide with the 10:00 booking → not offered.
    expect(slots.find((s) => s.start_at === NINE)).toBeUndefined()
  })
})
