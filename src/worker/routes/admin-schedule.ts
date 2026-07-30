// GET /api/admin/schedule?date=YYYY-MM-DD — one day's board: every active
// technician, their booking_items that day, and their time_off that day
// (PRD §9, §3.4).
//
// GET /api/admin/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD — T-31 week view:
// same board, batched across a date RANGE (inclusive, max 7 days) so the
// frontend does not fire one request per day. `?date=` stays exactly as it
// was (T-29/day view depend on it) — `from`/`to` is an ADDITIONAL mode on the
// same route, not a replacement.
//
// Falls in the gap between T-06 (plain CRUD) and T-07 (time-off/reassign):
// neither owns "render a day". Reuses `localDayBounds` (T-01/lib/time.ts) for
// the local calendar boundary and the SAME interval-intersection shape T-04's
// `loadDayContext` already validated for booking_items (CONVENTIONS §2): an
// item belongs to the day when `start_at < dayEnd AND block_end_at > dayStart`
// — NOT `start_at` alone, or a booking that crosses local midnight would
// silently vanish from the morning it still occupies (card's known trap).
//
// Three queries total per mode (staff, items, time_off) — never one query per
// technician, and for the range mode never one query PER DAY either: the
// range's items/time_off queries filter by the whole `[rangeStart, rangeEnd)`
// window in one shot, then get bucketed into days in memory. The item/time_off
// queries filter by `JOIN staff … active = 1` rather than binding every id:
// D1 caps a statement at 100 bound params, so `IN (?, ?, …)` breaks a spa with
// ~98+ active technicians (reproduced: 120 staff → HTTP 500).

import { Hono } from 'hono'
import { localDayBounds, localParts, parseDateStr, weekdayOf } from '../lib/time.ts'
import type { AuthUser } from '../lib/auth.ts'

type Bindings = { DB: D1Database }
type Variables = { user: AuthUser }

const routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

