// D1 access for time-off and the reassign queue (T-07).
//
// ============================================================================
// TWO IDEAS GOVERN THIS FILE
// ============================================================================
//
// 1. THE QUEUE IS DERIVED, NEVER STORED.
//    There is no `is_orphaned` column and there must never be one. An item is
//    orphaned exactly when it is still `booked`/`in_service` AND its occupancy
//    block `[start_at, block_end_at)` overlaps a `time_off` row of its OWN
//    technician. Deleting the time-off, cancelling the item, or reassigning it
//    to a free technician all make it leave the queue with zero bookkeeping —
//    because the queue is a JOIN, not a flag. A flag would go stale on the very
//    first `DELETE /api/admin/time-off/:id`.
//
// 2. THE REASSIGN WRITE RE-CHECKS IN SQL, NOT IN JS.
//    Measured in T-04 against real D1: `batch()` is atomic but no JavaScript
//    can run between its statements, and explicit BEGIN/COMMIT is rejected
//    outright. So "read → decide in JS → write" cannot be atomic: the `await`
//    on the read yields the isolate and a second request interleaves. Two desks
//    moving two customers onto the same free technician at the same second
//    would both see a free slot and both write.
//    Therefore `reassignItemAtomically` puts the overlap/time-off test INSIDE
//    the `UPDATE ... WHERE` and reads `meta.changes` for the verdict. The pure
//    `validateBooking` still runs first, but only to produce a precise error
//    code (STAFF_LACKS_SKILL / OUTSIDE_SHIFT); the SQL predicate is what makes
//    the overlap rule race-proof.
// ============================================================================

import type { BusyItem, TimeOffInterval } from '../lib/availability.ts'
import type { Staff, TimeOff, WorkShift } from './types.ts'

/**
 * A booking item plus everything a receptionist needs in order to pick up the
 * phone: who the customer is, how to reach them, what they booked, when.
 *
 * `phone` is nullable on purpose — a walk-in customer may have no number
 * (CONVENTIONS §4). The desk still needs to see the row; it just cannot call.
 */
export interface AffectedItem {
  item_id: number
  appointment_id: number
  staff_id: number
  staff_name: string
  customer_id: number
  customer_name: string
  customer_phone: string | null
  service_name: string
  variant_name: string
  variant_id: number
  duration_min: number
  buffer_after_min: number
  skill_id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: string
}

const AFFECTED_COLUMNS = `
  bi.id             AS item_id,
  bi.appointment_id AS appointment_id,
  bi.staff_id       AS staff_id,
  st.name           AS staff_name,
  c.id              AS customer_id,
  c.name            AS customer_name,
  c.phone           AS customer_phone,
  s.name            AS service_name,
  sv.name           AS variant_name,
  sv.id             AS variant_id,
  sv.duration_min   AS duration_min,
  sv.buffer_after_min AS buffer_after_min,
  s.skill_id        AS skill_id,
  bi.start_at       AS start_at,
  bi.end_at         AS end_at,
  bi.block_end_at   AS block_end_at,
  bi.status         AS status`

const AFFECTED_JOINS = `
  FROM booking_items bi
  JOIN appointments a      ON a.id  = bi.appointment_id
  JOIN customers c         ON c.id  = a.customer_id
  JOIN staff st            ON st.id = bi.staff_id
  JOIN service_variants sv ON sv.id = bi.variant_id
  JOIN services s          ON s.id  = sv.service_id`

/** Row exists? Used so a bad `staff_id` answers 404 rather than an FK error. */
export async function staffExists(db: D1Database, staffId: number): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS ok FROM staff WHERE id = ?').bind(staffId).first<{ ok: number }>()
  return row !== null
}

export async function insertTimeOff(
  db: D1Database,
  input: { staff_id: number; start_at: number; end_at: number; reason: string | null },
): Promise<TimeOff> {
  const row = await db
    .prepare(
      `INSERT INTO time_off (staff_id, start_at, end_at, reason)
       VALUES (?, ?, ?, ?)
       RETURNING id, staff_id, start_at, end_at, reason`,
    )
    .bind(input.staff_id, input.start_at, input.end_at, input.reason)
    .first<TimeOff>()
  return row!
}

export async function getTimeOff(db: D1Database, id: number): Promise<TimeOff | null> {
  return db
    .prepare('SELECT id, staff_id, start_at, end_at, reason FROM time_off WHERE id = ?')
    .bind(id)
    .first<TimeOff>()
}

