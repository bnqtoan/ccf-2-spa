// POST /api/admin/appointments/:id/items — reception adds a manual item to an
// EXISTING appointment (v1's hand-made combo, PRD §1, §9).
//
// Falls in the gap between T-04 (new booking + new appointment) and T-07
// (reassign/time-off on an EXISTING item): neither owns "add another item to
// an appointment that already exists". Re-uses `validateBooking` verbatim —
// see src/worker/routes/admin-reassign.ts for the load-context-then-validate
// shape this route follows — plus ONE extra rule this endpoint alone needs:
// two items in the SAME appointment that overlap in time must not share a
// `body_zone` (PRD §11) — that is what a combo actually means; two
// simultaneous "body" services on the same customer make no physical sense.
//
// The write follows the exact D1 lesson from src/worker/db/bookings.ts: a
// read-then-decide-then-write is NOT atomic (the `await` on the read yields
// the isolate), so the authoritative re-check — BOTH the staff-availability
// guard AND the zone-conflict guard — is expressed as SQL predicates on the
// INSERT itself, verified via `meta.changes`.

import { Hono } from 'hono'
import { localDayBounds, localParts, minutesToEpoch } from '../lib/time.ts'
import { blockEndAt, endAt, validateBooking } from '../lib/validate-booking.ts'
import type { Interval } from '../lib/intervals.ts'
import { overlaps } from '../lib/intervals.ts'

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

interface ItemPayload {
  variant_id?: unknown
  staff_id?: unknown
  start_at?: unknown
}

interface VariantWithZone {
  id: number
  service_id: number
  duration_min: number
  buffer_after_min: number
  skill_id: number
  body_zone: string
}

/** Sibling items already in this appointment (any live status), with zone. */
interface SiblingItem {
  id: number
  start_at: number
  block_end_at: number
  body_zone: string
}

