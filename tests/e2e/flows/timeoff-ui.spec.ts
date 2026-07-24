import { test, expect } from '@playwright/test'
import { bookThroughCustomerUi, createFlowFixture, goTimelineToDate, randomPhone } from './helpers'

// G1 — "Báo nghỉ" trên timeline: lễ tân bấm tên KTV ở đầu cột, chọn khoảng giờ,
// xác nhận. Time-off KHÔNG tự huỷ lịch (PRD §8): lịch đè khoảng nghỉ hiện ngay
// trong sheet và chảy vào hàng chờ xếp lại. Đây là happy path "báo Lan nghỉ".

test('báo nghỉ trên timeline: lịch đè hiện ra ngay và vào hàng chờ xếp lại', async ({ page, request }) => {
  const fx = await createFlowFixture(request)
  const phone = randomPhone()
  const customerName = `Khách G1 ${fx.tag}`
  await bookThroughCustomerUi(page, fx, { name: customerName, phone })

  await page.goto('/admin/timeline')
  await goTimelineToDate(page, fx.date)

  // Fixture đặt lúc 10:00 giờ spa; nghỉ 09:00–12:00 sẽ đè lên.
  await page.getByTestId(`staff-head-${fx.staffId}`).click()
  const sheet = page.getByTestId('time-off-sheet')
  await expect(sheet).toBeVisible()

  await page.getByTestId('time-off-start').fill('09:00')
  await page.getByTestId('time-off-end').fill('12:00')
  await page.getByTestId('time-off-reason').fill(`E2E báo nghỉ ${fx.tag}`)
  await page.getByTestId('time-off-submit').click()

  // Kết quả: danh sách lịch ảnh hưởng có đúng khách vừa đặt.
  await expect(page.getByTestId('time-off-result')).toBeVisible()
  await expect(page.getByTestId('time-off-affected-list')).toContainText(customerName)

  // Sang hàng chờ: item xuất hiện để xử lý (không bị tự huỷ).
  await page.getByTestId('time-off-go-queue').click()
  await expect(page).toHaveURL(/\/admin\/reassign$/)
  // Khoanh vùng vào đúng dòng hàng chờ (tránh strict-mode khớp nhiều phần tử).
  await expect(page.locator('.ccf-rq-w').filter({ hasText: customerName })).toBeVisible()
})
