// Serial-combo booking (R1a) — the CUSTOMER-facing multi-select flow.
//
//   POST /api/combo/availability  { variant_ids[], date[, staff_id] }
//   POST /api/combo/bookings      { customer, variant_ids[], start_at[, staff_id] }
//
// A combo is ONE customer, MULTIPLE service variants, ONE technician,
// back-to-back (serial). The whole chain is one indivisible block on that
// technician (see src/worker/lib/combo.ts). This route only LOADS + FORMATS;
// every scheduling decision lives in the pure combo/availability engines
// (CONVENTIONS §7), and the race-proof write is expressed as SQL guards on the
// INSERTs (the D1 lesson from src/worker/db/bookings.ts).
//
// WHY A NEW ENDPOINT (not POST /api/bookings): the single-service write path
// creates exactly ONE appointment + ONE item and picks one technician for that
// one item. A serial combo needs N items under ONE appointment, all on ONE
// technician, laid out contiguously, and the availability search must find a
// window big enough for the WHOLE chain. No schema change is needed — the
// tables already hold N items per appointment (booking_items is plural).
//
// The availability response carries `coverable`: false means NO single active
// technician holds every skill the chosen variants require — the combo is
// impossible for everyone, and the UI says so BEFORE the customer commits
// (PLAYBOOK-GATE Gate-1 §3). `coverable: true` with an empty `slots` for a day
// means "someone can do it, just not on this day" — a normal empty state.

import { Hono } from 'hono'
import {
  type ComboLeg,
  type StaffWithSkills,
  computeComboAvailability,
  coversAllSkills,
  layoutChain,
  requiredSkillIds,
} from '../lib/combo.ts'
import { localDayBounds, localParts, parseDateStr, weekdayOf } from '../lib/time.ts'
import { pickStaff } from '../lib/availability.ts'
import type { BusyItem, TimeOffInterval } from '../lib/availability.ts'
import type { Staff, WorkShift } from '../db/types.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

function localDateStr(epochSec: number): string {
  const p = localParts(epochSec)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

function localWeekday(epochSec: number): number {
  const p = localParts(epochSec)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

/** A chosen variant joined to its service's skill + zone. Preserves request order. */
interface VariantRow {
  id: number
  duration_min: number
  buffer_after_min: number
  skill_id: number
  body_zone: string
}

/**
 * Parses `variant_ids` into a positive-integer array, PRESERVING ORDER and
 * DUPLICATES (a customer may legitimately book "massage 60" twice). Returns
 * null on any malformed member so the caller can 422.
 */
function parseVariantIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: number[] = []
  for (const v of raw) {
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) return null
    out.push(n)
  }
  return out
}

/**
 * Loads the chosen variants (in request order) and every active technician
 * with the set of skills they hold. One query for variants, one for
 * staff-skills — never N+1.
 */
async function loadVariantsAndStaff(
  db: D1Database,
  variantIds: number[],
): Promise<{ legs: ComboLeg[] | null; zonesByVariant: string[]; staff: StaffWithSkills[] }> {
  const uniqueIds = [...new Set(variantIds)]
  const ph = placeholders(uniqueIds.length)
  const variantRes = await db
    .prepare(
      `SELECT sv.id, sv.duration_min, sv.buffer_after_min, s.skill_id, s.body_zone
       FROM service_variants sv
       JOIN services s ON s.id = sv.service_id
       WHERE sv.id IN (${ph})`,
    )
    .bind(...uniqueIds)
    .all<VariantRow>()

  const byId = new Map<number, VariantRow>()
  for (const r of variantRes.results) byId.set(r.id, r)

  // Any unknown variant id → the whole combo is unresolvable.
  for (const id of variantIds) if (!byId.has(id)) return { legs: null, zonesByVariant: [], staff: [] }

  // Re-expand to request order (and duplicates) — the chain is ORDERED.
  const legs: ComboLeg[] = variantIds.map((id) => {
    const r = byId.get(id)!
    return { variant_id: r.id, duration_min: r.duration_min, buffer_after_min: r.buffer_after_min, skill_id: r.skill_id }
  })
  const zonesByVariant = variantIds.map((id) => byId.get(id)!.body_zone)

  const staffRes = await db
    .prepare(
      `SELECT st.id, st.active, ss.skill_id
       FROM staff st
       JOIN staff_skills ss ON ss.staff_id = st.id
       WHERE st.active = 1`,
    )
    .all<{ id: number; active: number; skill_id: number }>()

  const staffMap = new Map<number, StaffWithSkills>()
  for (const row of staffRes.results) {
    let entry = staffMap.get(row.id)
    if (entry === undefined) {
      entry = { id: row.id, active: row.active, skillIds: new Set<number>() }
      staffMap.set(row.id, entry)
    }
    entry.skillIds.add(row.skill_id)
  }

  return { legs, zonesByVariant, staff: [...staffMap.values()] }
}

