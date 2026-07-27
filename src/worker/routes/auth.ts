// T-19 — cổng auth admin (phương án (a): một mật khẩu chung + phiên cookie ký).
//
// Module này export HAI thứ, mount bằng ĐÚNG MỘT dòng ở routes/index.ts:
//   - `adminAuthGuard`  : middleware chặn MỌI /api/admin/* thiếu/sai phiên → 401
//   - route POST /api/auth/login, POST /api/auth/logout
//
// Guard đặt TRƯỚC các route admin trong registerRoutes → chặn ~25 endpoint admin
// tại một chỗ, không sửa từng route. Webhook payment & route khách KHÔNG khớp
// tiền tố /api/admin/* nên KHÔNG bao giờ đi qua guard này (card: giữ public).
//
// Logic thuần kiểm/ký phiên ở src/worker/lib/auth.ts — route chỉ đọc c.env,
// đọc/ghi cookie, và trả lỗi hình dạng { error: { code, message } } (§5).

import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { MiddlewareHandler } from 'hono'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  checkPassword,
  issueSessionToken,
  verifySessionToken,
} from '../lib/auth.ts'

type Bindings = {
  ADMIN_PASSWORD?: string
  SESSION_SECRET?: string
}

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Middleware chặn mọi /api/admin/*. Thiếu cookie phiên, chữ ký sai, hoặc hết
 * hạn → 401 UNAUTHORIZED với thông điệp tiếng Việt tự nhiên (không lộ vì sao).
 * Mount TRƯỚC các route admin bằng `app.use('/api/admin/*', adminAuthGuard)`.
 */
export const adminAuthGuard: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  const ok = await verifySessionToken(token, c.env.SESSION_SECRET, nowSeconds())
  if (!ok) {
    return c.json(errorBody('UNAUTHORIZED', 'Bạn cần đăng nhập để vào khu quản lý.'), 401)
  }
  await next()
}

const routes = new Hono<{ Bindings: Bindings }>()

interface LoginBody {
  password?: unknown
}

/**
 * POST /api/auth/login — nhận { password }. Đúng → set cookie phiên httpOnly,
 * trả { ok: true }. Sai → 401 UNAUTHORIZED. Không phân biệt "sai mật khẩu" với
 * "chưa cấu hình secret" ra ngoài (fail-closed, không rò rỉ).
 */
routes.post('/api/auth/login', async (c) => {
  let payload: LoginBody
  try {
    payload = (await c.req.json()) as LoginBody
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  if (!checkPassword(payload.password, c.env.ADMIN_PASSWORD)) {
    return c.json(errorBody('UNAUTHORIZED', 'Mật khẩu không đúng.'), 401)
  }

  const secret = c.env.SESSION_SECRET
  if (typeof secret !== 'string' || secret === '') {
    // Mật khẩu đúng nhưng thiếu SESSION_SECRET → không thể ký phiên. Đây là lỗi
    // cấu hình phía server, không phải lỗi người dùng — trả 500 chung, không lộ.
    return c.json(errorBody('UNAUTHORIZED', 'Chưa cấu hình phiên đăng nhập trên máy chủ.'), 500)
  }

  const now = nowSeconds()
  const token = await issueSessionToken(secret, now, SESSION_TTL_SECONDS)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
  return c.json({ ok: true })
})

/** POST /api/auth/logout — xoá cookie phiên. Idempotent, luôn { ok: true }. */
routes.post('/api/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

/**
 * GET /api/auth/session — SPA guard hỏi "phiên còn hợp lệ không?" để quyết định
 * cho vào /admin hay đẩy về /login. Trả { authenticated: boolean }, luôn 200
 * (không phải lỗi khi chưa đăng nhập — là câu trả lời hợp lệ).
 */
routes.get('/api/auth/session', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  const ok = await verifySessionToken(token, c.env.SESSION_SECRET, nowSeconds())
  return c.json({ authenticated: ok })
})

export default routes
