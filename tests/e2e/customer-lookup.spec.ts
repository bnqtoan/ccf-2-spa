import { test, expect } from '@playwright/test'
// T-34 — seed qua binding in-process (getPlatformProxy) thay cho spawn
// `wrangler d1 execute`. Cùng chữ ký `runSql(sql)`, nhưng KHÔNG spawn
// subprocess và KHÔNG cần retry SQLITE_BUSY (miniflare tự tuần tự hoá D1 trong
// tiến trình) — xem tests/e2e/_seed.ts.
//
// Vẫn chỉ INSERT thêm (không DELETE) như trước: nhiều spec dùng chung D1 local,
// global-setup lo phần wipe+seed. Ghi thẳng booking_items (bỏ qua
// validateBooking) là chủ đích — cần neo start_at ở mốc chính xác để test
// "dưới 2 tiếng" tất định, không phụ thuộc giờ chạy thật.
import { runSql } from './_seed.ts'

interface SeededBooking {
  phone: string
  startAt: number
}

/**
 * Seed một khách hàng + 1 appointment + 1 booking_item "booked", neo
 * `start_at` cách NGAY LÚC GỌI HÀM NÀY (không phải giờ mai/giờ cố định)
 * `offsetMinutes` phút — để test cutoff 120' so đúng với `now` thật của
 * server tại thời điểm bấm Huỷ lịch. Số điện thoại random mỗi lần gọi để các
 * test không lẫn dữ liệu của nhau dù chạy song song (Playwright
 * fullyParallel).
 *
 * Dùng thẳng staff 'Lan' + variant 'Massage toàn thân' / '60 phút' đã có sẵn
 * trong seed chuẩn (src/worker/db/seed.ts) — không tạo lại reference data,
 * chỉ tham chiếu bằng natural key qua subquery.
 */
async function seedCustomerBooking(offsetMinutes: number, opts: { status?: string } = {}): Promise<SeededBooking> {
  const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
  const nowSec = Math.floor(Date.now() / 1000)
  const startAt = nowSec + Math.round(offsetMinutes * 60)
  const status = opts.status ?? 'booked'
  const durationMin = 60
  const bufferMin = 10
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const custName = `E2E Lookup ${phone}`

  await runSql(`
INSERT INTO customers (name, phone) VALUES ('${custName}', '${phone}');
INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
  SELECT (SELECT id FROM customers WHERE phone = '${phone}'), ${startAt}, ${endAt}, '${status}', 'online', ${nowSec};
INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
  SELECT
    (SELECT id FROM appointments WHERE source = 'online' AND customer_id = (SELECT id FROM customers WHERE phone = '${phone}')),
    (SELECT id FROM staff WHERE name = 'Lan'),
    (SELECT sv.id FROM service_variants sv JOIN services s ON s.id = sv.service_id WHERE s.name = 'Massage toàn thân' AND sv.name = '60 phút'),
    ${startAt}, ${endAt}, ${blockEndAt}, '${status}';
`)

  return { phone, startAt }
}

