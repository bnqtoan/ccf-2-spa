import { test, expect } from '@playwright/test'

// E2E cho màn /admin/overview (Track C — R5 lấp đầy + R2 doanh thu/lương).
// Không seed riêng: dựa vào seed chuẩn (global-setup) vốn đã có 2 lịch 'done'
// hôm nay (Lan, Mai) + 1 'no_show' (Lan) và commission_rate cho từng KTV.
// Chỉ khẳng định điều màn hình PHẢI làm được: 3 con số KPI hiện, lưới hiện,
// bấm 1 KTV ra được doanh thu + tiền công.

test('KPI strip hiện đủ 4 số có nhãn quyết định', async ({ page }) => {
  await page.goto('/admin/overview')

  await expect(page.getByTestId('kpi-revenue')).toBeVisible()
  await expect(page.getByTestId('kpi-done')).toBeVisible()
  await expect(page.getByTestId('kpi-occupancy')).toBeVisible()
  await expect(page.getByTestId('kpi-noshow')).toBeVisible()

  // Mỗi KPI có caption nói nó phục vụ quyết định gì (không phải stat card trơ).
  await expect(page.getByTestId('kpi-revenue')).toContainText('đặt giá')
  await expect(page.getByTestId('kpi-occupancy')).toContainText('cân ca')
  await expect(page.getByTestId('kpi-noshow')).toContainText('cọc')
})

test('lưới lấp đầy hiện, có chú thích Có khách / Trống', async ({ page }) => {
  await page.goto('/admin/overview')
  await expect(page.getByTestId('ov-grid')).toBeVisible()
  await expect(page.locator('.ccf-ov-legend')).toContainText('Có khách')
  await expect(page.locator('.ccf-ov-legend')).toContainText('Trống')
})

test('bấm một KTV mở bảng thu nhập với doanh thu + tiền công', async ({ page }) => {
  await page.goto('/admin/overview')
  await expect(page.getByTestId('ov-grid')).toBeVisible()

  // Bấm KTV đầu tiên trong lưới.
  const firstStaffBtn = page.locator('[data-testid^="ov-staff-"]').first()
  await expect(firstStaffBtn).toBeVisible()
  await firstStaffBtn.click()

  const sheet = page.getByTestId('ov-earnings-sheet')
  await expect(sheet).toBeVisible()
  await expect(page.getByTestId('ov-earn-revenue')).toBeVisible()
  await expect(page.getByTestId('ov-earn-payroll')).toBeVisible()

  // Chuyển kỳ Tuần → vẫn còn số (không vỡ).
  await page.getByTestId('ov-period-week').click()
  await expect(page.getByTestId('ov-earn-revenue')).toBeVisible()
})
