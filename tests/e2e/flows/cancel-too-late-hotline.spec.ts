import { test, expect } from '@playwright/test'
import { createFlowFixture, randomPhone } from './helpers'
// T-34 — seed qua binding in-process thay cho spawn `wrangler d1 execute`.
import { runSql } from '../_seed.ts'

test('khách huỷ lịch trong vòng 2 tiếng nhận 409 CANCEL_TOO_LATE và giao diện hiện hotline thay vì lỗi', async ({ page, request }) => {
  // T-35 — KHÔNG còn chờ đồng hồ thật (trước đây ~32s). Tình huống PRD giữ
  // NGUYÊN: khách mở trang khi còn đủ xa (UI hiện nút Huỷ vì hoursUntil tính
  // theo đồng hồ TRÌNH DUYỆT), rồi lúc bấm Huỷ, "now" của SERVER đã qua mốc
  // cutoff → 409 CANCEL_TOO_LATE + hiện hotline. Tách rời đồng hồ UI và server
  // bằng header X-Test-Now (cơ chế inject clock T-21, chỉ bật khi TEST_CLOCK=1).
  const fx = await createFlowFixture(request)
  const phone = randomPhone()
  const name = `Khách cutoff ${fx.tag}`
  // `POST /api/bookings` buộc lưới 15 phút, nên seed thẳng vào DB để neo đúng
  // mốc. start_at đủ xa (3 tiếng) để UI hiện nút Huỷ theo đồng hồ trình duyệt.
  const now = Math.floor(Date.now() / 1000)
  const startAt = now + 180 * 60
  // Đồng hồ SERVER giả: đã qua mốc cutoff (startAt - 120') đúng 60 giây, vẫn
  // trước startAt → booking còn "sắp tới" nhưng dưới ngưỡng huỷ. GET
  // /api/bookings không đọc "now" nên nút Huỷ vẫn render; chỉ POST cancel đọc.
  const serverNow = startAt - 120 * 60 + 60
  await runSql(`
INSERT INTO customers (name, phone) VALUES ('${name}', '${phone}');
INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
  SELECT id, ${startAt}, ${startAt + 30 * 60}, 'booked', 'online', ${now} FROM customers WHERE phone = '${phone}';
INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
  SELECT a.id, ${fx.staffId}, ${fx.variantId}, ${startAt}, ${startAt + 30 * 60}, ${startAt + 35 * 60}, 'booked'
  FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE c.phone = '${phone}';
`)

  await page.setExtraHTTPHeaders({ 'X-Test-Now': String(serverNow) })
  await page.goto('/lookup')
  await page.getByTestId('lookup-phone-input').fill(phone)
  await page.getByTestId('lookup-submit').click()
  const cancel = page.locator('[data-testid^="cancel-"]')
  await expect(cancel).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await cancel.click()

  await expect(page.locator('[data-testid^="tel-"]')).toBeVisible()
  await expect(page.getByText('CANCEL_TOO_LATE')).not.toBeVisible()
})
