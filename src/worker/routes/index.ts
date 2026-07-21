import type { Hono } from 'hono'

/**
 * Điểm gom route duy nhất (CONVENTIONS §7).
 * T-01 tạo khung + mount /api/health.
 * Các task sau CHỈ thêm một dòng vào hàm này — không sửa theo cách khác,
 * để nhiều agent chạy song song không giẫm chân nhau khi merge.
 */
export function registerRoutes(app: Hono) {
  app.get('/api/health', (c) => c.json({ ok: true }))
  // các task sau thêm dòng của mình vào đây
}
