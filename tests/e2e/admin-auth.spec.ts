// T-19 E2E — guard SPA cho khu /admin/*. Tự chứa: mỗi test tự đăng nhập/đăng
// xuất, không phụ thuộc storageState chung.
//
// T-23 — ADMIN_PASSWORD (env) đã BỎ HẲN. Mật khẩu seed owner là hằng số CỐ ĐỊNH
// 'admin123' (src/worker/db/seed.ts DEFAULT_PW) + must_change_password=1: RequireAuth
// chặn CỨNG mọi trang admin (kể cả /admin/timeline) cho tới khi đổi. Test "đăng
// nhập đúng" dưới đây vì vậy phải tự đi qua màn đổi mật khẩu nếu bị đẩy tới đó —
// đây chính là hành vi ĐÚNG cần kiểm (không phải noise cần né).
//
// D1 local dùng CHUNG cho cả suite (owner là MỘT dòng duy nhất) — dùng
// _authHelpers để chịu được việc mật khẩu owner có thể đã bị spec khác đổi
// trước đó (xem comment trong _authHelpers.ts).
//
// Không đụng hàng chờ reassign (không tạo time_off/booking) → an toàn chạy song
// song, không cần vào project chromium-shared-queue.

import { test, expect } from '@playwright/test'
import { OWNER_USERNAME, OWNER_DEFAULT_PASSWORD, loginOwnerPastMustChange } from './_authHelpers'

test.describe('T-19 guard đăng nhập khu quản lý', () => {
  test('chưa đăng nhập, mở /admin/timeline → bị đẩy về /login', async ({ page }) => {
    await page.goto('/admin/timeline')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByTestId('login-form')).toBeVisible()
  })

  test('chưa đăng nhập, mở /admin/overview (bảng tiền) → về /login', async ({ page }) => {
    await page.goto('/admin/overview')
    await expect(page).toHaveURL(/\/login/)
  })

  test('mật khẩu sai → hiện lỗi, KHÔNG vào được admin', async ({ page }) => {
    await page.goto('/login')
    await page.getByTestId('login-username').fill(OWNER_USERNAME)
    await page.getByTestId('login-password').fill('sai-mat-khau')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-error')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('đăng nhập đúng → vào được /admin/timeline (qua màn đổi mật khẩu nếu còn mặc định); logout → lại bị chặn', async ({
    page,
    request,
  }) => {
    // Đảm bảo owner đã qua must-change-password TRƯỚC (dùng API, tự chứa, không
    // phụ thuộc test/project khác) — bài test này kiểm GUARD, không phải kiểm
    // luồng đổi mật khẩu (đã có test riêng ở tests/api/auth.test.ts).
    const password = await loginOwnerPastMustChange(request)
    await page.request.post('/api/auth/logout') // context của page chưa có cookie owner; xoá cho chắc

    // Vào thẳng trang bảo vệ → về login kèm ?next=
    await page.goto('/admin/timeline')
    await expect(page).toHaveURL(/\/login\?next=/)

    await page.getByTestId('login-username').fill(OWNER_USERNAME)
    await page.getByTestId('login-password').fill(password)
    await page.getByTestId('login-submit').click()

    // owner đã qua must-change-password ở bước trên → vào thẳng /admin/timeline.
    await expect(page).toHaveURL(/\/admin\/timeline/)
    await expect(page.getByTestId('login-form')).toHaveCount(0)

    // Logout qua API rồi thử lại → guard chặn về login.
    await page.request.post('/api/auth/logout')
    await page.goto('/admin/timeline')
    await expect(page).toHaveURL(/\/login/)
  })

  test('owner MỚI seed (chưa đổi mật khẩu) đăng nhập → bị đẩy tới màn đổi mật khẩu, KHÔNG vào được admin', async ({
    page,
  }) => {
    // Test này ĐỘC LẬP với mật khẩu owner hiện tại (có thể đã bị test khác đổi
    // rồi) — nó khẳng định HÀNH VI của guard khi must_change_password=1, không
    // khẳng định trạng thái mật khẩu owner tại thời điểm chạy. Nếu owner đã đổi
    // mật khẩu (test khác chạy trước), OWNER_DEFAULT_PASSWORD sẽ sai → login lỗi
    // thay vì vào được — bỏ qua an toàn bằng cách tự kiểm tra qua API trước.
    const check = await page.request.post('/api/auth/login', {
      data: { username: OWNER_USERNAME, password: OWNER_DEFAULT_PASSWORD },
    })
    if (check.status() !== 200) {
      test.skip(true, 'owner đã bị spec khác đổi mật khẩu mặc định trước khi test này chạy')
      return
    }
    await page.request.post('/api/auth/logout')

    await page.goto('/login')
    await page.getByTestId('login-username').fill(OWNER_USERNAME)
    await page.getByTestId('login-password').fill(OWNER_DEFAULT_PASSWORD)
    await page.getByTestId('login-submit').click()

    await expect(page).toHaveURL(/\/admin\/change-password/)
    await expect(page.getByTestId('change-password-form')).toBeVisible()
    // Guard chặn cứng: cố điều hướng thẳng tới trang admin khác vẫn bị đẩy về đây.
    await page.goto('/admin/timeline')
    await expect(page).toHaveURL(/\/admin\/change-password/)
  })
})
