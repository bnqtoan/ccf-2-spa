// T-19 E2E — guard SPA cho khu /admin/*. Tự chứa: mỗi test tự đăng nhập/đăng
// xuất, không phụ thuộc storageState chung. Mật khẩu local đến từ .dev.vars
// (ADMIN_PASSWORD=dev-admin-password) mà `npm run dev` nạp.
//
// Không đụng hàng chờ reassign (không tạo time_off/booking) → an toàn chạy song
// song, không cần vào project chromium-shared-queue.

import { test, expect } from '@playwright/test'

// T-22: login nay là username+password. owner = seed user gốc (role owner).
const ADMIN_USERNAME = 'owner'
const ADMIN_PASSWORD = 'dev-admin-password' // khớp .dev.vars local

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
    await page.getByTestId('login-username').fill(ADMIN_USERNAME)
    await page.getByTestId('login-password').fill('sai-mat-khau')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-error')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('đăng nhập đúng → vào được /admin/timeline; logout → lại bị chặn', async ({ page }) => {
    // Vào thẳng trang bảo vệ → về login kèm ?next=
    await page.goto('/admin/timeline')
    await expect(page).toHaveURL(/\/login\?next=/)

    await page.getByTestId('login-username').fill(ADMIN_USERNAME)
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('login-submit').click()

    // Sau login → quay lại đúng đích /admin/timeline (không còn ở /login).
    await expect(page).toHaveURL(/\/admin\/timeline/)
    await expect(page.getByTestId('login-form')).toHaveCount(0)

    // Logout qua API rồi thử lại → guard chặn về login.
    await page.request.post('/api/auth/logout')
    await page.goto('/admin/timeline')
    await expect(page).toHaveURL(/\/login/)
  })
})