test.describe('Tra cứu lịch bằng SĐT + huỷ lịch', () => {
  // T-34 — BỎ `mode: 'serial'`. Serial trước đây CHỈ để tránh SQLITE_BUSY do
  // seed qua `wrangler d1 execute` (RACE TÀI NGUYÊN). Nay seed qua binding
  // in-process (miniflare tự tuần tự hoá D1) → hết tranh khoá liên-tiến-trình.
  // Mỗi test seed booking theo SĐT random riêng, không chia sẻ trạng thái toàn
  // cục → chạy song song an toàn.

  test('tra cứu bằng đúng số điện thoại hiện đúng các lịch hẹn của số đó, không lẫn số khác', async ({
    page,
  }) => {
    const mine = await seedCustomerBooking(180) // 3 tiếng nữa
    const other = await seedCustomerBooking(180) // số khác, không liên quan

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(mine.phone)
    await page.getByTestId('lookup-submit').click()

    await expect(page.getByText('Sắp tới')).toBeVisible()
    // Lịch của mình xuất hiện.
    const rows = page.locator('[data-testid^="booking-"]')
    await expect(rows).toHaveCount(1)
    // Không hiện lịch của số khác (kiểm bằng cách phone khác không match — ở
    // đây phone chỉ dùng để tra cứu, không hiện trong booking row, nên khẳng
    // định gián tiếp qua số lượng đúng 1 dòng thay vì tìm nội dung số kia).
    expect(other.phone).not.toBe(mine.phone)
  })

  test('tra cứu bằng số điện thoại chưa từng đặt lịch hiện trạng thái rỗng thân thiện', async ({ page }) => {
    const neverUsedPhone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(neverUsedPhone)
    await page.getByTestId('lookup-submit').click()

    await expect(page.getByTestId('lookup-empty')).toBeVisible()
    await expect(page.getByTestId('lookup-empty')).toContainText('chưa có lịch hẹn')
  })

  test('huỷ một lịch còn xa giờ hẹn thành công và lịch đó biến mất khỏi nhóm Sắp tới', async ({ page }) => {
    const booking = await seedCustomerBooking(180) // 3 tiếng nữa — thoả định nghĩa "xong" của card

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    await expect(page.locator('[data-testid^="cancel-"]')).toBeVisible()

    page.once('dialog', (d) => d.accept())
    await page.locator('[data-testid^="cancel-"]').click()

    // Không cần tải lại trang: danh sách tự cập nhật.
    await expect(page.getByTestId('lookup-empty')).toBeVisible()
  })

  test('huỷ một lịch còn xa giờ hẹn xong thì lịch đó xuất hiện trong nhóm Đã huỷ', async ({ page }) => {
    const booking = await seedCustomerBooking(180)

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    page.once('dialog', (d) => d.accept())
    await page.locator('[data-testid^="cancel-"]').click()

    await expect(page.locator('.ccf-lk-label', { hasText: 'Đã huỷ' })).toBeVisible()
    await expect(page.locator('.ccf-pill', { hasText: 'Đã huỷ' })).toBeVisible()
    await expect(page.getByText('Đã xác nhận')).not.toBeVisible()
  })

  test('lịch hẹn còn dưới 2 tiếng KHÔNG hiện nút Huỷ lịch mà hiện thẻ số điện thoại tel:', async ({ page }) => {
    const booking = await seedCustomerBooking(90) // 90 phút nữa — dưới ngưỡng 120

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    await expect(page.locator('[data-testid^="cancel-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="tel-"]')).toBeVisible()
  })

  test('thẻ số điện thoại của lịch dưới 2 tiếng là link tel: bấm gọi được, không phải chữ thường', async ({
    page,
  }) => {
    const booking = await seedCustomerBooking(90)

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    const telLink = page.locator('[data-testid^="tel-"]')
    await expect(telLink).toHaveAttribute('href', /^tel:/)
  })

  test('khi server trả 409 CANCEL_TOO_LATE bất ngờ, giao diện chuyển sang hiện hotline thay vì hiện lỗi thô', async ({
    page,
  }) => {
    // T-35 — KHÔNG còn chờ đồng hồ thật (trước đây ~32s). Tình huống PRD giữ
    // NGUYÊN: khách mở trang khi còn đủ xa (UI hiện nút Huỷ vì hoursUntil tính
    // theo đồng hồ TRÌNH DUYỆT), rồi lúc bấm Huỷ, "now" của SERVER đã qua mốc
    // cutoff → 409 CANCEL_TOO_LATE. Điểm mấu chốt: đồng hồ UI và đồng hồ server
    // TÁCH RỜI — ta đẩy riêng đồng hồ server qua header X-Test-Now (cơ chế
    // inject clock của T-21, chỉ bật khi TEST_CLOCK=1; GET /api/bookings không
    // đọc "now" nên nút Huỷ vẫn hiện). Không đụng mốc 120' server-side.
    const booking = await seedCustomerBooking(180) // 3 tiếng nữa → UI hiện nút Huỷ (đồng hồ trình duyệt)
    // Đồng hồ SERVER giả: đã qua mốc cutoff (startAt - 120') đúng 60 giây, nhưng
    // vẫn TRƯỚC startAt → booking còn "sắp tới", chỉ là dưới ngưỡng huỷ. Khi bấm
    // Huỷ, POST /api/bookings/:id/cancel đọc X-Test-Now này → 409 tức thời.
    const serverNow = booking.startAt - 120 * 60 + 60
    await page.setExtraHTTPHeaders({ 'X-Test-Now': String(serverNow) })

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    const cancelBtn = page.locator('[data-testid^="cancel-"]')
    await expect(cancelBtn).toBeVisible()

    page.once('dialog', (d) => d.accept())
    await cancelBtn.click()

    // Server trả 409 CANCEL_TOO_LATE (đã qua ranh giới 120 phút thật lúc bấm)
    // → UI phải hiện hotline, không hiện lỗi kỹ thuật thô.
    await expect(page.locator('[data-testid^="tel-"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('CANCEL_TOO_LATE')).not.toBeVisible()
    await expect(page.getByText(/error/i)).not.toBeVisible()
  })

  test('nút Huỷ lịch và thẻ số điện thoại đều có vùng chạm tối thiểu 48px', async ({ page }) => {
    const farBooking = await seedCustomerBooking(180)
    const nearBooking = await seedCustomerBooking(90)

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(farBooking.phone)
    await page.getByTestId('lookup-submit').click()
    const cancelBox = await page.locator('[data-testid^="cancel-"]').boundingBox()
    expect(cancelBox).not.toBeNull()
    expect(cancelBox!.height).toBeGreaterThanOrEqual(48)

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(nearBooking.phone)
    await page.getByTestId('lookup-submit').click()
    const telBox = await page.locator('[data-testid^="tel-"]').boundingBox()
    expect(telBox).not.toBeNull()
    expect(telBox!.height).toBeGreaterThanOrEqual(48)
  })
})