interface ItemRow {
  staff_id: number
  id: number
  appointment_id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: string
  source: string
  customer_name: string
  customer_phone: string | null
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

/** Ngày kế tiếp (chuỗi "YYYY-MM-DD") theo lịch ĐỊA PHƯƠNG — dùng nội bộ để
 * liệt kê từng ngày trong range. Đi qua `localDayBounds` + nhảy 36h giống hệt
 * thủ thuật `localDayBounds` tự dùng cho `end`, để không phụ thuộc DST/UTC. */
function nextDateStr(dateStr: string): string {
  const { start } = localDayBounds(dateStr)
  const p = localParts(start + 36 * 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

const MAX_RANGE_DAYS = 7

interface DayBoard {
  date: string
  staff: {
    id: number
    name: string
    items: ReturnType<typeof mapItemRow>[]
    time_off: ReturnType<typeof mapTimeOffRow>[]
  }[]
}

function mapItemRow(row: ItemRow) {
  return {
    id: row.id,
    appointment_id: row.appointment_id,
    start_at: row.start_at,
    end_at: row.end_at,
    block_end_at: row.block_end_at,
    status: row.status,
    source: row.source,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    service_name: row.service_name,
    variant_name: row.variant_name,
  }
}

function mapTimeOffRow(row: TimeOffRow) {
  return { id: row.id, start_at: row.start_at, end_at: row.end_at, reason: row.reason }
}

/** Xác định staff_id được phép thấy — null nghĩa là mọi KTV (owner/lễ tân). */
function resolveOnlyStaffId(user: AuthUser | undefined): number | null {
  return user !== undefined && user.role === 'technician' ? (user.staffId ?? -1) : null
}

routes.get('/api/admin/schedule', async (c) => {
  const db = c.env.DB
  const dateStr = c.req.query('date')
  const fromStr = c.req.query('from')
  const toStr = c.req.query('to')
  const user = c.get('user')
  const onlyStaffId = resolveOnlyStaffId(user)

  // Chế độ RANGE (T-31 week view): cả `from` VÀ `to` cùng có mặt. Giữ nguyên
  // hành vi `?date=` (T-29/day view phụ thuộc) khi không truyền from/to.
  if (fromStr !== undefined || toStr !== undefined) {
    if (fromStr === undefined || fromStr.trim() === '' || toStr === undefined || toStr.trim() === '') {
      return c.json(errorBody('VALIDATION', 'from và to đều bắt buộc (YYYY-MM-DD)'), 422)
    }
    if (parseDateStr(fromStr) === null || parseDateStr(toStr) === null) {
      return c.json(errorBody('VALIDATION', 'from/to sai định dạng, cần YYYY-MM-DD'), 422)
    }

    const dates: string[] = []
    let cursor = fromStr
    for (let i = 0; i < MAX_RANGE_DAYS + 1; i++) {
      dates.push(cursor)
      if (cursor === toStr) break
      cursor = nextDateStr(cursor)
    }
    if (dates[dates.length - 1] !== toStr) {
      return c.json(errorBody('VALIDATION', `range tối đa ${MAX_RANGE_DAYS} ngày và to phải sau from`), 422)
    }
    if (dates.length > MAX_RANGE_DAYS) {
      return c.json(errorBody('VALIDATION', `range tối đa ${MAX_RANGE_DAYS} ngày`), 422)
    }

    const rangeStart = localDayBounds(dates[0]!).start
    const rangeEnd = localDayBounds(dates[dates.length - 1]!).end

    const staffSql =
      onlyStaffId === null
        ? 'SELECT id, name FROM staff WHERE active = 1 ORDER BY id'
        : 'SELECT id, name FROM staff WHERE active = 1 AND id = ? ORDER BY id'
    const staffStmt = onlyStaffId === null ? db.prepare(staffSql) : db.prepare(staffSql).bind(onlyStaffId)
    const staffRes = await staffStmt.all<{ id: number; name: string }>()
    const staffList = staffRes.results

    // MỘT truy vấn items + MỘT truy vấn time_off cho TOÀN BỘ range — không
    // lặp theo ngày (cạm bẫy của card: "đừng gọi 7 request tuần tự"). Bucket
    // theo ngày ở tầng ứng dụng bằng `toDateStr` cục bộ (không import lib
    // ngoài touches) dựa trên cùng `localParts`.
    const itemsByStaffByDate = new Map<number, Map<string, ItemRow[]>>()
    const timeOffByStaffByDate = new Map<number, Map<string, TimeOffRow[]>>()

    if (staffList.length > 0) {
      const itemStaffFilter = onlyStaffId === null ? '' : ' AND bi.staff_id = ?'
      const offStaffFilter = onlyStaffId === null ? '' : ' AND t.staff_id = ?'
      const itemBinds: number[] =
        onlyStaffId === null ? [rangeEnd, rangeStart] : [rangeEnd, rangeStart, onlyStaffId]
      const offBinds: number[] =
        onlyStaffId === null ? [rangeEnd, rangeStart] : [rangeEnd, rangeStart, onlyStaffId]

      const [itemsRes, timeOffRes] = await Promise.all([
        db
          .prepare(
            `SELECT bi.staff_id AS staff_id, bi.id AS id, bi.appointment_id AS appointment_id,
                    bi.start_at AS start_at, bi.end_at AS end_at, bi.block_end_at AS block_end_at,
                    bi.status AS status, a.source AS source,
                    c.name AS customer_name, c.phone AS customer_phone,
                    s.name AS service_name, sv.name AS variant_name
             FROM booking_items bi
             JOIN appointments a ON a.id = bi.appointment_id
             JOIN customers c ON c.id = a.customer_id
             JOIN service_variants sv ON sv.id = bi.variant_id
             JOIN services s ON s.id = sv.service_id
             JOIN staff st ON st.id = bi.staff_id AND st.active = 1
             WHERE bi.status IN ('booked','in_service','done','no_show')
               AND bi.start_at < ?
               AND bi.block_end_at > ?${itemStaffFilter}
             ORDER BY bi.staff_id, bi.start_at`,
          )
          .bind(...itemBinds)
          .all<ItemRow>(),
        db
          .prepare(
            `SELECT t.staff_id AS staff_id, t.id AS id, t.start_at AS start_at,
                    t.end_at AS end_at, t.reason AS reason
             FROM time_off t
             JOIN staff st ON st.id = t.staff_id AND st.active = 1
             WHERE t.start_at < ? AND t.end_at > ?${offStaffFilter}
             ORDER BY t.staff_id, t.start_at`,
          )
          .bind(...offBinds)
          .all<TimeOffRow>(),
      ])

      // Mỗi item/time_off có thể chạm nhiều hơn 1 ngày trong lưới hiển thị chỉ
      // về mặt lý thuyết (buffer vắt qua nửa đêm) — gán nó vào MỌI ngày trong
      // range mà nó giao nhau (cùng luật nửa-mở CONVENTIONS §2), giống hệt
      // cách chế độ 1-ngày đã làm cho riêng ngày đó.
      for (const row of itemsRes.results) {
        for (const d of dates) {
          const { start: dS, end: dE } = localDayBounds(d)
          if (row.start_at < dE && row.block_end_at > dS) {
            let byDate = itemsByStaffByDate.get(row.staff_id)
            if (byDate === undefined) {
              byDate = new Map()
              itemsByStaffByDate.set(row.staff_id, byDate)
            }
            const list = byDate.get(d)
            if (list === undefined) byDate.set(d, [row])
            else list.push(row)
          }
        }
      }
      for (const row of timeOffRes.results) {
        for (const d of dates) {
          const { start: dS, end: dE } = localDayBounds(d)
          if (row.start_at < dE && row.end_at > dS) {
            let byDate = timeOffByStaffByDate.get(row.staff_id)
            if (byDate === undefined) {
              byDate = new Map()
              timeOffByStaffByDate.set(row.staff_id, byDate)
            }
            const list = byDate.get(d)
            if (list === undefined) byDate.set(d, [row])
            else list.push(row)
          }
        }
      }
    }

    const days: DayBoard[] = dates.map((d) => ({
      date: d,
      staff: staffList.map((s) => ({
        id: s.id,
        name: s.name,
        items: (itemsByStaffByDate.get(s.id)?.get(d) ?? []).map(mapItemRow),
        time_off: (timeOffByStaffByDate.get(s.id)?.get(d) ?? []).map(mapTimeOffRow),
      })),
    }))

    return c.json({ from: fromStr, to: toStr, days })
  }

  if (dateStr === undefined || dateStr.trim() === '') {
    return c.json(errorBody('VALIDATION', 'date là bắt buộc (YYYY-MM-DD)'), 422)
  }
  if (parseDateStr(dateStr) === null) {
    return c.json(errorBody('VALIDATION', 'date sai định dạng, cần YYYY-MM-DD'), 422)
  }

  const { start: dayStart, end: dayEnd } = localDayBounds(dateStr)

  // Row-filter (card): technician CHỈ thấy cột của chính mình. owner/lễ tân
  // thấy MỌI KTV. Lọc bằng `AND staff_id = ?` ở CẢ ba truy vấn (staff/items/
  // time_off) — ẩn cột người khác ở server, không chỉ ở UI. technician thiếu
  // staffId (dữ liệu hỏng) → thấy rỗng (fail-closed), không thấy toàn spa.
  const staffSql =
    onlyStaffId === null
      ? 'SELECT id, name FROM staff WHERE active = 1 ORDER BY id'
      : 'SELECT id, name FROM staff WHERE active = 1 AND id = ? ORDER BY id'
  const staffStmt = onlyStaffId === null ? db.prepare(staffSql) : db.prepare(staffSql).bind(onlyStaffId)
  const staffRes = await staffStmt.all<{ id: number; name: string }>()
  const staffList = staffRes.results

  const staffIds = staffList.map((s) => s.id)
  const weekday = weekdayOf(dateStr)
  const itemsByStaff = new Map<number, ItemRow[]>()
  const timeOffByStaff = new Map<number, TimeOffRow[]>()
  // Ca làm việc của NGÀY được xem (theo weekday). Dùng để client tô mờ CỘT của
  // KTV không có ca hôm đó (không phải để lọc slot — availability engine lo việc
  // đó; đây chỉ là gợi ý trực quan "người này hôm nay không làm").
  const shiftByStaff = new Map<number, { start_min: number; end_min: number }>()

  if (staffIds.length > 0) {
    // KHÔNG bind từng staff_id qua `IN (?, ?, …)`: D1 giới hạn 100 bound
    // params/statement (không phải 999 như SQLite bản thường), nên spa có hơn
    // ~98 KTV active sẽ nhận 500 — đã tái hiện thật với 120 KTV. Lọc bằng
    // `JOIN staff ... WHERE st.active = 1`, số param cố định là 2 dù bao nhiêu
    // KTV. Cùng tập KTV với `staffList` ở trên vì cùng điều kiện `active = 1`.
    // Cùng row-filter với staffList: technician chỉ thấy item/time_off của mình.
    const itemStaffFilter = onlyStaffId === null ? '' : ' AND bi.staff_id = ?'
    const offStaffFilter = onlyStaffId === null ? '' : ' AND t.staff_id = ?'
    const shiftStaffFilter = onlyStaffId === null ? '' : ' AND ws.staff_id = ?'
    const itemBinds: number[] = onlyStaffId === null ? [dayEnd, dayStart] : [dayEnd, dayStart, onlyStaffId]
    const offBinds: number[] = onlyStaffId === null ? [dayEnd, dayStart] : [dayEnd, dayStart, onlyStaffId]
    const shiftBinds: number[] = onlyStaffId === null ? [weekday] : [weekday, onlyStaffId]

    const [itemsRes, timeOffRes, shiftRes] = await Promise.all([
      // Half-open interval intersection with the local day (CONVENTIONS §2):
      // `start_at < dayEnd AND block_end_at > dayStart`. Using `block_end_at`
      // (not `end_at`) keeps a booking that occupies the buffer past
      // midnight visible on the day it still blocks.
      // Only live/completed statuses render on the board — `cancelled` items
      // never occupied the slot in the customer-facing sense (CONVENTIONS §3).
      db
        .prepare(
          `SELECT bi.staff_id AS staff_id, bi.id AS id, bi.appointment_id AS appointment_id,
                  bi.start_at AS start_at, bi.end_at AS end_at, bi.block_end_at AS block_end_at,
                  bi.status AS status, a.source AS source,
                  c.name AS customer_name, c.phone AS customer_phone,
                  s.name AS service_name, sv.name AS variant_name
           FROM booking_items bi
           JOIN appointments a ON a.id = bi.appointment_id
           JOIN customers c ON c.id = a.customer_id
           JOIN service_variants sv ON sv.id = bi.variant_id
           JOIN services s ON s.id = sv.service_id
           JOIN staff st ON st.id = bi.staff_id AND st.active = 1
           WHERE bi.status IN ('booked','in_service','done','no_show')
             AND bi.start_at < ?
             AND bi.block_end_at > ?${itemStaffFilter}
           ORDER BY bi.staff_id, bi.start_at`,
        )
        .bind(...itemBinds)
        .all<ItemRow>(),
      db
        .prepare(
          `SELECT t.staff_id AS staff_id, t.id AS id, t.start_at AS start_at,
                  t.end_at AS end_at, t.reason AS reason
           FROM time_off t
           JOIN staff st ON st.id = t.staff_id AND st.active = 1
           WHERE t.start_at < ? AND t.end_at > ?${offStaffFilter}
           ORDER BY t.staff_id, t.start_at`,
        )
        .bind(...offBinds)
        .all<TimeOffRow>(),
      // Ca của weekday này. Fixed 2 param (+1 nếu technician) qua JOIN active
      // staff — cùng lý do chống giới hạn 100-param của D1 như hai truy vấn trên.
      db
        .prepare(
          `SELECT ws.staff_id AS staff_id, ws.start_min AS start_min, ws.end_min AS end_min
           FROM work_shifts ws
           JOIN staff st ON st.id = ws.staff_id AND st.active = 1
           WHERE ws.weekday = ?${shiftStaffFilter}
           ORDER BY ws.staff_id`,
        )
        .bind(...shiftBinds)
        .all<{ staff_id: number; start_min: number; end_min: number }>(),
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
    // Một KTV có thể có nhiều dòng ca cùng weekday (hiếm); lấy bao ngoài
    // [min(start), max(end)] để "có ca hôm nay" là một khoảng liền.
    for (const row of shiftRes.results) {
      const cur = shiftByStaff.get(row.staff_id)
      if (cur === undefined) {
        shiftByStaff.set(row.staff_id, { start_min: row.start_min, end_min: row.end_min })
      } else {
        cur.start_min = Math.min(cur.start_min, row.start_min)
        cur.end_min = Math.max(cur.end_min, row.end_min)
      }
    }
  }

  const staff = staffList.map((s) => ({
    id: s.id,
    name: s.name,
    items: (itemsByStaff.get(s.id) ?? []).map(mapItemRow),
    time_off: (timeOffByStaff.get(s.id) ?? []).map(mapTimeOffRow),
    // null = KTV KHÔNG có ca ngày này → client tô mờ cột.
    shift: shiftByStaff.get(s.id) ?? null,
  }))

  return c.json({ date: dateStr, staff })
})

export default routes