routes.post('/api/admin/appointments/:id/items', async (c) => {
  const db = c.env.DB
  const appointmentId = Number(c.req.param('id'))
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    return c.json(errorBody('NOT_FOUND', 'Không tìm thấy appointment'), 404)
  }

  const appointment = await db
    .prepare('SELECT id, customer_id, status FROM appointments WHERE id = ?')
    .bind(appointmentId)
    .first<{ id: number; customer_id: number; status: string }>()
  if (appointment === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy appointment ${appointmentId}`), 404)
  }

  let payload: ItemPayload
  try {
    payload = (await c.req.json()) as ItemPayload
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const variantId = Number(payload.variant_id)
  if (!Number.isInteger(variantId) || variantId <= 0) {
    return c.json(errorBody('VALIDATION', 'variant_id phải là số nguyên dương'), 422)
  }
  const staffId = Number(payload.staff_id)
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
  }
  const startAt = Number(payload.start_at)
  if (!Number.isInteger(startAt) || startAt <= 0) {
    return c.json(errorBody('VALIDATION', 'start_at phải là epoch giây (số nguyên dương)'), 422)
  }

  const variant = await db
    .prepare(
      `SELECT sv.id, sv.service_id, sv.duration_min, sv.buffer_after_min,
              s.skill_id, s.body_zone
       FROM service_variants sv
       JOIN services s ON s.id = sv.service_id
       WHERE sv.id = ?`,
    )
    .bind(variantId)
    .first<VariantWithZone>()
  if (variant === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy service variant ${variantId}`), 404)
  }

  const now = Math.floor(Date.now() / 1000)
  const dateStr = localDateStr(startAt)
  const { start: dayStart } = localDayBounds(dateStr)
  const weekday = localWeekday(startAt)

  const itemEndAt = endAt(startAt, variant)
  const itemBlockEndAt = blockEndAt(startAt, variant)

  // --- load context for validateBooking (same shape as admin-reassign.ts) ---
  const [hasSkillRow, shiftsRes, timeOffRes, busyRes, siblingsRes] = await Promise.all([
    db
      .prepare('SELECT 1 AS ok FROM staff_skills WHERE staff_id = ? AND skill_id = ?')
      .bind(staffId, variant.skill_id)
      .first<{ ok: number }>(),
    db
      .prepare('SELECT staff_id, start_min, end_min FROM work_shifts WHERE staff_id = ? AND weekday = ?')
      .bind(staffId, weekday)
      .all<{ staff_id: number; start_min: number; end_min: number }>(),
    db
      .prepare('SELECT staff_id, start_at, end_at FROM time_off WHERE staff_id = ? AND start_at < ? AND end_at > ?')
      .bind(staffId, itemBlockEndAt, startAt)
      .all<{ staff_id: number; start_at: number; end_at: number }>(),
    db
      .prepare(
        `SELECT staff_id, start_at, block_end_at FROM booking_items
         WHERE staff_id = ? AND status IN ('booked','in_service')
           AND start_at < ? AND block_end_at > ?`,
      )
      .bind(staffId, itemBlockEndAt, startAt)
      .all<{ staff_id: number; start_at: number; block_end_at: number }>(),
    // Every live sibling item in THIS appointment, for the body_zone check.
    // `bi.id` and zone via its own variant/service — not the new item's.
    db
      .prepare(
        `SELECT bi.id AS id, bi.start_at AS start_at, bi.block_end_at AS block_end_at,
                s.body_zone AS body_zone
         FROM booking_items bi
         JOIN service_variants sv ON sv.id = bi.variant_id
         JOIN services s ON s.id = sv.service_id
         WHERE bi.appointment_id = ? AND bi.status IN ('booked','in_service')`,
      )
      .bind(appointmentId)
      .all<SiblingItem>(),
  ])

  const shiftWindows: Interval[] = shiftsRes.results.map((s) => ({
    start: minutesToEpoch(dayStart, s.start_min),
    end: minutesToEpoch(dayStart, s.end_min),
  }))

  const problem = validateBooking({
    variant: { duration_min: variant.duration_min, buffer_after_min: variant.buffer_after_min },
    start_at: startAt,
    staff_id: staffId,
    staffHasSkill: hasSkillRow !== null,
    shifts: shiftsRes.results,
    shiftWindows,
    timeOff: timeOffRes.results,
    busyItems: busyRes.results,
    now,
    isWalkIn: false,
  })

  if (problem !== null) {
    const status = problem.code === 'VALIDATION' ? 422 : 409
    return c.json(errorBody(problem.code, problem.message), status)
  }

  // --- extra rule this endpoint alone needs: body_zone conflict within the
  // SAME appointment (PRD §11). Advisory check here for a precise error code;
  // the SQL guard on the INSERT below is what makes it race-proof.
  const newBlock: Interval = { start: startAt, end: itemBlockEndAt }
  const zoneConflict = siblingsRes.results.some(
    (sib) => sib.body_zone === variant.body_zone && overlaps(newBlock, { start: sib.start_at, end: sib.block_end_at }),
  )
  if (zoneConflict) {
    return c.json(errorBody('ZONE_CONFLICT', 'Item chồng giờ với một item khác cùng body_zone trong appointment này'), 409)
  }

  // --- the write: SQL re-checks BOTH guards inside the INSERT itself --------
  // (D1 lesson from src/worker/db/bookings.ts: no JS between batched
  // statements, so "read → decide in JS → write" cannot be atomic.)
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
    )
    AND NOT EXISTS (
      SELECT 1 FROM booking_items bi2
      JOIN service_variants sv2 ON sv2.id = bi2.variant_id
      JOIN services s2 ON s2.id = sv2.service_id
      WHERE bi2.appointment_id = ?
        AND bi2.status IN ('booked','in_service')
        AND s2.body_zone = ?
        AND bi2.start_at < ?
        AND bi2.block_end_at > ?
    )`
  const guardArgs = [
    staffId, itemBlockEndAt, startAt,
    staffId, itemBlockEndAt, startAt,
    appointmentId, variant.body_zone, itemBlockEndAt, startAt,
  ]

  try {
    const res = await db
      .prepare(
        `INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
         SELECT ?, ?, ?, ?, ?, ?, 'booked' WHERE ${freeGuard}`,
      )
      .bind(appointmentId, staffId, variantId, startAt, itemEndAt, itemBlockEndAt, ...guardArgs)
      .run()

    if ((res.meta.changes ?? 0) === 0) {
      // The guard fired between our advisory check and the write — re-check
      // fresh (cheap, single appointment) to report the right code rather
      // than always defaulting to SLOT_TAKEN.
      const freshZoneConflict = await db
        .prepare(
          `SELECT 1 AS ok FROM booking_items bi2
           JOIN service_variants sv2 ON sv2.id = bi2.variant_id
           JOIN services s2 ON s2.id = sv2.service_id
           WHERE bi2.appointment_id = ? AND bi2.status IN ('booked','in_service')
             AND s2.body_zone = ? AND bi2.start_at < ? AND bi2.block_end_at > ?`,
        )
        .bind(appointmentId, variant.body_zone, itemBlockEndAt, startAt)
        .first<{ ok: number }>()
      if (freshZoneConflict !== null) {
        return c.json(errorBody('ZONE_CONFLICT', 'Item chồng giờ với một item khác cùng body_zone trong appointment này'), 409)
      }
      return c.json(errorBody('SLOT_TAKEN', 'Kỹ thuật viên vừa bị chiếm mất khung giờ đó'), 409)
    }

    const itemId = res.meta.last_row_id
    const item = await db
      .prepare(
        `SELECT id, appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status, cancelled_at
         FROM booking_items WHERE id = ?`,
      )
      .bind(itemId)
      .first()

    return c.json({ item }, 201)
  } catch {
    return c.json(errorBody('SLOT_TAKEN', 'Kỹ thuật viên vừa bị chiếm mất khung giờ đó'), 409)
  }
})

export default routes