/** Hard delete — a time-off row carries no history worth keeping once the
 *  technician turns out to be coming in after all. Returns false when absent. */
export async function deleteTimeOff(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare('DELETE FROM time_off WHERE id = ?').bind(id).run()
  return (res.meta.changes ?? 0) > 0
}

/**
 * Items this time-off strands: same technician, still live, occupancy block
 * overlapping the leave window.
 *
 * `bi.block_end_at > ?` — NOT `bi.end_at`. A leave that begins inside the
 * buffer still strands the booking, because the technician needs that buffer to
 * finish and clean up (CONVENTIONS §2). Strict `<` / `>` keep adjacency legal:
 * leave starting exactly at `block_end_at` affects nothing.
 */
export async function findAffectedItems(
  db: D1Database,
  staffId: number,
  startAt: number,
  endAt: number,
): Promise<AffectedItem[]> {
  const res = await db
    .prepare(
      `SELECT ${AFFECTED_COLUMNS}
       ${AFFECTED_JOINS}
       WHERE bi.staff_id = ?
         AND bi.status IN ('booked','in_service')
         AND bi.start_at < ?
         AND bi.block_end_at > ?
       ORDER BY bi.start_at, bi.id`,
    )
    .bind(staffId, endAt, startAt)
    .all<AffectedItem>()
  return res.results
}

/**
 * THE QUEUE. Every live item whose own technician has leave over it, soonest
 * first — the customer whose appointment is nearest must be called first.
 *
 * Note there is no flag column anywhere in this query: the `EXISTS` against
 * `time_off` IS the definition. Delete the leave and the row simply stops
 * matching.
 */
export async function loadReassignQueue(db: D1Database): Promise<AffectedItem[]> {
  const res = await db
    .prepare(
      `SELECT ${AFFECTED_COLUMNS}
       ${AFFECTED_JOINS}
       WHERE bi.status IN ('booked','in_service')
         AND EXISTS (
           SELECT 1 FROM time_off t
           WHERE t.staff_id = bi.staff_id
             AND t.start_at < bi.block_end_at
             AND t.end_at   > bi.start_at
         )
       ORDER BY bi.start_at, bi.id`,
    )
    .all<AffectedItem>()
  return res.results
}

/** One item with the same shape the queue exposes, or null. */
export async function loadItemDetail(db: D1Database, itemId: number): Promise<AffectedItem | null> {
  return db
    .prepare(`SELECT ${AFFECTED_COLUMNS} ${AFFECTED_JOINS} WHERE bi.id = ?`)
    .bind(itemId)
    .first<AffectedItem>()
}

/** Active technicians other than `excludeId`, ascending — deterministic order. */
export async function loadOtherActiveStaff(
  db: D1Database,
  excludeId: number,
): Promise<Pick<Staff, 'id' | 'name' | 'active'>[]> {
  const res = await db
    .prepare('SELECT id, name, active FROM staff WHERE active = 1 AND id <> ? ORDER BY id')
    .bind(excludeId)
    .all<Pick<Staff, 'id' | 'name' | 'active'>>()
  return res.results
}

export interface MultiStaffWindowContext {
  shifts: Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>[]
  timeOff: TimeOffInterval[]
  busyItems: BusyItem[]
  skilled: Set<number>
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}

/**
 * Everything the candidate evaluation needs, for many technicians at once and
 * only for the window the item occupies. Four queries total, never one per
 * technician.
 *
 * `excludeItemId` drops the item BEING MOVED from the busy set — otherwise it
 * would collide with itself whenever `staffIds` includes its current owner.
 *
 * Today's two callers never do include the owner (the candidates endpoint asks
 * `loadOtherActiveStaff`, and reassign rejects self-assignment with 422 before
 * reaching here), so a mutation removing this filter does not turn any test
 * red — it is stated here rather than left implied. It stays because it is a
 * precondition of the function's CONTRACT, not of its current call sites: any
 * future caller that passes the owner would otherwise silently be told the
 * technician is busy with the very appointment being moved. The equivalent
 * guard inside `reassignItemAtomically` IS reachable and IS tested.
 */
