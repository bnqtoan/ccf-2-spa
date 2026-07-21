import type { Hono } from 'hono'
import adminCrud from './admin-crud'
import adminWalkin from './admin-walkin.ts'
import availability from './availability.ts'
import bookings from './bookings.ts'
import adminStatus from './admin-status.ts'
import cancel from './cancel.ts'
import adminTimeoff from './admin-timeoff.ts'
import adminReassign from './admin-reassign.ts'

/**
 * Điểm gom route duy nhất (CONVENTIONS §7).
 * T-01 tạo khung + mount /api/health.
 * Các task sau CHỈ thêm một dòng vào hàm này — không sửa theo cách khác,
 * để nhiều agent chạy song song không giẫm chân nhau khi merge.
 */
export function registerRoutes(app: Hono) {
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/', adminCrud)
  app.route('/', availability) // T-03
  app.route('/', bookings) // T-04
  app.route('/', cancel) // T-05
  app.route('/', adminStatus) // T-05
  app.route('/', adminWalkin) // T-08
  app.route('/', adminTimeoff) // T-07
  app.route('/', adminReassign) // T-07
  // các task sau thêm dòng của mình vào đây
}
