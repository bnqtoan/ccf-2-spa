// R5 (occupancy grid + KPI strip) + R2 (revenue / commission payroll).
// The measurement layer the audit flagged as entirely absent — before this
// file, `grep -R "SUM(" src/worker` was empty.
//
// TWO endpoints, both read-only aggregates:
//
//   GET /api/admin/overview?date=YYYY-MM-DD
//     One day's management dashboard:
//       - KPI strip: revenue (status='done' only), #done bookings,
//         occupancy % (booked ÷ available shift minutes), no-show count.
//       - Occupancy grid: every active staff × hour-slot, busy/free, plus a
//         per-staff day summary (revenue, done count, occupancy, leave flag).
//
//   GET /api/admin/staff-earnings?staff_id=&period=day|week|month&date=
//     One staff's revenue + commission payroll for a period. Clicking a staff
//     in the grid drills here.
//
// DECISION MAP (every number supports a named decision — playbook rule):
//   revenue      → pricing / daily target
//   #done        → volume context for revenue
//   occupancy %  → hiring / shift-balancing
//   no-show      → deposit policy
//   payroll      → what to pay each staff (R2)
//
// OCCUPANCY DENOMINATOR — the one number that could silently mislead:
//   occupancy % = booked_minutes / available_minutes, where
//   available_minutes = shift_minutes − time_off_minutes. Leave is REMOVED
//   from the denominator: an hour a staff is on approved leave is not capacity
//   they "failed to fill", so counting it would understate everyone who takes
//   leave and make the owner mis-hire. A staff with zero available minutes
//   (fully on leave / no shift that weekday) reports occupancy = null and a
//   `on_leave` / `no_shift` flag, so the UI shows "Nghỉ"/"—" instead of a
//   misleading 0% or 100%.
//
// NO N+1: revenue+count is ONE GROUP BY query; occupancy uses the same three
// day-queries admin-schedule already validated (staff / items / time_off) with
// a fixed param count (JOIN staff active, never IN (?,?,…) — D1's 100-param
// cap, see admin-schedule.ts). Shifts are one query for the weekday.

import { Hono } from 'hono'
import {
  localDayBounds,
  minutesToEpoch,
  parseDateStr,
  weekdayOf,
  localParts,
  localToEpoch,
} from '../lib/time.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

// Revenue counts ONLY completed service. A booking that was cancelled or that
// the customer no-showed never produced money — including either would inflate
// the owner's revenue and mislead a pricing decision.
const REVENUE_STATUS = 'done'

interface StaffRow {
  id: number
  name: string
  commission_rate: number
}

interface RevenueRow {
  staff_id: number
  revenue: number
  done_count: number
}

interface BusyRow {
  staff_id: number
  start_at: number
  end_at: number
  status: string
}

interface ShiftRow {
  staff_id: number
  start_min: number
  end_min: number
}

interface TimeOffRow {
  staff_id: number
  start_at: number
  end_at: number
}

/** Overlap of two half-open [a,b) intervals in whole minutes (never negative). */
function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const lo = Math.max(aStart, bStart)
  const hi = Math.min(aEnd, bEnd)
  return hi > lo ? Math.round((hi - lo) / 60) : 0
}

