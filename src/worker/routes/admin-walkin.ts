// GET  /api/admin/available-now?variant_id   — who is free AT THIS INSTANT
// POST /api/admin/walk-ins                   — front-desk walk-in booking
//
// PRD §7 / §11. Walk-in is a REAL appointment: `source='walk_in'`,
// `status='in_service'`. It is never modeled with `time_off` (CONVENTIONS §6
// exception, card's explicit warning) — doing so would erase revenue, service
// history, and customer identity for 30-50% of a spa's real traffic.
//
// `start_at` for a walk-in is exempt from exactly two rules — the 15-minute
// grid and "not in the past" — via `validateBooking({ ..., isWalkIn: true })`.
// That flag already exists in ../lib/validate-booking.ts (T-04); this route
// calls it rather than re-implementing any rule (card's explicit warning:
// two copies of the rules would drift apart).
//
// The write path reuses `insertBookingAtomically` from ../db/bookings.ts
// unchanged — same race-proof `INSERT ... WHERE NOT EXISTS` guard as online
// bookings (see that file's header for why a plain read-then-write can't be
// made atomic in D1).

import { Hono } from 'hono'
import {
  createCustomer,
  findCustomerByPhone,
  insertBookingAtomically,
  loadCandidateStaff,
  loadStaffWindowContext,
  loadVariantWithSkill,
  staffHasSkill,
} from '../db/bookings.ts'
import type { Interval } from '../lib/intervals.ts'
import { overlaps } from '../lib/intervals.ts'
import { localDayBounds, localParts, minutesToEpoch } from '../lib/time.ts'
import { blockEndAt, endAt, validateBooking } from '../lib/validate-booking.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

/** `YYYY-MM-DD` of an epoch, in SPA_TZ — the local day `now` belongs to. */
function localDateStr(epochSec: number): string {
  const p = localParts(epochSec)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Weekday (0=Sun..6=Sat) of the LOCAL day containing `epochSec`. */
function localWeekday(epochSec: number): number {
  const p = localParts(epochSec)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

routes.get('/api/admin/available-now', async (c) => {
  const db = c.env.DB
  const rawVariantId = c.req.query('variant_id')

  if (rawVariantId === undefined || rawVariantId === '') {
    return c.json(errorBody('VALIDATION', 'variant_id là bắt buộc'), 422)
  }
  const variantId = Number(rawVariantId)
  if (!Number.isInteger(variantId) || variantId <= 0) {
    return c.json(errorBody('VALIDATION', 'variant_id phải là số nguyên dương'), 422)
  }

  const variant = await loadVariantWithSkill(db, variantId)
  if (variant === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy service variant ${variantId}`), 404)
  }

  const now = Math.floor(Date.now() / 1000)
  const dateStr = localDateStr(now)
  const { start: dayStart } = localDayBounds(dateStr)
  const weekday = localWeekday(now)
  const blockStart = now
  const blockEnd = blockEndAt(now, variant)

  const candidates = await loadCandidateStaff(db, variant.skill_id)

  const free: { id: number }[] = []
  for (const person of candidates) {
    const ctx = await loadStaffWindowContext(db, person.id, blockStart, blockEnd, weekday)
    const shiftWindows: Interval[] = ctx.shifts.map((s) => ({
      start: minutesToEpoch(dayStart, s.start_min),
      end: minutesToEpoch(dayStart, s.end_min),
    }))
    const block: Interval = { start: blockStart, end: blockEnd }

    const fitsAShift = shiftWindows.some((w) => w.start <= block.start && block.end <= w.end)
    if (!fitsAShift) continue

    const onTimeOff = ctx.timeOff.some(
      (off) => off.staff_id === person.id && overlaps(block, { start: off.start_at, end: off.end_at }),
    )
    if (onTimeOff) continue

    const busy = ctx.busyItems.some(
      (item) => item.staff_id === person.id && overlaps(block, { start: item.start_at, end: item.block_end_at }),
    )
    if (busy) continue

    free.push({ id: person.id })
  }

  return c.json({ staff: free })
})

interface WalkInPayload {
  variant_id?: unknown
  staff_id?: unknown
  customer?: { name?: unknown; phone?: unknown }
}

routes.post('/api/admin/walk-ins', async (c) => {
  const db = c.env.DB

  let payload: WalkInPayload
  try {
    payload = (await c.req.json()) as WalkInPayload
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

  // Anonymous by default: no phone → phone stays NULL, name defaults to
  // "Khách lẻ" unless the receptionist typed one in.
  const rawName = payload.customer?.name
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : 'Khách lẻ'
  const rawPhone = payload.customer?.phone
  const phone = typeof rawPhone === 'string' && rawPhone.trim() !== '' ? rawPhone.trim() : null

  const variant = await loadVariantWithSkill(db, variantId)
  if (variant === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy service variant ${variantId}`), 404)
  }

  const now = Math.floor(Date.now() / 1000)
  const dateStr = localDateStr(now)
  const { start: dayStart } = localDayBounds(dateStr)
  const weekday = localWeekday(now)

  const itemEndAt = endAt(now, variant)
  const itemBlockEndAt = blockEndAt(now, variant)

  // --- advisory validation, for a precise error code --------------------
  const hasSkill = await staffHasSkill(db, staffId, variant.skill_id)
  const windowCtx = await loadStaffWindowContext(db, staffId, now, itemBlockEndAt, weekday)
  const shiftWindows: Interval[] = windowCtx.shifts.map((s) => ({
    start: minutesToEpoch(dayStart, s.start_min),
    end: minutesToEpoch(dayStart, s.end_min),
  }))

  const problem = validateBooking({
    variant: { duration_min: variant.duration_min, buffer_after_min: variant.buffer_after_min },
    start_at: now,
    staff_id: staffId,
    staffHasSkill: hasSkill,
    shifts: windowCtx.shifts,
    shiftWindows,
    timeOff: windowCtx.timeOff,
    busyItems: windowCtx.busyItems,
    now,
    isWalkIn: true, // exempts the 15-minute grid and "not in the past" only.
  })

  if (problem !== null) {
    const status = problem.code === 'VALIDATION' ? 422 : 409
    return c.json(errorBody(problem.code, problem.message), status)
  }

  // --- customer identity --------------------------------------------------
  let customerId: number
  if (phone !== null) {
    const existing = await findCustomerByPhone(db, phone)
    customerId = existing !== null ? existing.id : await createCustomer(db, name, phone)
  } else {
    customerId = await createCustomer(db, name, null)
  }

  // --- the write: same atomic guard as online bookings ---------------------
  const written = await insertBookingAtomically(db, {
    customer_id: customerId,
    staff_id: staffId,
    variant_id: variant.id,
    start_at: now,
    end_at: itemEndAt,
    block_end_at: itemBlockEndAt,
    source: 'walk_in',
    status: 'in_service',
    created_at: now,
  })

  if (!written.ok) {
    return c.json(errorBody('SLOT_TAKEN', 'Kỹ thuật viên này vừa bận mất'), 409)
  }

  const staffRow = await db
    .prepare('SELECT id, name FROM staff WHERE id = ?')
    .bind(staffId)
    .first<{ id: number; name: string }>()
  const customerRow = await db
    .prepare('SELECT id, name, phone FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ id: number; name: string; phone: string | null }>()

  return c.json(
    { appointment: written.appointment, item: written.item, staff: staffRow, customer: customerRow },
    201,
  )
})

export default routes
