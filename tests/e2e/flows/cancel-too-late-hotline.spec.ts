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
  // Test này CỐ Ý chờ đồng hồ thật vượt ngưỡng cutoff (~MARGIN_SEC giây) nên
  // cần quỹ thời gian rộng hơn mặc định 30s — không phải chờ mù, mà chờ đúng
  // ranh giới server để nhận 409 thật.
  test.setTimeout(90_000)
  const fx = await createFlowFixture(request)
  const phone = randomPhone()
  const name = `Khách cutoff ${fx.tag}`
  // `POST /api/bookings` buộc lưới 15 phút, nên seed thẳng vào DB để neo đúng
  // mốc: đủ xa ngưỡng cutoff để UI kịp hiện nút Huỷ, rồi chờ "now" thật vượt
  // ranh giới để server trả 409. Không giả đồng hồ/UI.
  //
  // MARGIN_SEC là khoảng cách vượt ngưỡng 120' lúc seed. Biên 8 giây cũ quá
  // sát: khi chạy song song, seed qua wrangler (tranh khoá SQLITE_BUSY) + tải
  // /lookup có thể ăn hết 8 giây trước khi trang render, khiến hoursUntil rơi
  // xuống dưới 2 và UI hiện thẳng hotline — nút Huỷ không bao giờ xuất hiện,
  // test đỏ ngay ở `expect(cancel).toBeVisible()`. 30 giây cho dư địa render
  // chắc chắn kịp; cutoffAt là mốc server bắt đầu trả 409 CANCEL_TOO_LATE.
  const MARGIN_SEC = 30
  const now = Math.floor(Date.now() / 1000)
  const startAt = now + 120 * 60 + MARGIN_SEC
  const cutoffAt = startAt - 120 * 60 // = now + MARGIN_SEC
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
  // Thay cho waitForTimeout(10_000) cứng: chờ ĐÚNG điều kiện cần — "now" thật
  // đã vượt ranh giới cutoff của server — rồi mới bấm. Bám theo mốc đã seed nên
  // tất định, không phụ thuộc một con số chờ đoán mò. Nút Huỷ không tự ẩn theo
  // thời gian (LookupPage chỉ tính hoursUntil lúc render, không có timer), nên
  // vẫn bấm được sau khi chờ. +1 giây để chắc chắn đã qua hẳn ranh giới.
  await expect
    .poll(() => Math.floor(Date.now() / 1000), {
      timeout: (MARGIN_SEC + 15) * 1000,
      intervals: [250],
    })
    .toBeGreaterThan(cutoffAt + 1)
  page.once('dialog', (dialog) => dialog.accept())
  await cancel.click()

  await expect(page.locator('[data-testid^="tel-"]')).toBeVisible()
  await expect(page.getByText('CANCEL_TOO_LATE')).not.toBeVisible()
})