// ---------------------------------------------------------------------------
// GET /api/admin/overview?date=YYYY-MM-DD
// ---------------------------------------------------------------------------
routes.get('/api/admin/overview', async (c) => {
  const db = c.env.DB
  const dateStr = c.req.query('date')

  if (dateStr === undefined || dateStr.trim() === '') {
    return c.json(errorBody('VALIDATION', 'date là bắt buộc (YYYY-MM-DD)'), 422)
  }
  if (parseDateStr(dateStr) === null) {
    return c.json(errorBody('VALIDATION', 'date sai định dạng, cần YYYY-MM-DD'), 422)
  }

  const { start: dayStart, end: dayEnd } = localDayBounds(dateStr)
  const weekday = weekdayOf(dateStr)

  // Query 1: active staff (+ their commission rate for the drill-down link).
  const staffRes = await db
    .prepare('SELECT id, name, commission_rate FROM staff WHERE active = 1 ORDER BY id')
    .all<StaffRow>()
  const staffList = staffRes.results

  if (staffList.length === 0) {
    return c.json({
      date: dateStr,
      kpi: { revenue: 0, done_count: 0, occupancy_pct: null, no_show_count: 0 },
      staff: [],
    })
  }

  // Fixed param count regardless of staff size (JOIN staff active) — D1 caps a
  // statement at 100 bound params (admin-schedule.ts trap).
  const [revenueRes, doneOverallRes, noShowRes, busyRes, shiftRes, timeOffRes] = await Promise.all([
    // Query 2: revenue + done-count per staff, ONLY status='done'. One GROUP BY,
    // not one query per staff.
    db
      .prepare(
        `SELECT bi.staff_id AS staff_id,
                COALESCE(SUM(sv.price), 0) AS revenue,
                COUNT(*) AS done_count
         FROM booking_items bi
         JOIN service_variants sv ON sv.id = bi.variant_id
         JOIN staff st ON st.id = bi.staff_id AND st.active = 1
         WHERE bi.status = ?
           AND bi.start_at >= ? AND bi.start_at < ?
         GROUP BY bi.staff_id`,
      )
      .bind(REVENUE_STATUS, dayStart, dayEnd)
      .all<RevenueRow>(),
    // Query 3: shop-wide totals for the KPI strip (revenue, done count). Kept
    // separate from the per-staff GROUP BY so a staff with 0 done rows (absent
    // from Query 2) never drops shop revenue.
    db
      .prepare(
        `SELECT COALESCE(SUM(sv.price), 0) AS revenue, COUNT(*) AS done_count
         FROM booking_items bi
         JOIN service_variants sv ON sv.id = bi.variant_id
         JOIN staff st ON st.id = bi.staff_id AND st.active = 1
         WHERE bi.status = ? AND bi.start_at >= ? AND bi.start_at < ?`,
      )
      .bind(REVENUE_STATUS, dayStart, dayEnd)
      .first<{ revenue: number; done_count: number }>(),
    // Query 4: no-show count (deposit-policy KPI).
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM booking_items bi
         JOIN staff st ON st.id = bi.staff_id AND st.active = 1
         WHERE bi.status = 'no_show' AND bi.start_at >= ? AND bi.start_at < ?`,
      )
      .bind(dayStart, dayEnd)
      .first<{ n: number }>(),
    // Query 5: busy intervals (booked_minutes numerator). Live/completed
    // statuses occupy the chair; cancelled never did. Half-open day intersection
    // by block_end_at (buffer past midnight still occupies), same shape as
    // admin-schedule.ts.
    db
      .prepare(
        `SELECT bi.staff_id AS staff_id, bi.start_at AS start_at,
                bi.block_end_at AS end_at, bi.status AS status
         FROM booking_items bi
         JOIN staff st ON st.id = bi.staff_id AND st.active = 1
         WHERE bi.status IN ('booked','in_service','done','no_show')
           AND bi.start_at < ? AND bi.block_end_at > ?`,
      )
      .bind(dayEnd, dayStart)
      .all<BusyRow>(),
    // Query 6: shifts for this weekday (occupancy denominator, before leave).
    db
      .prepare(
        `SELECT ws.staff_id AS staff_id, ws.start_min AS start_min, ws.end_min AS end_min
         FROM work_shifts ws
         JOIN staff st ON st.id = ws.staff_id AND st.active = 1
         WHERE ws.weekday = ?`,
      )
      .bind(weekday)
      .all<ShiftRow>(),
    // Query 7: time_off for the day (removed from the denominator).
    db
      .prepare(
        `SELECT t.staff_id AS staff_id, t.start_at AS start_at, t.end_at AS end_at
         FROM time_off t
         JOIN staff st ON st.id = t.staff_id AND st.active = 1
         WHERE t.start_at < ? AND t.end_at > ?`,
      )
      .bind(dayEnd, dayStart)
      .all<TimeOffRow>(),
  ])

  const revenueByStaff = new Map<number, RevenueRow>()
  for (const r of revenueRes.results) revenueByStaff.set(r.staff_id, r)

  const busyByStaff = new Map<number, BusyRow[]>()
  for (const r of busyRes.results) {
    const list = busyByStaff.get(r.staff_id)
    if (list === undefined) busyByStaff.set(r.staff_id, [r])
    else list.push(r)
  }

  const shiftByStaff = new Map<number, ShiftRow[]>()
  for (const r of shiftRes.results) {
    const list = shiftByStaff.get(r.staff_id)
    if (list === undefined) shiftByStaff.set(r.staff_id, [r])
    else list.push(r)
  }

  const timeOffByStaff = new Map<number, TimeOffRow[]>()
  for (const r of timeOffRes.results) {
    const list = timeOffByStaff.get(r.staff_id)
    if (list === undefined) timeOffByStaff.set(r.staff_id, [r])
    else list.push(r)
  }

  // Per-staff occupancy + summary. Accumulate shop-wide occupancy numerator /
  // denominator across staff for the KPI strip.
  let shopBusyMin = 0
  let shopAvailMin = 0

  const staff = staffList.map((s) => {
    const shifts = shiftByStaff.get(s.id) ?? []
    const offs = timeOffByStaff.get(s.id) ?? []
    const busy = busyByStaff.get(s.id) ?? []

    // available_minutes = Σ shift minutes − Σ (shift ∩ leave) minutes.
    let availMin = 0
    let shiftMin = 0
    for (const sh of shifts) {
      const shStart = minutesToEpoch(dayStart, sh.start_min)
      const shEnd = minutesToEpoch(dayStart, sh.end_min)
      shiftMin += Math.round((shEnd - shStart) / 60)
      let leaveInShift = 0
      for (const off of offs) leaveInShift += overlapMinutes(shStart, shEnd, off.start_at, off.end_at)
      availMin += Math.max(0, Math.round((shEnd - shStart) / 60) - leaveInShift)
    }

    // booked_minutes = Σ (busy ∩ shift) — a booking outside the shift window
    // (rare, e.g. walk-in accepted late) does not count against a denominator
    // it isn't part of. If there is no shift, booked minutes stay 0 (n/a).
    let busyMin = 0
    for (const b of busy) {
      for (const sh of shifts) {
        const shStart = minutesToEpoch(dayStart, sh.start_min)
        const shEnd = minutesToEpoch(dayStart, sh.end_min)
        busyMin += overlapMinutes(b.start_at, b.end_at, shStart, shEnd)
      }
    }
    if (busyMin > availMin) busyMin = availMin // clamp (overlapping bookings)

    const hasShift = shifts.length > 0
    const onLeave = availMin === 0 && shiftMin > 0 // scheduled, but leave ate it all
    const occupancyPct = availMin > 0 ? Math.round((busyMin / availMin) * 100) : null

    shopBusyMin += busyMin
    shopAvailMin += availMin

    const rev = revenueByStaff.get(s.id)
    return {
      id: s.id,
      name: s.name,
      commission_rate: s.commission_rate,
      revenue: rev?.revenue ?? 0,
      done_count: rev?.done_count ?? 0,
      occupancy_pct: occupancyPct,
      available_min: availMin,
      busy_min: busyMin,
      has_shift: hasShift,
      on_leave: onLeave,
      // Busy intervals for the grid (epoch), so the SPA paints green/gray cells.
      busy_intervals: busy.map((b) => ({ start_at: b.start_at, end_at: b.end_at })),
    }
  })

  const kpi = {
    revenue: doneOverallRes?.revenue ?? 0,
    done_count: doneOverallRes?.done_count ?? 0,
    occupancy_pct: shopAvailMin > 0 ? Math.round((shopBusyMin / shopAvailMin) * 100) : null,
    no_show_count: noShowRes?.n ?? 0,
  }

  return c.json({ date: dateStr, kpi, staff })
})

// ---------------------------------------------------------------------------
// GET /api/admin/staff-earnings?staff_id=&period=day|week|month&date=
// ---------------------------------------------------------------------------
type Period = 'day' | 'week' | 'month'

/** [start, end) epoch bounds of the period CONTAINING dateStr, in spa-local time. */
function periodBounds(dateStr: string, period: Period): { start: number; end: number } {
  const day = localDayBounds(dateStr)
  if (period === 'day') return day
  if (period === 'week') {
    // Week = Monday..Sunday containing the date. weekdayOf: 0=Sun..6=Sat.
    const wd = weekdayOf(dateStr)
    const backToMonday = wd === 0 ? 6 : wd - 1
    // Anchor both bounds to a LOCAL midnight recomputed via the calendar (adding
    // 86400s is DST-unsafe; VN has no DST but the helpers stay portable). Noon
    // offsets keep us safely inside the intended day before snapping to 00:00.
    const startParts = localParts(day.start - backToMonday * 86400 + 12 * 3600)
    const start = localToEpoch(startParts.year, startParts.month, startParts.day, 0, 0, 0)
    const endParts = localParts(start + 7 * 86400 + 12 * 3600)
    const end = localToEpoch(endParts.year, endParts.month, endParts.day, 0, 0, 0)
    return { start, end }
  }
  // month: 1st of month .. 1st of next month, local.
  const p = localParts(day.start + 12 * 3600)
  const start = localToEpoch(p.year, p.month, 1, 0, 0, 0)
  const nextMonth = p.month === 12 ? 1 : p.month + 1
  const nextYear = p.month === 12 ? p.year + 1 : p.year
  const end = localToEpoch(nextYear, nextMonth, 1, 0, 0, 0)
  return { start, end }
}

routes.get('/api/admin/staff-earnings', async (c) => {
  const db = c.env.DB
  const staffIdStr = c.req.query('staff_id')
  const dateStr = c.req.query('date')
  const periodStr = (c.req.query('period') ?? 'day') as Period

  if (staffIdStr === undefined || !/^\d+$/.test(staffIdStr)) {
    return c.json(errorBody('VALIDATION', 'staff_id là bắt buộc (số nguyên)'), 422)
  }
  if (dateStr === undefined || parseDateStr(dateStr) === null) {
    return c.json(errorBody('VALIDATION', 'date sai định dạng, cần YYYY-MM-DD'), 422)
  }
  if (periodStr !== 'day' && periodStr !== 'week' && periodStr !== 'month') {
    return c.json(errorBody('VALIDATION', 'period phải là day, week hoặc month'), 422)
  }
  const staffId = Number(staffIdStr)

  const staff = await db
    .prepare('SELECT id, name, commission_rate FROM staff WHERE id = ?')
    .bind(staffId)
    .first<StaffRow>()
  if (staff === null) {
    return c.json(errorBody('NOT_FOUND', 'Không tìm thấy kỹ thuật viên'), 404)
  }

  const { start, end } = periodBounds(dateStr, periodStr)

  const agg = await db
    .prepare(
      `SELECT COALESCE(SUM(sv.price), 0) AS revenue, COUNT(*) AS done_count
       FROM booking_items bi
       JOIN service_variants sv ON sv.id = bi.variant_id
       WHERE bi.staff_id = ? AND bi.status = ?
         AND bi.start_at >= ? AND bi.start_at < ?`,
    )
    .bind(staffId, REVENUE_STATUS, start, end)
    .first<{ revenue: number; done_count: number }>()

  const revenue = agg?.revenue ?? 0
  const doneCount = agg?.done_count ?? 0
  // Payroll = revenue × commission_rate. Rounded to whole VND.
  const payroll = Math.round(revenue * staff.commission_rate)

  return c.json({
    staff_id: staff.id,
    name: staff.name,
    period: periodStr,
    period_start: start,
    period_end: end,
    revenue,
    done_count: doneCount,
    commission_rate: staff.commission_rate,
    payroll,
  })
})

export default routes