export async function loadWindowContextForStaff(
  db: D1Database,
  staffIds: number[],
  weekday: number,
  blockStart: number,
  blockEnd: number,
  skillId: number,
  excludeItemId: number,
): Promise<MultiStaffWindowContext> {
  if (staffIds.length === 0) {
    return { shifts: [], timeOff: [], busyItems: [], skilled: new Set() }
  }
  const ph = placeholders(staffIds.length)

  const [shiftRes, timeOffRes, busyRes, skillRes] = await Promise.all([
    db
      .prepare(`SELECT staff_id, start_min, end_min FROM work_shifts WHERE weekday = ? AND staff_id IN (${ph})`)
      .bind(weekday, ...staffIds)
      .all<Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>>(),
    db
      .prepare(
        `SELECT staff_id, start_at, end_at FROM time_off
         WHERE staff_id IN (${ph}) AND start_at < ? AND end_at > ?`,
      )
      .bind(...staffIds, blockEnd, blockStart)
      .all<TimeOffInterval>(),
    // block_end_at on both sides (CONVENTIONS §2); end_at never appears.
    db
      .prepare(
        `SELECT staff_id, start_at, block_end_at FROM booking_items
         WHERE staff_id IN (${ph})
           AND id <> ?
           AND status IN ('booked','in_service')
           AND start_at < ? AND block_end_at > ?`,
      )
      .bind(...staffIds, excludeItemId, blockEnd, blockStart)
      .all<BusyItem>(),
    db
      .prepare(`SELECT staff_id FROM staff_skills WHERE skill_id = ? AND staff_id IN (${ph})`)
      .bind(skillId, ...staffIds)
      .all<{ staff_id: number }>(),
  ])

  return {
    shifts: shiftRes.results,
    timeOff: timeOffRes.results,
    busyItems: busyRes.results,
    skilled: new Set(skillRes.results.map((r) => r.staff_id)),
  }
}

export type ReassignWriteResult = { ok: true } | { ok: false; reason: 'SLOT_TAKEN' | 'INVALID_TRANSITION' }

/**
 * Moves one item to another technician, re-checking availability INSIDE the
 * write.
 *
 * The `WHERE` clause carries four separate guards, and the reason each one is
 * there matters:
 *
 *  - `id = ?` + `status IN ('booked','in_service')` — a `cancelled`/`done` item
 *    is not movable. Checking the status here as well as in JS closes the
 *    window where someone cancels between the read and this write.
 *  - `NOT EXISTS (booking_items ...)` — the new technician must be free for the
 *    WHOLE block. This is the guard that makes two simultaneous reassigns onto
 *    the same technician resolve to exactly one winner.
 *  - `NOT EXISTS (time_off ...)` — and must not be on leave. Otherwise reassign
 *    becomes a way to move a customer straight into another absence.
 *
 * Half-open comparison throughout (`<` / `>`, never `<=` / `>=`): an item that
 * starts exactly at another's `block_end_at` is adjacent, not overlapping, and
 * must remain assignable.
 *
 * `meta.changes` is the verdict. Zero changes means the DB refused, so we ask
 * it why (still live?) to separate INVALID_TRANSITION from SLOT_TAKEN.
 */
export async function reassignItemAtomically(
  db: D1Database,
  input: { item_id: number; new_staff_id: number; start_at: number; block_end_at: number },
): Promise<ReassignWriteResult> {
  const { item_id, new_staff_id, start_at, block_end_at } = input

  const res = await db
    .prepare(
      `UPDATE booking_items
          SET staff_id = ?
        WHERE id = ?
          AND status IN ('booked','in_service')
          AND NOT EXISTS (
            SELECT 1 FROM booking_items other
            WHERE other.staff_id = ?
              AND other.id <> ?
              AND other.status IN ('booked','in_service')
              AND other.start_at < ?
              AND other.block_end_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM time_off t
            WHERE t.staff_id = ?
              AND t.start_at < ?
              AND t.end_at   > ?
          )`,
    )
    .bind(
      new_staff_id,
      item_id,
      new_staff_id,
      item_id,
      block_end_at,
      start_at,
      new_staff_id,
      block_end_at,
      start_at,
    )
    .run()

  if ((res.meta.changes ?? 0) > 0) return { ok: true }

  // Nothing changed. Distinguish "not movable" from "lost the slot" so the desk
  // gets a code it can act on.
  const row = await db
    .prepare("SELECT 1 AS ok FROM booking_items WHERE id = ? AND status IN ('booked','in_service')")
    .bind(item_id)
    .first<{ ok: number }>()
  return { ok: false, reason: row === null ? 'INVALID_TRANSITION' : 'SLOT_TAKEN' }
}
