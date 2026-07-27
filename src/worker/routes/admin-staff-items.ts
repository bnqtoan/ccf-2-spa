// GET /api/admin/staff/:id/upcoming-items — the live bookings a technician
// still owns from `now` onward (status booked/in_service, block not yet past).
//
// WHY THIS EXISTS (fixes G0 — the silent side-effect). Setup → "Cho ngưng làm"
// flips staff.active = 0. Every display query filters `active = 1`
// (admin-schedule.ts, availability.ts), so deactivating a technician who still
// has upcoming bookings makes their column — and those customers — vanish from
// the board with no warning and WITHOUT entering the reassign queue (the queue
// is time_off-derived, not active-derived). The receptionist loses the
// customers silently.
//
// The product decision is BLOCK + SUGGEST: before deactivating, the UI asks
// this endpoint; if the list is non-empty it refuses and points at "Báo nghỉ"
// (time-off) instead — which is the flow that DOES surface the affected
// bookings into the queue (PRD §8). This endpoint is the read that lets the
// constraint be shown BEFORE the destructive click, not after.
//
// Read-only. No schema change: it queries the same booking_items/time_off the
// schedule already reads, just scoped to one technician and to the future.

import { Hono } from 'hono'
import { staffExists } from '../db/crud.ts'
import { serverNow } from '../lib/clock.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

interface UpcomingItemRow {
  item_id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: string
  customer_name: string
  service_name: string
  variant_name: string
}

routes.get('/api/admin/staff/:id/upcoming-items', async (c) => {
  const staffId = Number(c.req.param('id'))
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return c.json(errorBody('VALIDATION', 'staff id không hợp lệ'), 422)
  }
  if (!(await staffExists(c.env.DB, staffId))) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy kỹ thuật viên ${staffId}`), 404)
  }

  const now = serverNow(c)
  // `block_end_at > now` — an appointment whose cleanup buffer has not yet
  // finished still counts as upcoming: the technician is still needed for it.
  // Only live statuses matter; done/no_show/cancelled bookings free nothing.
  const res = await c.env.DB
    .prepare(
      `SELECT bi.id AS item_id, bi.start_at AS start_at, bi.end_at AS end_at,
              bi.block_end_at AS block_end_at, bi.status AS status,
              cu.name AS customer_name, s.name AS service_name, sv.name AS variant_name
       FROM booking_items bi
       JOIN appointments a ON a.id = bi.appointment_id
       JOIN customers cu ON cu.id = a.customer_id
       JOIN service_variants sv ON sv.id = bi.variant_id
       JOIN services s ON s.id = sv.service_id
       WHERE bi.staff_id = ?
         AND bi.status IN ('booked','in_service')
         AND bi.block_end_at > ?
       ORDER BY bi.start_at, bi.id`,
    )
    .bind(staffId, now)
    .all<UpcomingItemRow>()

  return c.json({ items: res.results })
})

export default routes
