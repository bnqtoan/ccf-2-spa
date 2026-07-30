import type { Hono } from 'hono'
import adminCrud from './admin-crud'
import adminBookings from './admin-bookings.ts'
import adminWalkin from './admin-walkin.ts'
import availability from './availability.ts'
import bookings from './bookings.ts'
import adminStatus from './admin-status.ts'
import cancel from './cancel.ts'
import reschedule from './reschedule.ts'
import adminTimeoff from './admin-timeoff.ts'
import adminReassign from './admin-reassign.ts'
import services from './services.ts'
import adminSchedule from './admin-schedule.ts'
import adminAppointmentItems from './admin-appointment-items.ts'
import adminStaffItems from './admin-staff-items.ts'
import adminStaffShifts from './admin-staff-shifts.ts'
import combo from './combo.ts'
import adminOverview from './admin-overview.ts'
import adminUsers from './admin-users.ts'
import payments from './payments.ts'
import auth, { adminAuthGuard, requireRoleMw } from './auth.ts'

/**
 * Điểm gom route duy nhất (CONVENTIONS §7).
 * T-01 tạo khung + mount /api/health.
 * Các task sau CHỈ thêm một dòng vào hàm này — không sửa theo cách khác,
 * để nhiều agent chạy song song không giẫm chân nhau khi merge.
 */
// Mốc build THẬT — nhúng lúc `vite build` (xem vite.config.ts `define`), dạng
// `YYYY-MM-DD-<sha7>`. Phản ánh đúng commit đang chạy production nên /api/version
// là cách xác nhận auto-deploy qua Workers Builds thật sự chạy. Ở môi trường
// không qua Vite (vitest workerd pool) hằng số này không được thay → fallback.
declare const __BUILD_TAG__: string
const BUILD_TAG = typeof __BUILD_TAG__ === 'string' ? __BUILD_TAG__ : 'dev'

export function registerRoutes(app: Hono) {
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.get('/api/version', (c) => c.json({ build: BUILD_TAG }))
  app.use('/api/admin/*', adminAuthGuard) // T-19 — cổng auth chặn MỌI route admin; T-22 set c.get('user')

  // T-22 RBAC — role-gate cho các cụm owner-only. Mount SAU adminAuthGuard
  // (đã set user) và TRƯỚC route tương ứng. Mỗi middleware là ĐÚNG MỘT dòng.
  //
  // Doanh thu/lương (báo cáo tiền) — owner ONLY. Lễ tân/KTV → 403.
  app.use('/api/admin/overview', requireRoleMw('owner'))
  app.use('/api/admin/staff-earnings', requireRoleMw('owner'))
  // Quản lý user — owner ONLY.
  app.use('/api/admin/users', requireRoleMw('owner'))
  app.use('/api/admin/users/*', requireRoleMw('owner'))
  // Bảng GIÁ (services/variants/skills) — chỉ CHẶN SỬA (POST/PATCH/DELETE),
  // GIỮ GET mở để lễ tân vẫn thấy dịch vụ/giá khi nhận walk-in (card: "có giá
  // hiện khi đặt", chỉ "khoá SỬA giá"). CRUD staff/shifts = owner+lễ tân → KHÔNG gate.
  const priceMutation = ['POST', 'PATCH', 'DELETE']
  app.on(priceMutation, '/api/admin/skills', requireRoleMw('owner'))
  app.on(priceMutation, '/api/admin/skills/*', requireRoleMw('owner'))
  app.on(priceMutation, '/api/admin/services', requireRoleMw('owner'))
  app.on(priceMutation, '/api/admin/services/*', requireRoleMw('owner'))
  app.on(priceMutation, '/api/admin/variants', requireRoleMw('owner'))
  app.on(priceMutation, '/api/admin/variants/*', requireRoleMw('owner'))

  // T-28 — thêm item combo vào appointment = thao tác VẬN HÀNH: owner + lễ tân,
  // KHÔNG technician (technician chỉ dữ liệu của mình; thêm item cho appointment
  // bất kỳ là vượt quyền). T-22 bỏ sót route này → technician gọi thẳng API được
  // (đã xác nhận bằng exploit thật khi làm T-25). UI ẩn nút KHÔNG đủ — gate ở server.
  app.use('/api/admin/appointments/*', requireRoleMw('owner', 'receptionist'))

  // T-29 — tạo lịch trực tiếp trên timeline = thao tác VẬN HÀNH giống walk-in/
  // combo ở trên: owner + lễ tân, KHÔNG technician. Gate ở route (bài học
  // T-28), không chỉ ẩn nút UI.
  app.use('/api/admin/bookings', requireRoleMw('owner', 'receptionist'))

  app.route('/', auth) // T-19 — login / logout / session (public)
  app.route('/', adminCrud)
  app.route('/', availability) // T-03
  app.route('/', bookings) // T-04
  app.route('/', cancel) // T-05
  app.route('/', reschedule) // T-24 — khách tự đổi giờ (reschedule) nguyên tử
  app.route('/', adminStatus) // T-05
  app.route('/', adminWalkin) // T-08
  app.route('/', adminBookings) // T-29 — tạo lịch trên timeline (source='admin')
  app.route('/', adminTimeoff) // T-07
  app.route('/', adminReassign) // T-07
  app.route('/', services) // T-16
  app.route('/', adminSchedule) // T-16
  app.route('/', adminAppointmentItems) // T-16
  app.route('/', adminStaffItems) // TRACK-A: G0 upcoming-items guard
  app.route('/', adminStaffShifts) // T-36 — thay tuần mẫu của KTV nguyên tử
  app.route('/', combo) // R1a — serial combo (customer multi-select)
  app.route('/', adminOverview) // Track C — R5 occupancy + R2 revenue/payroll
  app.route('/', adminUsers) // T-22 — quản lý user (owner-only, gated ở trên)
  app.route('/', payments) // PAYMENT track — SePay + PayPal adapters
  // các task sau thêm dòng của mình vào đây
}
