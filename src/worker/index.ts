import { Hono } from 'hono'
import { registerRoutes } from './routes/index'
import { withRetryingD1 } from './lib/d1-retry.ts'

const app = new Hono()

// Bọc binding D1 bằng lớp busy-retry MỘT LẦN cho mọi route (xem lib/d1-retry.ts).
// Cấp cho tầng worker cái `busy_timeout` mà D1 cấm đặt qua PRAGMA — chỉ retry lỗi
// HẠ TẦNG thoáng qua (SQLITE_BUSY / internal error), KHÔNG bao giờ lỗi nghiệp vụ
// (những lỗi đó là giá trị trả về, không throw → không chạm nhánh retry).
app.use('*', async (c, next) => {
  const env = c.env as { DB?: D1Database } | undefined
  if (env?.DB) env.DB = withRetryingD1(env.DB)
  await next()
})

registerRoutes(app)

export default app
