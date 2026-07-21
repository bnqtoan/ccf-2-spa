// D1 access for the booking write path (T-04).
//
// ============================================================================
// D1 TRANSACTION SEMANTICS — measured, not assumed (card's known trap)
// ============================================================================
// Probed empirically against real D1 in workerd. Findings:
//
//  1. `db.batch([...])` IS atomic. A constraint failure in a later statement
//     rolls back the earlier ones (probe: NOT NULL violation left 0 rows).
//  2. Explicit `BEGIN` / `COMMIT` are REJECTED by D1 outright with
//     "To execute a transaction, please use the state.storage.transaction()
//     ... APIs instead of the SQL BEGIN TRANSACTION". So `batch()` is the only
//     transaction primitive available here.
//  3. THEREFORE the decisive limitation: a batch is a fixed list of statements
//     submitted together. No JavaScript can run BETWEEN them. "Read the
//     conflicting rows, decide in JS, then write" cannot be made atomic,
//     because the `await` on the read yields the isolate and another request
//     interleaves. Probe: two concurrent JS read-then-write attempts both saw
//     an empty table and both wrote — 2 overlapping rows.
//  4. So the re-check must be EXPRESSED IN SQL INSIDE the writing statement.
//     `INSERT ... SELECT ... WHERE NOT EXISTS (...)` makes the DB the
//     arbiter. `meta.changes` then reports 1 (won) or 0 (lost the race).
//     Probe: two concurrent guarded inserts → changes 1 and 0, exactly 1 row.
//  5. `last_insert_rowid()` is visible to later statements in the same batch,
//     so appointment→booking_item chaining needs no JS round-trip; and
//     `RETURNING` works inside a batch (empty `results` when the guard blocks).
//
// The consequence for this module: `insertBookingAtomically` performs the
// authoritative overlap re-check as a SQL predicate on the INSERT itself, then
// verifies `meta.changes`. The pure `validateBooking` still runs beforehand so
// clients get precise error codes (OUTSIDE_SHIFT, STAFF_LACKS_SKILL); the SQL
// guard is what makes the *overlap* rule race-proof.
// ============================================================================

import type { BusyItem, TimeOffInterval } from '../lib/availability.ts'
import type { Appointment, BookingItem, ServiceVariant, Staff, WorkShift } from './types.ts'

/** A service variant joined to the skill its parent service requires. */
export interface VariantWithSkill {
  id: number
  service_id: number
  duration_min: number
  buffer_after_min: number
  skill_id: number
  service_name: string
  variant_name: string
}

export async function loadVariantWithSkill(
  db: D1Database,
  variantId: number,
): Promise<VariantWithSkill | null> {
  return db
    .prepare(
      `SELECT sv.id, sv.service_id, sv.duration_min, sv.buffer_after_min,
              sv.name AS variant_name, s.skill_id, s.name AS service_name
       FROM service_variants sv
       JOIN services s ON s.id = sv.service_id
       WHERE sv.id = ?`,
    )
    .bind(variantId)
    .first<VariantWithSkill>()
}

/** Active staff holding `skillId`, ascending by id so callers stay deterministic. */
export async function loadCandidateStaff(
  db: D1Database,
  skillId: number,
): Promise<Pick<Staff, 'id' | 'active'>[]> {
  const res = await db
    .prepare(
      `SELECT st.id, st.active
       FROM staff st
       JOIN staff_skills ss ON ss.staff_id = st.id
       WHERE ss.skill_id = ? AND st.active = 1
       ORDER BY st.id`,
    )
    .bind(skillId)
    .all<Pick<Staff, 'id' | 'active'>>()
  return res.results
}

