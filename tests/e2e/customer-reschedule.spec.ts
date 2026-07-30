import { test, expect } from '@playwright/test'
// E2E cho G5 — khách tự ĐỔI GIỜ (T-24). T-34 — seed qua binding in-process
// (getPlatformProxy) thay cho spawn `wrangler d1 execute`; chỉ INSERT (không
// DELETE), global-setup lo wipe+seed. Xem tests/e2e/_seed.ts.
import { runSql } from './_seed.ts'

/**
 * Seed 1 khách + appointment + booking_item 'booked' cách `offsetMinutes` phút
 * so với BÂY GIỜ THẬT, dùng staff 'Lan' + variant 'Massage toàn thân'/'60 phút'
 * của seed chuẩn. Trả về phone để tra cứu.
 */
async function seedCustomerBooking(offsetMinutes: number): Promise<{ phone: string; startAt: number }> {
  const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
  const nowSec = Math.floor(Date.now() / 1000)
  const startAt = nowSec + Math.round(offsetMinutes * 60)
  const durationMin = 60
  const bufferMin = 10
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const custName = `E2E Reschedule ${phone}`

  await runSql(`
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
  // T-34 — BỎ `mode: 'serial'`. Serial trước đây chỉ để tránh SQLITE_BUSY do
  // hai test seed qua `wrangler d1 execute` (RACE TÀI NGUYÊN). Nay seed qua
  // binding in-process — miniflare tự tuần tự hoá D1 trong tiến trình, không
  // còn tranh khoá liên-tiến-trình → hai test chạy song song an toàn.

  test('khách mở lookup → Đổi giờ → chọn giờ mới → thấy lịch ở giờ mới, không mất lịch', async ({ page }) => {
    const booking = await seedCustomerBooking(180) // 3 tiếng nữa → >2h, hiện được nút Đổi giờ

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

    // Chọn một ngày trong tương lai có ca làm việc thật của 'Lan'. KHÔNG dùng
    // index cứng (`nth(3)`): seed cho ca Mon–Sat (weekday 1–6), CHỦ NHẬT nghỉ
    // (xem src/worker/db/seed.ts) → nếu ngày thứ 4 trong dải rơi đúng Chủ nhật
    // thì availability trả rỗng, lưới `rs-slot-` không bao giờ hiện và test đỏ
    // theo NGÀY-TRONG-TUẦN lúc chạy (bom hẹn giờ như CONVENTIONS §8 cảnh báo).
    // Thay vào đó: đọc ISO date từ chính testid của từng chip, chọn chip đầu
    // tiên là ngày làm việc (KHÔNG Chủ nhật) cách hôm nay >= 2 NGÀY.
    //
    // Vì sao >= 2 ngày, không phải "ngày mai": spec anh em (customer-lookup,
    // cancel-too-late) seed booking cho 'Lan' cách "bây giờ" tối đa ~180 phút.
    // Chạy sát nửa đêm thì +180' tràn sang HÔM SAU, chiếm mất các slot sớm của
    // ngày mai → slot đầu ngày mai đổi bất định giữa các lần chạy. Ngày cách
    // >= 48h nằm ngoài tầm với của mọi seed anh em → slot ổn định.
    const dateChips = page.locator('[data-testid^="rs-date-"]')
    const chipCount = await dateChips.count()
    let chosenChip = null
    for (let i = 2; i < chipCount; i++) {
      const testId = (await dateChips.nth(i).getAttribute('data-testid')) ?? ''
      const iso = testId.replace('rs-date-', '') // 'YYYY-MM-DD'
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
      // Weekday theo lịch (0 = Chủ nhật). Dùng UTC để không lệch theo timezone máy chạy.
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
      if (weekday !== 0) {
        chosenChip = dateChips.nth(i)
        break
      }
    }
    expect(chosenChip, 'phải có ít nhất một ngày làm việc (không phải Chủ nhật) trong dải 14 ngày').not.toBeNull()
    const chosenIso = (await chosenChip!.getAttribute('data-testid'))!.replace('rs-date-', '')
    await chosenChip!.click()

    // Đổi chip ngày → component gọi lại availability (setSlots(null) rồi set lưới
    // mới). Nếu đọc/bấm slot NGAY, có thể trúng lưới của ngày CŨ đang bị thay
    // (CI chậm hơn → cửa sổ race rộng hơn, đây chính là lý do CI đỏ mà local
    // xanh). PHẢI đợi lưới ổn định cho ĐÚNG ngày đã chọn trước khi chạm slot:
    // chờ chip được đánh dấu chọn (state đã cập nhật) rồi chờ ít nhất một slot.
    await expect(page.getByTestId(`rs-date-${chosenIso}`)).toHaveClass(/ccf-lk-rs-date--sel/)
    const slots = page.locator('[data-testid^="rs-slot-"]')
    await expect(slots.first()).toBeVisible()

    // KHÔNG cache testid rồi bấm (phần tử có thể detach nếu còn refetch). Bấm
    // thẳng `.first()` — Playwright tự re-resolve tại thời điểm click. Nhãn giờ
    // "đã chốt" đọc từ THẺ reschedule-chosen (dẫn xuất từ selectedStartAt sau khi
    // đã cam kết), nguồn-sự-thật duy nhất → không có cửa sổ đọc-trên-lưới-cũ.
    await slots.first().click()

    const chosen = page.getByTestId('reschedule-chosen')
    await expect(chosen).toBeVisible()
    // "17:30" từ nhãn "Giờ mới" trong thẻ đã chốt (formatWhen chứa hm).
    const newTimeLabel = (await chosen.locator('.ccf-lk-d').textContent())?.match(/\d{1,2}:\d{2}/)?.[0] ?? ''
    expect(newTimeLabel, 'thẻ giờ mới phải hiện nhãn giờ HH:MM').not.toBe('')

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
    const booking = await seedCustomerBooking(90) // 90 phút nữa — dưới ngưỡng 120

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    await expect(page.locator('[data-testid^="reschedule-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="tel-"]')).toBeVisible()
  })
})
