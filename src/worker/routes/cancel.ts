// POST /api/bookings/:id/cancel — khách tự huỷ lịch của mình (PRD §6).
//
// Cutoff 2h là chính sách THƯƠNG MẠI: dưới 120 phút, khách phải gọi điện để
// lễ tân có cơ hội đổi lịch thay vì mất trắng slot. Phải chặn ở đây, tại
// SERVER, bằng đồng hồ server — không đọc bất kỳ giá trị "now" nào từ
// client. Huỷ = đổi status + stamp cancelled_at, KHÔNG xoá dòng (CONVENTIONS
// §3). Slot rảnh lại ngay vì availability tính live từ booking_items — không
// cần dọn thêm gì.

import { Hono } from 'hono'
import { canCustomerCancel, canTransition } from '../lib/status.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

routes.post('/api/bookings/:id/cancel', async (c) => {
  const itemId = Number(c.req.param('id'))
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return c.json(errorBody('NOT_FOUND', 'booking_item id không hợp lệ'), 404)
  }

  const db = c.env.DB
  const item = await db
    .prepare('SELECT id, start_at, status FROM booking_items WHERE id = ?')
    .bind(itemId)
    .first<{ id: number; start_at: number; status: string }>()

  if (item === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy booking_item ${itemId}`), 404)
  }

  if (!canTransition(item.status as any, 'cancelled')) {
    return c.json(errorBody('INVALID_TRANSITION', `Không thể huỷ booking đang ở trạng thái ${item.status}`), 409)
  }

  // Thời điểm hiện tại của SERVER — không bao giờ tin client.
  const now = Math.floor(Date.now() / 1000)
  if (!canCustomerCancel(item.start_at, now)) {
    return c.json(
      errorBody('CANCEL_TOO_LATE', 'Chỉ còn dưới 2 tiếng trước giờ hẹn, vui lòng gọi điện cho spa để đổi lịch'),
      409,
    )
  }

  const cancelledAt = now
  await db
    .prepare("UPDATE booking_items SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
    .bind(cancelledAt, itemId)
    .run()

  const updated = await db.prepare('SELECT * FROM booking_items WHERE id = ?').bind(itemId).first()
  return c.json({ item: updated }, 200)
})

export default routes