export interface DayContext {
  shifts: Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>[]
  timeOff: TimeOffInterval[]
  busyItems: BusyItem[]
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

/**
 * Loads everything the availability engine needs for a set of technicians on
 * one local day. Three batched queries — never one per technician.
 */
export async function loadDayContext(
  db: D1Database,
  staffIds: number[],
  weekday: number,
  dayStart: number,
  dayEnd: number,
): Promise<DayContext> {
  if (staffIds.length === 0) return { shifts: [], timeOff: [], busyItems: [] }
  const ph = placeholders(staffIds.length)

  const [shiftRes, timeOffRes, busyRes] = await Promise.all([
    db
      .prepare(
        `SELECT staff_id, start_min, end_min FROM work_shifts
         WHERE weekday = ? AND staff_id IN (${ph})`,
      )
      .bind(weekday, ...staffIds)
      .all<Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>>(),
    db
      .prepare(
        `SELECT staff_id, start_at, end_at FROM time_off
         WHERE staff_id IN (${ph}) AND start_at < ? AND end_at > ?`,
      )
      .bind(...staffIds, dayEnd, dayStart)
      .all<TimeOffInterval>(),
    // block_end_at, never end_at (CONVENTIONS §2).
    db
      .prepare(
        `SELECT staff_id, start_at, block_end_at FROM booking_items
         WHERE staff_id IN (${ph})
           AND status IN ('booked','in_service')
           AND start_at < ? AND block_end_at > ?`,
      )
      .bind(...staffIds, dayEnd, dayStart)
      .all<BusyItem>(),
  ])

  return { shifts: shiftRes.results, timeOff: timeOffRes.results, busyItems: busyRes.results }
}

/**
 * The narrow re-check load the card asks for: one technician, one moment.
 *
 * Deliberately tighter than the whole-day load — it only fetches rows that
 * actually intersect `[start_at, block_end_at)`, so the pre-write check stays
 * cheap. It is an ADVISORY read used to produce a precise error code; the
 * race-proof check is the SQL guard inside `insertBookingAtomically`.
 */
export async function loadStaffWindowContext(
  db: D1Database,
  staffId: number,
  blockStart: number,
  blockEnd: number,
  weekday: number,
): Promise<{ shifts: Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>[]; timeOff: TimeOffInterval[]; busyItems: BusyItem[] }> {
  const [shiftRes, timeOffRes, busyRes] = await Promise.all([
    db
      .prepare('SELECT staff_id, start_min, end_min FROM work_shifts WHERE staff_id = ? AND weekday = ?')
      .bind(staffId, weekday)
      .all<Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>>(),
    db
      .prepare(
        `SELECT staff_id, start_at, end_at FROM time_off
         WHERE staff_id = ? AND start_at < ? AND end_at > ?`,
      )
      .bind(staffId, blockEnd, blockStart)
      .all<TimeOffInterval>(),
    db
      .prepare(
        `SELECT staff_id, start_at, block_end_at FROM booking_items
         WHERE staff_id = ?
           AND status IN ('booked','in_service')
           AND start_at < ? AND block_end_at > ?`,
      )
      .bind(staffId, blockEnd, blockStart)
      .all<BusyItem>(),
  ])

  return { shifts: shiftRes.results, timeOff: timeOffRes.results, busyItems: busyRes.results }
}

/** True when `staffId` holds `skillId`. */
export async function staffHasSkill(db: D1Database, staffId: number, skillId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM staff_skills WHERE staff_id = ? AND skill_id = ?')
    .bind(staffId, skillId)
    .first<{ ok: number }>()
  return row !== null
}

/** Existing customer by phone, or null. Phone is the identity key (PRD §5). */
export async function findCustomerByPhone(db: D1Database, phone: string): Promise<{ id: number } | null> {
  return db.prepare('SELECT id FROM customers WHERE phone = ? ORDER BY id LIMIT 1').bind(phone).first<{ id: number }>()
}

export async function createCustomer(db: D1Database, name: string, phone: string | null): Promise<number> {
  const row = await db
    .prepare('INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id')
    .bind(name, phone)
    .first<{ id: number }>()
  return row!.id
}

export interface AtomicInsertInput {
  customer_id: number
  staff_id: number
  variant_id: number
  start_at: number
  end_at: number
  block_end_at: number
  source: 'online' | 'walk_in' | 'admin'
  /** `booked` for online, `in_service` for walk-ins (T-08). */
  status: 'booked' | 'in_service'
  created_at: number
}

export type AtomicInsertResult =
  | { ok: true; appointment: Appointment; item: BookingItem }
  | { ok: false; reason: 'SLOT_TAKEN' }

/**
 * Writes appointment + booking_item atomically, re-checking availability
 * INSIDE the transaction (PRD §5).
 *
 * The re-check is a `WHERE NOT EXISTS` predicate on the INSERTs rather than a
 * preceding SELECT, because D1 cannot run JS between batched statements (see
 * the header note). The DB itself decides whether the interval is still free,
 * at the instant of the write, and `meta.changes` reports the verdict.
 *
 * BOTH inserts carry the SAME guard, which is what keeps the failure mode
 * clean: the loser of a race writes nothing at all — no appointment, no item —
 * so there is no orphan row to clean up and no need to provoke an error just
 * to force a rollback. Statement 2 chains to statement 1 via
 * `last_insert_rowid()`, which D1 does propagate within a batch.
 */
export async function insertBookingAtomically(
  db: D1Database,
  input: AtomicInsertInput,
): Promise<AtomicInsertResult> {
  const { customer_id, staff_id, variant_id, start_at, end_at, block_end_at, source, status, created_at } = input

  // THE AUTHORITATIVE CHECK, shared by both inserts. Half-open overlap
  // (CONVENTIONS §2): existing.start_at < new.block_end_at
  //              AND existing.block_end_at > new.start_at.
  // Adjacency (existing.block_end_at == new.start_at) is NOT an overlap and
  // must stay bookable — hence strict `<` / `>`, never `<=` / `>=`.
  // `block_end_at` on both sides; `end_at` appears nowhere in this predicate.
  const freeGuard = `
    NOT EXISTS (
      SELECT 1 FROM booking_items bi
      WHERE bi.staff_id = ?
        AND bi.status IN ('booked','in_service')
        AND bi.start_at < ?
        AND bi.block_end_at > ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM time_off t
      WHERE t.staff_id = ?
        AND t.start_at < ?
        AND t.end_at > ?
    )`
  // Bind order for one copy of `freeGuard`.
  const guardArgs = [staff_id, block_end_at, start_at, staff_id, block_end_at, start_at]

  try {
    const res = await db.batch([
      db
        .prepare(
          `INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE ${freeGuard}`,
        )
        .bind(customer_id, start_at, end_at, status, source, created_at, ...guardArgs),

      db
        .prepare(
          `INSERT INTO booking_items
             (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
           SELECT last_insert_rowid(), ?, ?, ?, ?, ?, ? WHERE ${freeGuard}`,
        )
        .bind(staff_id, variant_id, start_at, end_at, block_end_at, status, ...guardArgs),
    ])

    const apptChanges = res[0]!.meta.changes ?? 0
    const itemChanges = res[1]!.meta.changes ?? 0
    // Both guards evaluate against the same snapshot inside one batch, so they
    // agree. Requiring both to have written is a belt-and-braces assertion: a
    // half-write would mean an orphan, and we would rather report SLOT_TAKEN.
    if (apptChanges === 0 || itemChanges === 0) return { ok: false, reason: 'SLOT_TAKEN' }

    const appointmentId = res[0]!.meta.last_row_id
    const appointment = await db
      .prepare(
        'SELECT id, customer_id, start_at, end_at, status, source, created_at FROM appointments WHERE id = ?',
      )
      .bind(appointmentId)
      .first<Appointment>()
    const item = await db
      .prepare(
        `SELECT id, appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status, cancelled_at
         FROM booking_items WHERE appointment_id = ?`,
      )
      .bind(appointmentId)
      .first<BookingItem>()

    if (appointment === null || item === null) return { ok: false, reason: 'SLOT_TAKEN' }
    return { ok: true, appointment, item }
  } catch {
    // The guard statement fired (or any other constraint did): the batch rolled
    // back, nothing was written, and the only business meaning is "lost the race".
    return { ok: false, reason: 'SLOT_TAKEN' }
  }
}

export interface CustomerBookingRow {
  appointment_id: number
  item_id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: string
  source: string
  staff_id: number
  staff_name: string
  service_name: string
  variant_name: string
}

/** A phone's bookings, newest rules aside — ordered by `start_at` (card §4). */
export async function listBookingsByPhone(db: D1Database, phone: string): Promise<CustomerBookingRow[]> {
  const res = await db
    .prepare(
      `SELECT a.id AS appointment_id, bi.id AS item_id,
              bi.start_at, bi.end_at, bi.block_end_at, bi.status,
              a.source, bi.staff_id, st.name AS staff_name,
              s.name AS service_name, sv.name AS variant_name
       FROM appointments a
       JOIN customers c        ON c.id = a.customer_id
       JOIN booking_items bi   ON bi.appointment_id = a.id
       JOIN staff st           ON st.id = bi.staff_id
       JOIN service_variants sv ON sv.id = bi.variant_id
       JOIN services s         ON s.id = sv.service_id
       WHERE c.phone = ?
       ORDER BY bi.start_at, bi.id`,
    )
    .bind(phone)
    .all<CustomerBookingRow>()
  return res.results
}
