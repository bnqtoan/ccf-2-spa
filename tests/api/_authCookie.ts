// T-19 — helper dùng chung cho test API admin. Guard mount global chặn mọi
// /api/admin/* thiếu phiên → mọi test chạm route admin phải gắn cookie phiên
// hợp lệ. Cookie ký bằng CHÍNH lib thuần (issueSessionToken) với SESSION_SECRET
// test (khớp vitest.config.ts miniflare.bindings).
//
// CHỦ Ý: mỗi test admin HIỆN RÕ nó cần phiên (thêm header cookie ở helper get/
// post cục bộ). Nếu guard auth vô tình bị gỡ, case "không cookie → 401" trong
// tests/api/auth.test.ts sẽ đỏ — đây mới là bằng chứng guard thật, không phải
// "cookie luôn được cấp".

import { issueSessionToken, SESSION_COOKIE } from '../../src/worker/lib/auth.ts'

const SECRET = 'test-session-secret' // khớp vitest.config.ts miniflare.bindings

/** Header Cookie mang phiên admin hợp lệ, dùng cho fetch tới /api/admin/*. */
export async function adminCookieHeader(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const token = await issueSessionToken(SECRET, now)
  return `${SESSION_COOKIE}=${token}`
}
