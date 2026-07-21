// POST /api/bookings   — create a booking (PRD §5, §11)
// GET  /api/bookings?phone=  — customer looks up their own bookings
//
// This layer LOADS and FORMATS only. Every scheduling decision lives in the
// pure `computeAvailability` / `validateBooking` (CONVENTIONS §7), and the
// race-proof part lives in SQL (see src/worker/db/bookings.ts header).
//
// The write path, in order:
//   1. parse + shape-validate the payload            → 422 VALIDATION
//   2. load variant + required skill                 → 404 NOT_FOUND
//   3. pick a technician (given, or auto-assigned)   → 409 SLOT_TAKEN
//   4. pure validateBooking for a precise error code → 409 / 422
//   5. atomic guarded insert — the authoritative check → 409 SLOT_TAKEN
//
// Step 4 is advisory: everything it sees may be stale by the time step 5 runs.
// Step 5 is the truth. Step 4 exists only so a client gets STAFF_LACKS_SKILL
// or OUTSIDE_SHIFT instead of a blanket SLOT_TAKEN.

import { Hono } from 'hono'
import {
  createCustomer,
  findCustomerByPhone,
  insertBookingAtomically,
  listBookingsByPhone,
  loadCandidateStaff,
  loadDayContext,
  loadStaffWindowContext,
  loadVariantWithSkill,
  staffHasSkill,
} from '../db/bookings.ts'
import { computeAvailability, pickStaff } from '../lib/availability.ts'
import type { Interval } from '../lib/intervals.ts'
import { localDayBounds, localParts, minutesToEpoch } from '../lib/time.ts'
import { blockEndAt, endAt, validateBooking } from '../lib/validate-booking.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

/** `YYYY-MM-DD` of an epoch, in SPA_TZ — the local day the booking belongs to. */
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

interface BookingPayload {
  customer?: { name?: unknown; phone?: unknown }
  variant_id?: unknown
  start_at?: unknown
  staff_id?: unknown
}

