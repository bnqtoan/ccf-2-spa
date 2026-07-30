// T-36 — thay TOÀN BỘ tuần mẫu của một KTV nguyên tử.
// PUT /api/admin/staff/:id/shifts  { shifts: [{ weekday, start_min, end_min }, ...] }
//
// Vì sao có route này (thay vì diff xoá-tạo-lại ở client bằng các endpoint có
// sẵn): diff không nguyên tử — nếu một request lỗi giữa chừng, tuần bị nửa vời
// (vài ngày mới, vài ngày cũ). Một endpoint replace-week gói DELETE + các INSERT
// trong một db.batch() → hoặc cả tuần lưu, hoặc không đổi gì. Sạch hơn, không có
// trạng thái dở dang. Card ưu tiên hướng này.
//
// KHÔNG đổi schema, KHÔNG đổi cách engine đọc work_shifts — chỉ đổi cách GHI.
import { Hono } from 'hono'
import * as crud from '../db/crud'

type Bindings = { DB: D1Database }
type Json = Record<string, unknown>

const routes = new Hono<{ Bindings: Bindings }>()

function error(
  c: { json: (value: unknown, status: 404 | 422) => Response },
  status: 404 | 422,
  code: 'NOT_FOUND' | 'VALIDATION',
  message: string,
) {
  return c.json({ error: { code, message } }, status)
}

function id(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

/** Một dòng ca hợp lệ: weekday 0..6 (0=CN..6=T7, khớp WEEKDAY_LABELS +
 * weekdayOf trong engine), phút 0..1440, start < end (khớp CHECK ở DB). */
function validRow(r: unknown): r is { weekday: number; start_min: number; end_min: number } {
  if (r === null || typeof r !== 'object') return false
  const o = r as Json
  return (
    isInt(o.weekday) &&
    o.weekday >= 0 &&
    o.weekday <= 6 &&
    isInt(o.start_min) &&
    isInt(o.end_min) &&
    o.start_min >= 0 &&
    o.end_min <= 1440 &&
    o.start_min < o.end_min
  )
}

routes.put('/api/admin/staff/:id/shifts', async (c) => {
  const staffId = id(c.req.param('id'))
  if (!staffId) return error(c, 404, 'NOT_FOUND', 'staff not found')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return error(c, 422, 'VALIDATION', 'invalid body')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return error(c, 422, 'VALIDATION', 'invalid body')
  }
  const rawShifts = (body as Json).shifts
  if (!Array.isArray(rawShifts)) return error(c, 422, 'VALIDATION', 'shifts must be an array')
  if (!rawShifts.every(validRow)) return error(c, 422, 'VALIDATION', 'invalid shift row')

  // Chặn hai dòng cùng weekday (một ngày chỉ một cửa sổ ca trong tuần mẫu —
  // split-shift không nằm trong phạm vi card này).
  const days = new Set<number>()
  for (const r of rawShifts as { weekday: number }[]) {
    if (days.has(r.weekday)) return error(c, 422, 'VALIDATION', 'duplicate weekday')
    days.add(r.weekday)
  }

  if (!(await crud.staffExists(c.env.DB, staffId))) return error(c, 404, 'NOT_FOUND', 'staff not found')

  const saved = await crud.replaceStaffWeek(
    c.env.DB,
    staffId,
    rawShifts as { weekday: number; start_min: number; end_min: number }[],
  )
  return c.json(saved)
})

export default routes
