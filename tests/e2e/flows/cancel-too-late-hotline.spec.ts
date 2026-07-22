import { execFileSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { createFlowFixture, randomPhone } from './helpers'

const REPO_ROOT = new URL('../../../', import.meta.url).pathname

function runSql(statements: string): void {
  const file = join(tmpdir(), `ccf-e2e-cutoff-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)
  writeFileSync(file, statements, 'utf8')
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', `--file=${file}`], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    })
  } finally {
    unlinkSync(file)
  }
}

test('khách huỷ lịch trong vòng 2 tiếng nhận 409 CANCEL_TOO_LATE và giao diện hiện hotline thay vì lỗi', async ({ page, request }) => {
  const fx = await createFlowFixture(request)
  const phone = randomPhone()
  const name = `Khách cutoff ${fx.tag}`
  // `POST /api/bookings` buộc lưới 15 phút, nên không thể tạo một mốc đúng
  // 120 phút + vài giây để UI kịp hiện nút Huỷ rồi server thật trả 409. Seed
  // sát ranh giới này giống customer-lookup.spec.ts; không giả đồng hồ/UI.
  const now = Math.floor(Date.now() / 1000)
  const startAt = now + 120 * 60 + 8
  runSql(`
INSERT INTO customers (name, phone) VALUES ('${name}', '${phone}');
INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
  SELECT id, ${startAt}, ${startAt + 30 * 60}, 'booked', 'online', ${now} FROM customers WHERE phone = '${phone}';
INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
  SELECT a.id, ${fx.staffId}, ${fx.variantId}, ${startAt}, ${startAt + 30 * 60}, ${startAt + 35 * 60}, 'booked'
  FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE c.phone = '${phone}';
`)

  await page.goto('/lookup')
  await page.getByTestId('lookup-phone-input').fill(phone)
  await page.getByTestId('lookup-submit').click()
  const cancel = page.locator('[data-testid^="cancel-"]')
  await expect(cancel).toBeVisible()
  await page.waitForTimeout(10_000)
  page.once('dialog', (dialog) => dialog.accept())
  await cancel.click()

  await expect(page.locator('[data-testid^="tel-"]')).toBeVisible()
  await expect(page.getByText('CANCEL_TOO_LATE')).not.toBeVisible()
})
