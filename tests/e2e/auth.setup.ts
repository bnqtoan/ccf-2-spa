// T-19 — "setup project" của Playwright: đăng nhập MỘT LẦN rồi lưu storageState
// (gồm cookie phiên httpOnly) để mọi spec admin cũ có sẵn phiên mà KHÔNG phải
// sửa từng file. Bật auth mà giữ 40 spec admin xanh — đây là cách chuẩn
// Playwright, không nới/không bỏ test nào.
//
// T-23: ADMIN_PASSWORD (env) đã BỎ HẲN. Mật khẩu seed owner giờ là hằng số CỐ
// ĐỊNH 'admin123' (src/worker/db/seed.ts DEFAULT_PW), kèm must_change_password=1
// — guard SPA (RequireAuth) chặn CỨNG mọi trang admin khi cờ này còn 1. Vì
// storageState này dùng cho 40 spec admin cũ (không phải luồng đổi mật khẩu),
// ta tự đổi mật khẩu trước khi lưu — dùng chung helper idempotent với
// admin-auth.spec.ts/rbac.spec.ts vì project này KHÔNG được đảm bảo chạy trước
// hai project đó (không có `dependencies` giữa chúng, xem playwright.config.ts).

import { test as setup, expect } from '@playwright/test'
import { OWNER_USERNAME, loginOwnerPastMustChange } from './_authHelpers'

export const ADMIN_STATE = 'tests/e2e/.auth/admin.json'

setup('đăng nhập admin (qua must-change-password nếu cần), lưu phiên', async ({ page }) => {
  const password = await loginOwnerPastMustChange(page.request)

  // loginOwnerPastMustChange để lại cookie phiên CŨ (trước đổi) trên context
  // nếu nó tự đổi mật khẩu — POST /api/auth/change-password phát cookie MỚI qua
  // Set-Cookie nên context page đã có sẵn phiên đúng. Đăng nhập lại một lần nữa
  // tường minh với mật khẩu cuối cùng để chắc chắn cookie khớp 100% (rẻ, rõ ý).
  const res = await page.request.post('/api/auth/login', { data: { username: OWNER_USERNAME, password } })
  expect(res.status(), 'login lần cuối (mật khẩu đã qua must-change) phải 200').toBe(200)

  // Xác nhận phiên thật sự dùng được (và must_change_password đã về false)
  // trước khi lưu.
  const check = await page.request.get('/api/auth/session')
  const session = (await check.json()) as { authenticated: boolean; must_change_password?: boolean }
  expect(session.authenticated).toBe(true)
  expect(session.must_change_password).toBe(false)

  await page.context().storageState({ path: ADMIN_STATE })
})
