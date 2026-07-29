// T-22 E2E — 3 vai trò đăng nhập thấy đúng PHẠM VI. Tự chứa: mỗi test tự đăng
// nhập bằng user seed (owner/reception/ktv), KHÔNG dùng storageState chung (đó
// là phiên owner). KHÔNG tạo time_off/booking mới → không đụng hàng chờ reassign
// toàn cục, an toàn ngoài project shared-queue.
//
// T-23 — ADMIN_PASSWORD (env) đã BỎ HẲN. Mật khẩu seed mặc định là 'admin123'
// (src/worker/db/seed.ts DEFAULT_PW) cho cả 3 user, NHƯNG chỉ owner có
// must_change_password=1 (bắt đổi lần đầu) — reception/ktv là user DEV/E2E nội
// bộ, không phải luồng bàn giao thật (=0). owner dùng _authHelpers (idempotent
// qua nhiều spec/project không đảm bảo thứ tự); reception/ktv giữ PW cố định.
//
// Kiểm HAI điều card yêu cầu:
//   1. nav + trang thấy đúng phạm vi (technician KHÔNG thấy nav thiết lập/dashboard).
//   2. technician mở timeline CHỈ thấy cột của mình.

import { test, expect, type Page } from '@playwright/test'
import { loginOwnerPastMustChange } from './_authHelpers'

const PW = 'admin123' // reception/ktv: must_change_password=0, mật khẩu seed không đổi

async function loginAs(page: Page, username: string) {
  const res = await page.request.post('/api/auth/login', { data: { username, password: PW } })
  expect(res.status(), `login ${username} phải 200 (seed user + DEFAULT_PW)`).toBe(200)
}

test.describe('T-22 RBAC — 3 vai trò thấy đúng phạm vi', () => {
  test.beforeEach(async ({ page }) => {
    // Đảm bảo bắt đầu sạch phiên (guard spec khác có thể để lại cookie).
    await page.request.post('/api/auth/logout')
  })

  test('owner: thấy Tổng quan (dashboard tiền) + Người dùng ở trang chủ /admin', async ({ page }) => {
    // owner có must_change_password=1 (T-23) — tự đổi trước khi kỳ vọng vào
    // thẳng /admin (không phải noise: guard SPA THẬT SỰ chặn nếu bỏ qua bước này).
    await loginOwnerPastMustChange(page.request)
    await page.goto('/admin')
    // Trang chủ /admin là bảng THẺ (testid admin-nav-<to>), không phải thanh AdminNav.
    await expect(page.getByTestId('admin-nav-/admin/overview')).toBeVisible()
    await expect(page.getByTestId('admin-nav-/admin/users')).toBeVisible()
    await expect(page.getByTestId('admin-nav-/admin/setup')).toBeVisible()
    // owner vào được trang dashboard tiền (không bị guard đẩy đi).
    await page.goto('/admin/overview')
    await expect(page).toHaveURL(/\/admin\/overview/)
    await expect(page.getByText('Doanh thu hôm nay')).toBeVisible()
    // owner vào được trang quản lý user.
    await page.goto('/admin/users')
    await expect(page).toHaveURL(/\/admin\/users/)
    await expect(page.getByTestId('user-create-form')).toBeVisible()
  })

  test('receptionist: KHÔNG thấy Tổng quan/Người dùng, LÀM được timeline', async ({ page }) => {
    await loginAs(page, 'reception')
    await page.goto('/admin')
    // Trang chủ /admin (thẻ): lễ tân có timeline/reassign/setup, KHÔNG có overview/users.
    await expect(page.getByTestId('admin-nav-/admin/timeline')).toBeVisible()
    await expect(page.getByTestId('admin-nav-/admin/setup')).toBeVisible()
    await expect(page.getByTestId('admin-nav-/admin/overview')).toHaveCount(0)
    await expect(page.getByTestId('admin-nav-/admin/users')).toHaveCount(0)

    // Cố vào thẳng /admin/overview → guard đẩy về /admin (không xem được tiền).
    await page.goto('/admin/overview')
    await expect(page).toHaveURL(/\/admin$/)

    // Vào được timeline (vận hành); thanh AdminNav ở đó KHÔNG có overview/users.
    await page.goto('/admin/timeline')
    await expect(page).toHaveURL(/\/admin\/timeline/)
    await expect(page.getByTestId('admin-nav')).toBeVisible()
    await expect(page.getByTestId('admin-nav-link-/admin/overview')).toHaveCount(0)
    await expect(page.getByTestId('admin-nav-link-/admin/users')).toHaveCount(0)
  })

  test('technician: đăng nhập → vào thẳng timeline, CHỈ thấy cột của mình', async ({ page }) => {
    await loginAs(page, 'ktv')

    // Nav technician: chỉ có Lịch ngày (không overview/reassign/setup/users).
    await page.goto('/admin/timeline')
    await expect(page).toHaveURL(/\/admin\/timeline/)
    await expect(page.getByTestId('admin-nav-link-/admin/timeline')).toBeVisible()
    await expect(page.getByTestId('admin-nav-link-/admin/overview')).toHaveCount(0)
    await expect(page.getByTestId('admin-nav-link-/admin/reassign')).toHaveCount(0)
    await expect(page.getByTestId('admin-nav-link-/admin/setup')).toHaveCount(0)
    await expect(page.getByTestId('admin-nav-link-/admin/users')).toHaveCount(0)

    // Timeline CHỈ hiện 1 cột KTV (của chính mình). Seed link ktv → staff 'Lan'.
    // Các cột KTV là các nút staff-head-*. Đếm phải = 1.
    await expect(page.locator('[data-testid^="staff-head-"]')).toHaveCount(1)

    // Cố vào /admin/overview (tiền) → guard đẩy về timeline (không xem được).
    await page.goto('/admin/overview')
    await expect(page).toHaveURL(/\/admin\/timeline/)

    // Cố vào /admin/setup → cũng bị đẩy về timeline.
    await page.goto('/admin/setup')
    await expect(page).toHaveURL(/\/admin\/timeline/)
  })
})