routes.post('/api/bookings', async (c) => {
  const db = c.env.DB

  let payload: BookingPayload
  try {
    payload = (await c.req.json()) as BookingPayload
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  // --- 1. shape validation -------------------------------------------------
  const name = typeof payload.customer?.name === 'string' ? payload.customer.name.trim() : ''
  if (name === '') {
    return c.json(errorBody('VALIDATION', 'customer.name là bắt buộc'), 422)
  }

  // Phone is the identity key for lookups, so an online booking requires it.
  // (`customers.phone` stays nullable for anonymous walk-ins — CONVENTIONS §4.)
  const rawPhone = payload.customer?.phone
  const phone = typeof rawPhone === 'string' ? rawPhone.trim() : ''
  if (phone === '') {
    return c.json(errorBody('VALIDATION', 'customer.phone là bắt buộc'), 422)
  }

  const variantId = Number(payload.variant_id)
  if (!Number.isInteger(variantId) || variantId <= 0) {
    return c.json(errorBody('VALIDATION', 'variant_id phải là số nguyên dương'), 422)
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

  // --- 2. variant + required skill ----------------------------------------
  const variant = await loadVariantWithSkill(db, variantId)
  if (variant === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy service variant ${variantId}`), 404)
  }

  const now = Math.floor(Date.now() / 1000)
  const dateStr = localDateStr(startAt)
  const { start: dayStart, end: dayEnd } = localDayBounds(dateStr)
  const weekday = localWeekday(startAt)

  const itemEndAt = endAt(startAt, variant)
  const itemBlockEndAt = blockEndAt(startAt, variant)

  // --- 3. choose the technician -------------------------------------------
  let staffId: number
  if (requestedStaffId !== null) {
    staffId = requestedStaffId
  } else {
    // Auto-assign (PRD §4). Re-uses the SAME availability engine as
    // GET /api/availability so the two can never disagree, then applies
    // `pickStaff` (fewest booked minutes that day, ties → lowest staff_id).
    const candidates = await loadCandidateStaff(db, variant.skill_id)
    if (candidates.length === 0) {
      return c.json(errorBody('SLOT_TAKEN', 'Không có kỹ thuật viên nào rảnh cho khung giờ này'), 409)
    }
    const ids = candidates.map((s) => s.id)
    const ctx = await loadDayContext(db, ids, weekday, dayStart, dayEnd)
    const slots = computeAvailability({
      variant: { duration_min: variant.duration_min, buffer_after_min: variant.buffer_after_min },
      staff: candidates,
      shifts: ctx.shifts,
      timeOff: ctx.timeOff,
      busyItems: ctx.busyItems,
      dayStart,
      dayEnd,
      now,
    })
    const slot = slots.find((s) => s.start_at === startAt)
    // `pickStaff` is deterministic: it sorts by booked minutes then by id, and
    // `slot.staff_ids` already arrives ascending from computeAvailability. The
    // same request twice therefore yields the same technician.
    const picked = slot === undefined ? null : pickStaff(slot.staff_ids, ctx.busyItems)
    if (picked === null) {
      return c.json(errorBody('SLOT_TAKEN', 'Không có kỹ thuật viên nào rảnh cho khung giờ này'), 409)
    }
    staffId = picked
  }

  // --- 4. advisory validation, for a precise error code --------------------
  const hasSkill = await staffHasSkill(db, staffId, variant.skill_id)
  const windowCtx = await loadStaffWindowContext(db, staffId, startAt, itemBlockEndAt, weekday)
  const shiftWindows: Interval[] = windowCtx.shifts.map((s) => ({
    start: minutesToEpoch(dayStart, s.start_min),
    end: minutesToEpoch(dayStart, s.end_min),
  }))

  const problem = validateBooking({
    variant: { duration_min: variant.duration_min, buffer_after_min: variant.buffer_after_min },
    start_at: startAt,
    staff_id: staffId,
    staffHasSkill: hasSkill,
    shifts: windowCtx.shifts,
    shiftWindows,
    timeOff: windowCtx.timeOff,
    busyItems: windowCtx.busyItems,
    now,
    isWalkIn: false, // T-04 is the online path; T-08 passes true.
  })

  if (problem !== null) {
    // CONVENTIONS §5: VALIDATION is 422, the conflict codes are 409.
    const status = problem.code === 'VALIDATION' ? 422 : 409
    return c.json(errorBody(problem.code, problem.message), status)
  }

  // --- 5. the write ---------------------------------------------------------
  // Customer lookup by phone happens BEFORE the guarded insert on purpose: a
  // customer row is not a scarce resource, so a lost race here costs nothing,
  // whereas folding it into the guarded batch would make the batch depend on
  // two different `last_insert_rowid()` values.
  const existing = await findCustomerByPhone(db, phone)
  const customerId = existing !== null ? existing.id : await createCustomer(db, name, phone)

  const written = await insertBookingAtomically(db, {
    customer_id: customerId,
    staff_id: staffId,
    variant_id: variant.id,
    start_at: startAt,
    end_at: itemEndAt,
    block_end_at: itemBlockEndAt,
    source: 'online',
    status: 'booked',
    created_at: now,
  })

  if (!written.ok) {
    return c.json(errorBody('SLOT_TAKEN', 'Khung giờ này vừa có người đặt mất'), 409)
  }

  const staffRow = await db
    .prepare('SELECT id, name FROM staff WHERE id = ?')
    .bind(staffId)
    .first<{ id: number; name: string }>()

  return c.json({ appointment: written.appointment, item: written.item, staff: staffRow }, 201)
})

routes.get('/api/bookings', async (c) => {
  const rawPhone = c.req.query('phone')
  if (rawPhone === undefined || rawPhone.trim() === '') {
    return c.json(errorBody('VALIDATION', 'phone là bắt buộc'), 422)
  }

  const bookings = await listBookingsByPhone(c.env.DB, rawPhone.trim())
  return c.json({ bookings })
})

export default routes