// ---------------------------------------------------------------------------
// POST /api/combo/availability
// ---------------------------------------------------------------------------
routes.post('/api/combo/availability', async (c) => {
  const db = c.env.DB

  let payload: { variant_ids?: unknown; date?: unknown; staff_id?: unknown }
  try {
    payload = (await c.req.json()) as typeof payload
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const variantIds = parseVariantIds(payload.variant_ids)
  if (variantIds === null) {
    return c.json(errorBody('VALIDATION', 'variant_ids phải là mảng số nguyên dương, không rỗng'), 422)
  }
  const date = typeof payload.date === 'string' ? payload.date : ''
  if (parseDateStr(date) === null) {
    return c.json(errorBody('VALIDATION', 'date phải có dạng YYYY-MM-DD và là ngày có thật'), 422)
  }
  let staffId: number | null = null
  if (payload.staff_id !== undefined && payload.staff_id !== null) {
    staffId = Number(payload.staff_id)
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
    }
  }

  const { legs, staff } = await loadVariantsAndStaff(db, variantIds)
  if (legs === null) {
    return c.json(errorBody('NOT_FOUND', 'Có dịch vụ trong combo không tồn tại'), 404)
  }

  // Skill-coverage: does ANY active technician hold every required skill?
  // This is the "shown BEFORE commit" gate. When staff_id is given, coverage
  // is judged for THAT technician only.
  const required = requiredSkillIds(legs)
  const pool = staffId === null ? staff : staff.filter((s) => s.id === staffId)
  const coverable = pool.some((s) => coversAllSkills(s, required))
  if (!coverable) {
    // No slots to compute — the combo is impossible for this pool. The UI turns
    // this into a plain-language message, never a raw error.
    return c.json({ coverable: false, slots: [] })
  }

  const { start: dayStart, end: dayEnd } = localDayBounds(date)
  const weekday = weekdayOf(date)

  // Only the covering technicians need their shifts/timeoff/busy loaded.
  const coveringIds = pool.filter((s) => coversAllSkills(s, required)).map((s) => s.id)
  const ph = placeholders(coveringIds.length)
  const [shiftRes, timeOffRes, busyRes] = await Promise.all([
    db
      .prepare(`SELECT staff_id, start_min, end_min FROM work_shifts WHERE weekday = ? AND staff_id IN (${ph})`)
      .bind(weekday, ...coveringIds)
      .all<Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>>(),
    db
      .prepare(`SELECT staff_id, start_at, end_at FROM time_off WHERE staff_id IN (${ph}) AND start_at < ? AND end_at > ?`)
      .bind(...coveringIds, dayEnd, dayStart)
      .all<TimeOffInterval>(),
    db
      .prepare(
        `SELECT staff_id, start_at, block_end_at FROM booking_items
         WHERE staff_id IN (${ph}) AND status IN ('booked','in_service') AND start_at < ? AND block_end_at > ?`,
      )
      .bind(...coveringIds, dayEnd, dayStart)
      .all<BusyItem>(),
  ])

  const slots = computeComboAvailability({
    legs,
    staff: pool,
    shifts: shiftRes.results,
    timeOff: timeOffRes.results,
    busyItems: busyRes.results,
    dayStart,
    dayEnd,
    now: Math.floor(Date.now() / 1000),
  })

  return c.json({ coverable: true, slots })
})

