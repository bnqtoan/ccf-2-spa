// GET  /api/admin/bookings/:id/reassign-candidates — who could take this item
// POST /api/admin/bookings/:id/reassign             — move it to someone else
//
// This layer LOADS and FORMATS. Every scheduling decision comes from the pure
// `validateBooking` (via lib/reassign.ts), and the race-proof part lives in the
// SQL predicate inside `reassignItemAtomically` (see src/worker/db/timeoff.ts).
//
// The candidates endpoint returns EVERY other active technician, each with
// `eligible` and a `reason`, rather than only the ones who fit. An empty list
// tells a receptionist nothing; "Mai: no skill / Lan: on leave / Hoa: booked
// 10:00" tells her whom to call and what to negotiate.

import { Hono } from 'hono'
import {
  loadItemDetail,
  loadOtherActiveStaff,
  loadWindowContextForStaff,
  reassignItemAtomically,
} from '../db/timeoff.ts'
import type { Interval } from '../lib/intervals.ts'
import { findCandidates } from '../lib/reassign.ts'
import { localDayBounds, localParts, minutesToEpoch } from '../lib/time.ts'
import { blockEndAt, validateBooking } from '../lib/validate-booking.ts'

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

/** Groups per-staff shift rows into concrete epoch windows for the item's day. */
function shiftWindowsByStaff(
  shifts: { staff_id: number; start_min: number; end_min: number }[],
  dayStart: number,
): Map<number, Interval[]> {
  const map = new Map<number, Interval[]>()
  for (const s of shifts) {
    const w = { start: minutesToEpoch(dayStart, s.start_min), end: minutesToEpoch(dayStart, s.end_min) }
    const list = map.get(s.staff_id)
    if (list === undefined) map.set(s.staff_id, [w])
    else list.push(w)
  }
  return map
}

routes.get('/api/admin/bookings/:id/reassign-candidates', async (c) => {
  const db = c.env.DB
  const itemId = Number(c.req.param('id'))
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return c.json(errorBody('NOT_FOUND', 'Không tìm thấy booking item'), 404)
  }

  const item = await loadItemDetail(db, itemId)
  if (item === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy booking item ${itemId}`), 404)
  }

  const staff = await loadOtherActiveStaff(db, item.staff_id)
  const { start: dayStart } = localDayBounds(localDateStr(item.start_at))
  const weekday = localWeekday(item.start_at)

  const ctx = await loadWindowContextForStaff(
    db,
    staff.map((s) => s.id),
    weekday,
    item.start_at,
    item.block_end_at,
    item.skill_id,
    item.item_id,
  )

  const candidates = findCandidates({
    variant: { duration_min: item.duration_min, buffer_after_min: item.buffer_after_min },
    start_at: item.start_at,
    staff,
    skilled: ctx.skilled,
    shiftWindowsByStaff: shiftWindowsByStaff(ctx.shifts, dayStart),
    timeOff: ctx.timeOff,
    busyItems: ctx.busyItems,
  })

  return c.json({ item, candidates })
})

routes.post('/api/admin/bookings/:id/reassign', async (c) => {
  const db = c.env.DB
  const itemId = Number(c.req.param('id'))
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return c.json(errorBody('NOT_FOUND', 'Không tìm thấy booking item'), 404)
  }

  let payload: { staff_id?: unknown }
  try {
    payload = (await c.req.json()) as { staff_id?: unknown }
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const newStaffId = Number(payload.staff_id)
  if (!Number.isInteger(newStaffId) || newStaffId <= 0) {
    return c.json(errorBody('VALIDATION', 'staff_id phải là số nguyên dương'), 422)
  }

  const item = await loadItemDetail(db, itemId)
  if (item === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy booking item ${itemId}`), 404)
  }

  // CONVENTIONS §3: only a live item can move. A cancelled appointment does not
  // get resurrected by being handed to another technician.
  if (item.status !== 'booked' && item.status !== 'in_service') {
    return c.json(errorBody('INVALID_TRANSITION', `Không thể chuyển item ở trạng thái ${item.status}`), 409)
  }

  if (newStaffId === item.staff_id) {
    return c.json(errorBody('VALIDATION', 'Kỹ thuật viên mới trùng với kỹ thuật viên hiện tại'), 422)
  }

  const target = await db
    .prepare('SELECT id, name, active FROM staff WHERE id = ?')
    .bind(newStaffId)
    .first<{ id: number; name: string; active: number }>()
  if (target === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy kỹ thuật viên ${newStaffId}`), 404)
  }

  const { start: dayStart } = localDayBounds(localDateStr(item.start_at))
  const weekday = localWeekday(item.start_at)

  const ctx = await loadWindowContextForStaff(
    db,
    [newStaffId],
    weekday,
    item.start_at,
    item.block_end_at,
    item.skill_id,
    item.item_id,
  )

  // --- the shared rulebook ---------------------------------------------------
  // THE SAME `validateBooking` the create path runs. Not a re-implementation,
  // not a subset: reassign must be judged exactly as strictly as a brand-new
  // booking, or it becomes a side door for double-booking.
  const problem = validateBooking({
    variant: { duration_min: item.duration_min, buffer_after_min: item.buffer_after_min },
    start_at: item.start_at,
    staff_id: newStaffId,
    staffHasSkill: ctx.skilled.has(newStaffId),
    shifts: ctx.shifts,
    shiftWindows: shiftWindowsByStaff(ctx.shifts, dayStart).get(newStaffId) ?? [],
    timeOff: ctx.timeOff,
    busyItems: ctx.busyItems,
    // The item already exists at this instant — see lib/reassign.ts for why the
    // past-check must not apply to a rescue.
    now: item.start_at,
    isWalkIn: true,
  })

  if (problem !== null) {
    const status = problem.code === 'VALIDATION' ? 422 : 409
    return c.json(errorBody(problem.code, problem.message), status)
  }

  // --- the write ------------------------------------------------------------
  // Advisory above, authoritative here. Everything `validateBooking` just saw
  // may be stale: D1 cannot hold a transaction open across an `await`, so the
  // only race-proof check is the SQL predicate inside this UPDATE.
  const written = await reassignItemAtomically(db, {
    item_id: item.item_id,
    new_staff_id: newStaffId,
    start_at: item.start_at,
    block_end_at: item.block_end_at,
  })

  if (!written.ok) {
    if (written.reason === 'INVALID_TRANSITION') {
      return c.json(errorBody('INVALID_TRANSITION', 'Item không còn ở trạng thái có thể chuyển'), 409)
    }
    return c.json(errorBody('SLOT_TAKEN', 'Kỹ thuật viên này vừa bị chiếm mất khung giờ đó'), 409)
  }

  const updated = await loadItemDetail(db, item.item_id)
  return c.json({ item: updated, staff: { id: target.id, name: target.name } }, 200)
})

export default routes
