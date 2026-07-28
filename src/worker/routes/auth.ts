// T-19 → T-22 — cổng auth admin + RBAC.
//
// Module này export:
//   - `adminAuthGuard` : middleware chặn MỌI /api/admin/* thiếu/sai phiên → 401,
//     VÀ set c.get('user') = {userId, role, staffId} cho route lọc theo role.
//   - `requireRoleMw(...roles)` : middleware chặn 403 nếu role không thuộc danh
//     sách. Mount cụ thể cho cụm owner-only trong registerRoutes.
//   - route POST /api/auth/login (username+password), logout, GET session.
//
// Guard đặt TRƯỚC các route admin trong registerRoutes → chặn ~25 endpoint admin
// tại một chỗ. Webhook payment & route khách KHÔNG khớp /api/admin/* nên KHÔNG
// bao giờ đi qua guard (card: giữ public).
//
// role LẤY TỪ payload ĐÃ KÝ HMAC (readSession) — không bao giờ từ query/header
// client (card cạm bẫy #2). Logic thuần kiểm/ký/băm ở src/worker/lib/auth.ts.

import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { MiddlewareHandler } from 'hono'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  issueSessionToken,
  readSession,
  requireRole,
  verifyPassword,
  type AuthUser,
  type Role,
} from '../lib/auth.ts'

type Bindings = {
  DB: D1Database
  ADMIN_PASSWORD?: string
  SESSION_SECRET?: string
}

// Biến môi trường Hono: guard gắn `user` để route sau đọc bằng c.get('user').
type Variables = { user: AuthUser }

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Middleware chặn mọi /api/admin/*. Thiếu cookie phiên, chữ ký sai, hoặc hết
 * hạn → 401 UNAUTHORIZED. Hợp lệ → set c.get('user') = {userId, role, staffId}.
 * Mount TRƯỚC các route admin bằng `app.use('/api/admin/*', adminAuthGuard)`.
 */
export const adminAuthGuard: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (
  c,
  next,
) => {
  const token = getCookie(c, SESSION_COOKIE)
  const user = await readSession(token, c.env.SESSION_SECRET, nowSeconds())
  if (user === null) {
    return c.json(errorBody('UNAUTHORIZED', 'Bạn cần đăng nhập để vào khu quản lý.'), 401)
  }
  c.set('user', user)
  await next()
}

/**
 * requireRoleMw(...roles) — middleware role-gate cho cụm owner-only (doanh thu/
 * lương/giá/quản lý user). Chạy SAU adminAuthGuard (đã set user). role không
 * thuộc danh sách → 403 FORBIDDEN tiếng Việt tự nhiên (không lộ enum role thô).
 */
export function requireRoleMw(
  ...roles: Role[]
): MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> {
  return async (c, next) => {
    const user = c.get('user')
    if (!requireRole(user, ...roles)) {
      return c.json(errorBody('FORBIDDEN', 'Bạn không có quyền truy cập chức năng này.'), 403)
    }
    await next()
  }
}

const routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

interface LoginBody {
  username?: unknown
  password?: unknown
}

interface UserRow {
  id: number
  password_hash: string
  role: Role
  staff_id: number | null
  active: number
}

/**
 * POST /api/auth/login — nhận { username, password }. Tra bảng users, so khớp
 * hash constant-time. Đúng + user active → set cookie phiên httpOnly mang role,
 * trả { ok, role }. Sai username/mật khẩu HOẶC user inactive → 401 (không phân
 * biệt lý do ra ngoài — không rò rỉ "user tồn tại nhưng sai mật khẩu").
 */
routes.post('/api/auth/login', async (c) => {
  let payload: LoginBody
  try {
    payload = (await c.req.json()) as LoginBody
  } catch {
    return c.json(errorBody('VALIDATION', 'Body phải là JSON hợp lệ'), 422)
  }

  const username = typeof payload.username === 'string' ? payload.username.trim() : ''
  const password = typeof payload.password === 'string' ? payload.password : ''
  if (username === '' || password === '') {
    return c.json(errorBody('UNAUTHORIZED', 'Tên đăng nhập hoặc mật khẩu không đúng.'), 401)
  }

  const secret = c.env.SESSION_SECRET
  if (typeof secret !== 'string' || secret === '') {
    return c.json(errorBody('UNAUTHORIZED', 'Chưa cấu hình phiên đăng nhập trên máy chủ.'), 500)
  }

  const row = await c.env.DB.prepare(
    'SELECT id, password_hash, role, staff_id, active FROM users WHERE username = ?',
  )
    .bind(username)
    .first<UserRow>()

  // Luôn chạy verifyPassword (kể cả khi user không tồn tại, so với một hash giả)
  // để không rò rỉ "user có tồn tại không" qua thời gian phản hồi.
  const storedHash = row?.password_hash ?? 'pbkdf2$1$x$x'
  const ok = await verifyPassword(password, storedHash)
  if (row === null || row.active !== 1 || !ok) {
    return c.json(errorBody('UNAUTHORIZED', 'Tên đăng nhập hoặc mật khẩu không đúng.'), 401)
  }

  const user: AuthUser = { userId: row.id, role: row.role, staffId: row.staff_id }
  const now = nowSeconds()
  const token = await issueSessionToken(secret, now, SESSION_TTL_SECONDS, user)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
  return c.json({ ok: true, role: row.role })
})

/** POST /api/auth/logout — xoá cookie phiên. Idempotent, luôn { ok: true }. */
routes.post('/api/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

/**
 * GET /api/auth/session — SPA guard hỏi "phiên còn hợp lệ không + vai trò gì?"
 * để quyết định cho vào /admin hay đẩy về /login, VÀ lọc nav theo role. Trả
 * { authenticated, role?, staffId? }, luôn 200.
 */
routes.get('/api/auth/session', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  const user = await readSession(token, c.env.SESSION_SECRET, nowSeconds())
  if (user === null) return c.json({ authenticated: false })
  return c.json({ authenticated: true, role: user.role, staffId: user.staffId })
})

export default routes
