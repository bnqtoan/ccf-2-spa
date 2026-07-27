// T-19 — "setup project" của Playwright: đăng nhập MỘT LẦN rồi lưu storageState
// (gồm cookie phiên httpOnly) để mọi spec admin cũ có sẵn phiên mà KHÔNG phải
// sửa từng file. Bật auth mà giữ 40 spec admin xanh — đây là cách chuẩn
// Playwright, không nới/không bỏ test nào.
//
// Mật khẩu local đến từ .dev.vars (ADMIN_PASSWORD=dev-admin-password) mà
// `npm run dev` nạp. Cookie do server ký (SESSION_SECRET) — ta không tự chế.

import { test as setup, expect } from '@playwright/test'

const ADMIN_PASSWORD = 'dev-admin-password' // khớp .dev.vars local
export const ADMIN_STATE = 'tests/e2e/.auth/admin.json'

setup('đăng nhập admin và lưu phiên', async ({ page }) => {
  const res = await page.request.post('/api/auth/login', {
    data: { password: ADMIN_PASSWORD },
  })
  expect(res.status(), 'login local phải 200 (kiểm .dev.vars ADMIN_PASSWORD)').toBe(200)

  // Xác nhận phiên thật sự dùng được trước khi lưu.
  const check = await page.request.get('/api/auth/session')
  expect((await check.json()).authenticated).toBe(true)

  await page.context().storageState({ path: ADMIN_STATE })
})