// ---------------------------------------------------------------------------
// POST /api/combo/bookings
// ---------------------------------------------------------------------------
routes.post('/api/combo/bookings', async (c) => {
  const db = c.env.DB

  let payload: {
    customer?: { name?: unknown; phone?: unknown }
    variant_ids?: unknown
    start_at?: unknown
    staff_id?: unknown
  }
  try {
    payload = (await c.req.json()) as typeof payload
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const name = typeof payload.customer?.name === 'string' ? payload.customer.name.trim() : ''
  if (name === '') return c.json(errorBody('VALIDATION', 'customer.name là bắt buộc'), 422)
  const phone = typeof payload.customer?.phone === 'string' ? payload.customer.phone.trim() : ''
  if (phone === '') return c.json(errorBody('VALIDATION', 'customer.phone là bắt buộc'), 422)

  const variantIds = parseVariantIds(payload.variant_ids)
  if (variantIds === null) {
    return c.json(errorBody('VALIDATION', 'variant_ids phải là mảng số nguyên dương, không rỗng'), 422)
  }
  const startAt = Number(payload.start_at)
  if (!Number.isInteger(startAt) || startAt <= 0) {
    return c.json(errorBody('VALIDATION', 'start_at phải là epoch giây (số nguyên dương)'), 422)
  }
  let requestedStaffId: number | null = null
  if (payload.staff_id !== undefined && payload.staff_id !== null) {
    requestedStaffId = Number(payload.staff_id)
    if (!Number.isInteger(requestedStaffId) || requestedStaffId <= 0) {
      return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
    }
  }

  const { legs, staff } = await loadVariantsAndStaff(db, variantIds)
  if (legs === null) return c.json(errorBody('NOT_FOUND', 'Có dịch vụ trong combo không tồn tại'), 404)

  const required = requiredSkillIds(legs)
  const now = Math.floor(Date.now() / 1000)
  const date = localDateStr(startAt)
  const { start: dayStart, end: dayEnd } = localDayBounds(date)
  const weekday = localWeekday(startAt)

  // Re-run the SAME combo engine as the pre-write check so the write and the
  // availability response can never disagree; pick the technician (given, or
  // auto-assigned — fewest booked minutes that day, then lowest id).
  const pool = requestedStaffId === null ? staff : staff.filter((s) => s.id === requestedStaffId)
  const covering = pool.filter((s) => coversAllSkills(s, required))
  if (covering.length === 0) {
    return c.json(
      errorBody('STAFF_LACKS_SKILL', 'Chưa có kỹ thuật viên nào làm được trọn combo này'),
      409,
    )
  }

  const coveringIds = covering.map((s) => s.id)
  const ph = placeholders(coveringIds.length)
  const [shiftRes, timeOffRes, busyRes] = await Promise.all([
    db
      .prepare(`SELECT staff_id, start_min, end_min FROM work_shifts WHERE weekday = ? AND staff_id IN (${ph})`)
      .bind(weekday, ...coveringIds)
      .all<Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>>(),
    db
      .prepare(`SELECT staff_id, start_at, end_at FROM time_off WHERE staff_id IN (${ph}) AND start_at < ? AND end_at > ?`)
      .bind(...coveringIds, dayEnd, dayStart)
      .all<TimeOffInterval>(),
    db
      .prepare(
        `SELECT staff_id, start_at, block_end_at FROM booking_items
         WHERE staff_id IN (${ph}) AND status IN ('booked','in_service') AND start_at < ? AND block_end_at > ?`,
      )
      .bind(...coveringIds, dayEnd, dayStart)
      .all<BusyItem>(),
  ])

  const slots = computeComboAvailability({
    legs,
    staff: pool,
    shifts: shiftRes.results,
    timeOff: timeOffRes.results,
    busyItems: busyRes.results,
    dayStart,
    dayEnd,
    now,
  })
  const slot = slots.find((s) => s.start_at === startAt)
  if (slot === undefined) {
    // No covering technician has one continuous window here — surfaced to the
    // customer as "chọn giờ khác", never a raw error.
    return c.json(errorBody('SLOT_TAKEN', 'Không có kỹ thuật viên nào rảnh trọn combo cho khung giờ này'), 409)
  }
  const staffId = pickStaff(slot.staff_ids, busyRes.results)
  if (staffId === null) {
    return c.json(errorBody('SLOT_TAKEN', 'Không có kỹ thuật viên nào rảnh trọn combo cho khung giờ này'), 409)
  }

  // Lay the chain out contiguously from startAt.
  const { items, endAt, blockEndAt } = layoutChain(legs, startAt)

  // --- the write: one appointment + N items, all guarded on the SAME
  // technician's free-ness for the WHOLE chain window [startAt, blockEndAt).
  // Because the chain is contiguous and served by one technician, guarding the
  // whole window against OTHER bookings is exactly right — the items never
  // conflict with each other (they are laid out back-to-back), only with
  // pre-existing rows. Every statement carries the same guard, so a lost race
  // writes NOTHING (no orphan appointment). D1 batch is atomic; a guard that
  // blocks statement 1 leaves last_insert_rowid unusable, so statement 2's
  // guard blocks too and meta.changes is 0 across the board.
  const existing = await db
    .prepare('SELECT id FROM customers WHERE phone = ? ORDER BY id LIMIT 1')
    .bind(phone)
    .first<{ id: number }>()
  const customerId =
    existing !== null
      ? existing.id
      : (await db
          .prepare('INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id')
          .bind(name, phone)
          .first<{ id: number }>())!.id

  // Guard: the technician is free for the WHOLE chain window, and not on
  // time-off in it. Half-open overlap (CONVENTIONS §2). This checks against
  // PRE-EXISTING rows only — the chain's own items overlap each other by
  // design (serial, contiguous), so the item insert below must NOT re-derive
  // occupancy from siblings it is itself creating (see the note there).
  const freeGuard = `
    NOT EXISTS (
      SELECT 1 FROM booking_items bi
      WHERE bi.staff_id = ? AND bi.status IN ('booked','in_service')
        AND bi.start_at < ? AND bi.block_end_at > ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM time_off t
      WHERE t.staff_id = ? AND t.start_at < ? AND t.end_at > ?
    )`
  const guardArgs = [staffId, blockEndAt, startAt, staffId, blockEndAt, startAt]

  // The N item rows are inserted in ONE multi-row statement so that
  // last_insert_rowid() (the appointment's id from statement 1) stays constant
  // for every row. If items were inserted one statement at a time, statement k
  // would see items 1..k-1 as existing booking_items overlapping the chain
  // window and its guard would wrongly fire — the whole point of a serial combo
  // is that its own legs are contiguous, not conflicting. Both statements carry
  // the SAME pre-existing-only guard, so a lost race writes NOTHING (D1 batch
  // is atomic; if statement 1's guard blocks, last_insert_rowid() is unusable
  // and statement 2 inserts 0 rows too).
  const itemsValues = items.map(() => `(last_insert_rowid(), ?, ?, ?, ?, ?, 'booked')`).join(', ')
  const itemsBinds: (number)[] = []
  for (const it of items) itemsBinds.push(staffId, it.variant_id, it.start_at, it.end_at, it.block_end_at)

  const statements = [
    db
      .prepare(
        `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
         SELECT ?, ?, ?, 'booked', 'online', ? WHERE ${freeGuard}`,
      )
      .bind(customerId, startAt, endAt, now, ...guardArgs),
    // Multi-row INSERT gated on the SAME window being free. `INSERT ... SELECT
    // ... WHERE` cannot carry multiple VALUES rows, so we express the whole set
    // as a single VALUES list wrapped in a guard via `INSERT ... SELECT * FROM
    // (VALUES ...) WHERE <guard>` — SQLite evaluates last_insert_rowid() once
    // per row at execution, all resolving to the appointment just created.
    db
      .prepare(
        `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
         SELECT * FROM (VALUES ${itemsValues}) WHERE ${freeGuard}`,
      )
      .bind(...itemsBinds, ...guardArgs),
  ]

  try {
    const res = await db.batch(statements)
    const apptWrote = (res[0]!.meta.changes ?? 0) > 0
    const itemsWrote = (res[1]!.meta.changes ?? 0) === items.length
    if (!apptWrote || !itemsWrote) {
      return c.json(errorBody('SLOT_TAKEN', 'Khung giờ này vừa có người đặt mất'), 409)
    }

    const appointmentId = res[0]!.meta.last_row_id
    const appointment = await db
      .prepare('SELECT id, customer_id, start_at, end_at, status, source, created_at FROM appointments WHERE id = ?')
      .bind(appointmentId)
      .first()
    const itemRows = await db
      .prepare(
        `SELECT id, appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status
         FROM booking_items WHERE appointment_id = ? ORDER BY start_at, id`,
      )
      .bind(appointmentId)
      .all()
    const staffRow = await db.prepare('SELECT id, name FROM staff WHERE id = ?').bind(staffId).first<Staff>()

    return c.json({ appointment, items: itemRows.results, staff: staffRow }, 201)
  } catch {
    // Any guard/constraint failure rolls back the whole batch — nothing written.
    return c.json(errorBody('SLOT_TAKEN', 'Khung giờ này vừa có người đặt mất'), 409)
  }
})

export default routes
