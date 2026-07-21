// Endpoint admin cho booking_item (PRD §6, §3.3):
//   POST /api/admin/bookings/:id/status  — chuyển in_service|done|no_show
//   POST /api/admin/bookings/:id/cancel  — huỷ, MIỄN cutoff (lễ tân được tin tưởng)
//
// Cả hai đều đi qua canTransition() để giữ đúng bảng chuyển trạng thái —
// không tự chế logic riêng ở đây. no_show là dữ liệu tín nhiệm/báo cáo,
// KHÔNG phải cơ chế thu hồi slot (CONVENTIONS §3): không có logic "mở lại
// slot" nào ở transition này, vì lúc lễ tân đánh dấu thì slot đã cháy từ
// trước rồi.

import { Hono } from 'hono'
import type { AppointmentStatus } from '../db/types.ts'
import { canTransition } from '../lib/status.ts'

type Bindings = { DB: D1Database }

const routes = new Hono<{ Bindings: Bindings }>()

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

const ADMIN_SETTABLE: AppointmentStatus[] = ['in_service', 'done', 'no_show']

async function loadItem(db: D1Database, itemId: number) {
  return db.prepare('SELECT id, status FROM booking_items WHERE id = ?').bind(itemId).first<{ id: number; status: string }>()
}

function parseItemId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

routes.post('/api/admin/bookings/:id/status', async (c) => {
  const itemId = parseItemId(c.req.param('id'))
  if (itemId === null) {
    return c.json(errorBody('NOT_FOUND', 'booking_item id không hợp lệ'), 404)
  }

  let body: { status?: unknown }
  try {
    body = (await c.req.json()) as { status?: unknown }
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const targetStatus = body.status
  if (typeof targetStatus !== 'string' || !ADMIN_SETTABLE.includes(targetStatus as AppointmentStatus)) {
    return c.json(errorBody('VALIDATION', 'status phải là một trong: in_service, done, no_show'), 422)
  }

  const db = c.env.DB
  const item = await loadItem(db, itemId)
  if (item === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy booking_item ${itemId}`), 404)
  }

  if (!canTransition(item.status as AppointmentStatus, targetStatus as AppointmentStatus)) {
    return c.json(
      errorBody('INVALID_TRANSITION', `Không thể chuyển từ ${item.status} sang ${targetStatus}`),
      409,
    )
  }

  await db.prepare('UPDATE booking_items SET status = ? WHERE id = ?').bind(targetStatus, itemId).run()

  const updated = await db.prepare('SELECT * FROM booking_items WHERE id = ?').bind(itemId).first()
  return c.json({ item: updated }, 200)
})

routes.post('/api/admin/bookings/:id/cancel', async (c) => {
  const itemId = parseItemId(c.req.param('id'))
  if (itemId === null) {
    return c.json(errorBody('NOT_FOUND', 'booking_item id không hợp lệ'), 404)
  }

  const db = c.env.DB
  const item = await loadItem(db, itemId)
  if (item === null) {
    return c.json(errorBody('NOT_FOUND', `Không tìm thấy booking_item ${itemId}`), 404)
  }

  if (!canTransition(item.status as AppointmentStatus, 'cancelled')) {
    return c.json(errorBody('INVALID_TRANSITION', `Không thể huỷ booking đang ở trạng thái ${item.status}`), 409)
  }

  // Admin huỷ KHÔNG cutoff — lễ tân được tin tưởng (PRD §6). `now` chỉ dùng
  // để stamp cancelled_at, không dùng để chặn.
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare("UPDATE booking_items SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
    .bind(now, itemId)
    .run()

  const updated = await db.prepare('SELECT * FROM booking_items WHERE id = ?').bind(itemId).first()
  return c.json({ item: updated }, 200)
})

export default routes
