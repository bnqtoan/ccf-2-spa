import { test, expect } from '@playwright/test'

test('trang khách / render được', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1')).toHaveText('Đặt lịch spa')
})

test('trang admin /admin render được và khác trang khách', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.locator('h1')).toHaveText('Quản trị spa')
})
