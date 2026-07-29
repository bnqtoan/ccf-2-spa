// POST /api/admin/bookings — reception creates a FUTURE booking directly from
// the timeline (T-29, G1/G2: click an empty cell → prefilled sheet → book).
//
// This is the third door into the SAME write path T-04 (online) and T-08
// (walk-in) already use — never a fourth copy of the scheduling rules
// (card's explicit warning). What makes this route distinct from both:
//
//   - vs. T-08 walk-in: the receptionist picks a FUTURE time/technician (not
//     `serverNow()`), so `start_at` comes from the request body and IS held to
//     the 15-minute grid (`isWalkIn` stays false/omitted). Initial status is
//     `booked` (not `in_service`) — the customer has not arrived yet.
//   - vs. T-04 online: `source='admin'` (not `'online'`) so the timeline/
//     reporting can tell "receptionist booked this for a caller" apart from
//     "customer self-served on the public site" — `insertBookingAtomically`
//     already typed `source: 'online' | 'walk_in' | 'admin'` for this reason,
//     it was simply unused until now.
//
// RBAC: gated at the ROUTE (registerRoutes, `requireRoleMw('owner',
// 'receptionist')` on `/api/admin/bookings`) — not by hiding the UI button.
// T-28's lesson: a technician who calls the endpoint directly must still get
// 403, because RBAC-by-hidden-button is not RBAC.

import { Hono } from 'hono'
import {
  createCustomer,
  findCustomerByPhone,
  insertBookingAtomically,
  loadStaffWindowContext,
  loadVariantWithSkill,
  staffHasSkill,
} from '../db/bookings.ts'
import type { Interval } from '../lib/intervals.ts'
import { localDayBounds, localParts, minutesToEpoch } from '../lib/time.ts'
import { blockEndAt, endAt, validateBooking } from '../lib/validate-booking.ts'
import { serverNow } from '../lib/clock.ts'
import { bookingMessage, sendTelegram, type NotifyEnv } from '../lib/notify.ts'

type Bindings = { DB: D1Database } & NotifyEnv

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

/** `YYYY-MM-DD` of an epoch, in SPA_TZ — same helper shape as bookings.ts / admin-walkin.ts. */
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

interface AdminBookingPayload {
  name?: unknown
  phone?: unknown
  variant_id?: unknown
  start_at?: unknown
  staff_id?: unknown
}

routes.post('/api/admin/bookings', async (c) => {
  const db = c.env.DB

  let payload: AdminBookingPayload
  try {
    payload = (await c.req.json()) as AdminBookingPayload
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  // --- shape validation -----------------------------------------------------
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (name === '') {
    return c.json(errorBody('VALIDATION', 'name là bắt buộc'), 422)
  }

  const rawPhone = payload.phone
  const phone = typeof rawPhone === 'string' && rawPhone.trim() !== '' ? rawPhone.trim() : null

  const variantId = Number(payload.variant_id)
  if (!Number.isInteger(variantId) || variantId <= 0) {
    return c.json(errorBody('VALIDATION', 'variant_id phải là số nguyên dương'), 422)
  }

  const startAt = Number(payload.start_at)
  if (!Number.isInteger(startAt) || startAt <= 0) {
    return c.json(errorBody('VALIDATION', 'start_at phải là epoch giây (số nguyên dương)'), 422)
  }

  const staffId = Number(payload.staff_id)
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
  }

  // --- variant + required skill ----------------------------------------------
  const variant = await loadVariantWithSkill(db, variantId)
  if (variant === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy service variant ${variantId}`), 404)
  }

  const now = serverNow(c)
  const dateStr = localDateStr(startAt)
  const { start: dayStart } = localDayBounds(dateStr)
  const weekday = localWeekday(startAt)

  const itemEndAt = endAt(startAt, variant)
  const itemBlockEndAt = blockEndAt(startAt, variant)

  // --- advisory validation, for a precise error code --------------------------
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
    // This is a reception booking for a FUTURE moment the customer chose, NOT
    // a walk-in — the 15-minute grid and "not in the past" rules both apply.
    isWalkIn: false,
  })

  if (problem !== null) {
    const status = problem.code === 'VALIDATION' ? 422 : 409
    return c.json(errorBody(problem.code, problem.message), status)
  }

  // --- customer identity -------------------------------------------------------
  let customerId: number
  if (phone !== null) {
    const existing = await findCustomerByPhone(db, phone)
    customerId = existing !== null ? existing.id : await createCustomer(db, name, phone)
  } else {
    customerId = await createCustomer(db, name, null)
  }

  // --- the write: same atomic guard as online/walk-in bookings -----------------
  const written = await insertBookingAtomically(db, {
    customer_id: customerId,
    staff_id: staffId,
    variant_id: variant.id,
    start_at: startAt,
    end_at: itemEndAt,
    block_end_at: itemBlockEndAt,
    source: 'admin',
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
  const customerRow = await db
    .prepare('SELECT id, name, phone FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ id: number; name: string; phone: string | null }>()

  // Same fire-and-forget notify pattern as bookings.ts / admin-walkin.ts —
  // never allowed to fail the response; the write above already succeeded.
  try {
    const p = localParts(startAt)
    c.executionCtx.waitUntil(
      sendTelegram(
        c.env,
        bookingMessage({
          customerName: customerRow?.name ?? name,
          variantName: variant.variant_name,
          time: { hour: p.hour, minute: p.minute, day: p.day, month: p.month },
          staffName: staffRow?.name ?? `#${staffId}`,
        }),
      ).catch(() => undefined),
    )
  } catch {
    // notify không bao giờ được làm hỏng response — nuốt mọi lỗi ở đây.
  }

  return c.json(
    { appointment: written.appointment, item: written.item, staff: staffRow, customer: customerRow },
    201,
  )
})

export default routes
