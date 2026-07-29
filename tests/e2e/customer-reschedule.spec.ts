import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

// E2E cho G5 — khách tự ĐỔI GIỜ (T-24). Cùng cơ chế seed với
// customer-lookup.spec.ts: ghi thẳng D1 local qua `wrangler d1 execute
// --local`, chỉ INSERT (không DELETE) để không đụng dữ liệu agent khác.
const REPO_ROOT = new URL('../../', import.meta.url).pathname

function runSql(statements: string): void {
  const tmpFile = join(tmpdir(), `ccf-2-spa-e2e-rs-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)
  writeFileSync(tmpFile, statements, 'utf8')
  try {
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', `--file=${tmpFile}`], {
          cwd: REPO_ROOT,
          stdio: 'pipe',
        })
        return
      } catch (err) {
        const busy = String((err as { stderr?: Buffer })?.stderr ?? err).includes('SQLITE_BUSY')
        if (!busy || attempt === maxAttempts) throw err
        execFileSync('sleep', [String(0.3 * attempt)])
      }
    }
  } finally {
    unlinkSync(tmpFile)
  }
}

/**
 * Seed 1 khách + appointment + booking_item 'booked' cách `offsetMinutes` phút
 * so với BÂY GIỜ THẬT, dùng staff 'Lan' + variant 'Massage toàn thân'/'60 phút'
 * của seed chuẩn. Trả về phone để tra cứu.
 */
function seedCustomerBooking(offsetMinutes: number): { phone: string; startAt: number } {
  const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
  const nowSec = Math.floor(Date.now() / 1000)
  const startAt = nowSec + Math.round(offsetMinutes * 60)
  const durationMin = 60
  const bufferMin = 10
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const custName = `E2E Reschedule ${phone}`

  runSql(`
INSERT INTO customers (name, phone) VALUES ('${custName}', '${phone}');
INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
  SELECT (SELECT id FROM customers WHERE phone = '${phone}'), ${startAt}, ${endAt}, 'booked', 'online', ${nowSec};
INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
  SELECT
    (SELECT id FROM appointments WHERE source = 'online' AND customer_id = (SELECT id FROM customers WHERE phone = '${phone}')),
    (SELECT id FROM staff WHERE name = 'Lan'),
    (SELECT sv.id FROM service_variants sv JOIN services s ON s.id = sv.service_id WHERE s.name = 'Massage toàn thân' AND sv.name = '60 phút'),
    ${startAt}, ${endAt}, ${blockEndAt}, 'booked';
`)

  return { phone, startAt }
}

test.describe('Khách tự đổi giờ (reschedule)', () => {
  // Serial: seed qua wrangler d1 execute --local (một tiến trình mở thẳng
  // sqlite) — chạy song song trong cùng file dễ SQLITE_BUSY.
  test.describe.configure({ mode: 'serial' })

  test('khách mở lookup → Đổi giờ → chọn giờ mới → thấy lịch ở giờ mới, không mất lịch', async ({ page }) => {
    const booking = seedCustomerBooking(180) // 3 tiếng nữa → >2h, hiện được nút Đổi giờ

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    // Giờ hẹn hiện tại hiển thị trong nhóm Sắp tới.
    await expect(page.getByText('Sắp tới')).toBeVisible()

    // Nút "Đổi giờ" hiện cạnh "Huỷ" (vì >2h).
    const rsBtn = page.locator('[data-testid^="reschedule-"]').first()
    await expect(rsBtn).toBeVisible()
    await rsBtn.click()

    // Màn đổi giờ: dải ngày + lưới slot của đúng dịch vụ đó.
    await expect(page.getByTestId('reschedule-dates')).toBeVisible()

    // Chọn một ngày trong tương lai (ngày thứ 3 trong dải — chắc chắn không rơi
    // vào "dưới 2h" và ca 'Lan' phủ đủ) rồi bấm slot đầu tiên khả dụng.
    const dateChips = page.locator('[data-testid^="rs-date-"]')
    await dateChips.nth(3).click()

    const firstSlot = page.locator('[data-testid^="rs-slot-"]').first()
    await expect(firstSlot).toBeVisible()
    const newTimeLabel = (await firstSlot.textContent())?.trim() ?? ''
    await firstSlot.click()

    // Thẻ "Giờ mới" xác nhận lựa chọn trước khi cam kết.
    await expect(page.getByTestId('reschedule-chosen')).toBeVisible()

    await page.getByTestId('reschedule-confirm').click()

    // Về lại danh sách: KHÔNG mất lịch — vẫn còn đúng 1 lịch sắp tới, và giờ
    // mới (giờ:phút) xuất hiện. Không rơi vào trạng thái rỗng.
    await expect(page.getByText('Sắp tới')).toBeVisible()
    await expect(page.getByTestId('lookup-empty')).toHaveCount(0)
    const rows = page.locator('[data-testid^="booking-"]')
    await expect(rows).toHaveCount(1)
    await expect(page.locator('.ccf-lk-when').first()).toContainText(newTimeLabel)
  })

  test('lịch dưới 2 tiếng KHÔNG hiện nút Đổi giờ (chỉ còn thẻ hotline)', async ({ page }) => {
    const booking = seedCustomerBooking(90) // 90 phút nữa — dưới ngưỡng 120

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    await expect(page.locator('[data-testid^="reschedule-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="tel-"]')).toBeVisible()
  })
})
