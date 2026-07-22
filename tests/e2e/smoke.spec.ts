import { test, expect } from '@playwright/test'

// Smoke tối thiểu: cả hai trang render được và khác nhau.
// Bản đầu (T-01) khẳng định đúng chuỗi placeholder 'Đặt lịch spa'; T-10 thay
// trang khách bằng luồng đặt lịch thật ('Sen Spa') nên test hoá lỗi thời —
// đỏ vì test cũ, không phải vì code hỏng. Ở đây chỉ khẳng định điều smoke
// thật sự cần: trang lên được, có tiêu đề, và hai trang không phải một.

test('trang khách / render được', async ({ page }) => {
  await page.goto('/')
  const h1 = page.locator('h1').first()
  await expect(h1).toBeVisible()
  await expect(h1).not.toHaveText('')
})

test('trang admin /admin render được và khác trang khách', async ({ page }) => {
  await page.goto('/')
  const guestTitle = (await page.locator('h1').first().textContent()) ?? ''

  await page.goto('/admin')
  const adminTitle = page.locator('h1').first()
  await expect(adminTitle).toBeVisible()
  await expect(adminTitle).not.toHaveText(guestTitle)
})
