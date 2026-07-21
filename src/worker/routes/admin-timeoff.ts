// POST   /api/admin/time-off       — record a technician's absence (PRD §8)
// DELETE /api/admin/time-off/:id    — she's coming in after all
// GET    /api/admin/reassign-queue  — items stranded by any absence
//
// THE ONE RULE THAT SHAPES THIS FILE (PRD §8): creating time-off NEVER fails
// because bookings are in the way. The technician is already sick; refusing to
// record that fact does not un-sick her, it only hides the damage. So the POST
// creates the row unconditionally and returns the wreckage in `affected_items`
// for a human to work through.
//
// And what it does NOT do is just as load-bearing: affected items keep
// `status='booked'` and keep their ORIGINAL `staff_id`. No auto-cancel, no
// auto-move. Someone has to phone each customer, and the queue exists precisely
// so that unfinished work stays visible until they have.

import { Hono } from 'hono'
import {
  deleteTimeOff,
  findAffectedItems,
  insertTimeOff,
  loadReassignQueue,
  staffExists,
} from '../db/timeoff.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

interface TimeOffPayload {
  staff_id?: unknown
  start_at?: unknown
  end_at?: unknown
  reason?: unknown
}

routes.post('/api/admin/time-off', async (c) => {
  const db = c.env.DB

  let payload: TimeOffPayload
  try {
    payload = (await c.req.json()) as TimeOffPayload
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const staffId = Number(payload.staff_id)
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
  }

  const startAt = Number(payload.start_at)
  const endAt = Number(payload.end_at)
  if (!Number.isInteger(startAt) || !Number.isInteger(endAt)) {
    return c.json(errorBody('VALIDATION', 'start_at và end_at phải là epoch giây (số nguyên)'), 422)
  }
  // A zero-width absence would sit in the DB overlapping nothing (half-open
  // intervals, CONVENTIONS §2) and quietly do nothing at all.
  if (startAt >= endAt) {
    return c.json(errorBody('VALIDATION', 'start_at phải nhỏ hơn end_at'), 422)
  }

  const reason = typeof payload.reason === 'string' && payload.reason.trim() !== '' ? payload.reason.trim() : null

  if (!(await staffExists(db, staffId))) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy kỹ thuật viên ${staffId}`), 404)
  }

  const timeOff = await insertTimeOff(db, {
    staff_id: staffId,
    start_at: startAt,
    end_at: endAt,
    reason,
  })

  // Queried AFTER the insert, but the answer would be identical before it:
  // the query reads booking_items, which the insert did not touch. Nothing is
  // cancelled or moved here — that is the point.
  const affected = await findAffectedItems(db, staffId, startAt, endAt)

  // 200, not 201: the card fixes this shape (PRD §8). The conflicts are the
  // headline, not the new row.
  return c.json({ time_off: timeOff, affected_items: affected }, 200)
})

routes.delete('/api/admin/time-off/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json(errorBody('NOT_FOUND', 'Không tìm thấy time-off'), 404)
  }

  const removed = await deleteTimeOff(c.env.DB, id)
  if (!removed) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy time-off ${id}`), 404)
  }

  // The queue needs no cleanup: it is a JOIN against `time_off`, so the items
  // this row was stranding stop matching the instant it disappears.
  return c.json({ deleted: true, id }, 200)
})

routes.get('/api/admin/reassign-queue', async (c) => {
  const items = await loadReassignQueue(c.env.DB)
  return c.json({ items })
})

export default routes
