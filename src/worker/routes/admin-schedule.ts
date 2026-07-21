// GET /api/admin/schedule?date=YYYY-MM-DD — one day's board: every active
// technician, their booking_items that day, and their time_off that day
// (PRD §9, §3.4).
//
// Falls in the gap between T-06 (plain CRUD) and T-07 (time-off/reassign):
// neither owns "render a day". Reuses `localDayBounds` (T-01/lib/time.ts) for
// the local calendar boundary and the SAME interval-intersection shape T-04's
// `loadDayContext` already validated for booking_items (CONVENTIONS §2): an
// item belongs to the day when `start_at < dayEnd AND block_end_at > dayStart`
// — NOT `start_at` alone, or a booking that crosses local midnight would
// silently vanish from the morning it still occupies (card's known trap).
//
// Three queries total (staff, items, time_off) — never one query per
// technician. The item/time_off queries filter by `JOIN staff … active = 1`
// rather than binding every id: D1 caps a statement at 100 bound params, so
// `IN (?, ?, …)` breaks a spa with ~98+ active technicians (reproduced: 120
// staff → HTTP 500).

import { Hono } from 'hono'
import { localDayBounds, parseDateStr } from '../lib/time.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

interface ItemRow {
  staff_id: number
  id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: string
  source: string
  customer_name: string
  service_name: string
  variant_name: string
}

interface TimeOffRow {
  staff_id: number
  id: number
  start_at: number
  end_at: number
  reason: string | null
}

routes.get('/api/admin/schedule', async (c) => {
  const db = c.env.DB
  const dateStr = c.req.query('date')

  if (dateStr === undefined || dateStr.trim() === '') {
    return c.json(errorBody('VALIDATION', 'date là bắt buộc (YYYY-MM-DD)'), 422)
  }
  if (parseDateStr(dateStr) === null) {
    return c.json(errorBody('VALIDATION', 'date sai định dạng, cần YYYY-MM-DD'), 422)
  }

  const { start: dayStart, end: dayEnd } = localDayBounds(dateStr)

  const staffRes = await db
    .prepare('SELECT id, name FROM staff WHERE active = 1 ORDER BY id')
    .all<{ id: number; name: string }>()
  const staffList = staffRes.results

  const staffIds = staffList.map((s) => s.id)
  const itemsByStaff = new Map<number, ItemRow[]>()
  const timeOffByStaff = new Map<number, TimeOffRow[]>()

  if (staffIds.length > 0) {
    // KHÔNG bind từng staff_id qua `IN (?, ?, …)`: D1 giới hạn 100 bound
    // params/statement (không phải 999 như SQLite bản thường), nên spa có hơn
    // ~98 KTV active sẽ nhận 500 — đã tái hiện thật với 120 KTV. Lọc bằng
    // `JOIN staff ... WHERE st.active = 1`, số param cố định là 2 dù bao nhiêu
    // KTV. Cùng tập KTV với `staffList` ở trên vì cùng điều kiện `active = 1`.
    const [itemsRes, timeOffRes] = await Promise.all([
      // Half-open interval intersection with the local day (CONVENTIONS §2):
      // `start_at < dayEnd AND block_end_at > dayStart`. Using `block_end_at`
      // (not `end_at`) keeps a booking that occupies the buffer past
      // midnight visible on the day it still blocks.
      // Only live/completed statuses render on the board — `cancelled` items
      // never occupied the slot in the customer-facing sense (CONVENTIONS §3).
      db
        .prepare(
          `SELECT bi.staff_id AS staff_id, bi.id AS id,
                  bi.start_at AS start_at, bi.end_at AS end_at, bi.block_end_at AS block_end_at,
                  bi.status AS status, a.source AS source,
                  c.name AS customer_name, s.name AS service_name, sv.name AS variant_name
           FROM booking_items bi
           JOIN appointments a ON a.id = bi.appointment_id
           JOIN customers c ON c.id = a.customer_id
           JOIN service_variants sv ON sv.id = bi.variant_id
           JOIN services s ON s.id = sv.service_id
           JOIN staff st ON st.id = bi.staff_id AND st.active = 1
           WHERE bi.status IN ('booked','in_service','done','no_show')
             AND bi.start_at < ?
             AND bi.block_end_at > ?
           ORDER BY bi.staff_id, bi.start_at`,
        )
        .bind(dayEnd, dayStart)
        .all<ItemRow>(),
      db
        .prepare(
          `SELECT t.staff_id AS staff_id, t.id AS id, t.start_at AS start_at,
                  t.end_at AS end_at, t.reason AS reason
           FROM time_off t
           JOIN staff st ON st.id = t.staff_id AND st.active = 1
           WHERE t.start_at < ? AND t.end_at > ?
           ORDER BY t.staff_id, t.start_at`,
        )
        .bind(dayEnd, dayStart)
        .all<TimeOffRow>(),
    ])

    for (const row of itemsRes.results) {
      const list = itemsByStaff.get(row.staff_id)
      if (list === undefined) itemsByStaff.set(row.staff_id, [row])
      else list.push(row)
    }
    for (const row of timeOffRes.results) {
      const list = timeOffByStaff.get(row.staff_id)
      if (list === undefined) timeOffByStaff.set(row.staff_id, [row])
      else list.push(row)
    }
  }

  const staff = staffList.map((s) => ({
    id: s.id,
    name: s.name,
    items: (itemsByStaff.get(s.id) ?? []).map((row) => ({
      id: row.id,
      start_at: row.start_at,
      end_at: row.end_at,
      block_end_at: row.block_end_at,
      status: row.status,
      source: row.source,
      customer_name: row.customer_name,
      service_name: row.service_name,
      variant_name: row.variant_name,
    })),
    time_off: (timeOffByStaff.get(s.id) ?? []).map((row) => ({
      id: row.id,
      start_at: row.start_at,
      end_at: row.end_at,
      reason: row.reason,
    })),
  }))

  return c.json({ date: dateStr, staff })
})

export default routes
