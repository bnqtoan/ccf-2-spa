import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

// Repo root — hai cấp lên từ tests/e2e/. wrangler cần chạy ở đây để đọc đúng
// wrangler.jsonc và đúng thư mục state cục bộ (.wrangler/state, giống
// src/worker/db/seed.ts và vite.config.ts persistState).
const REPO_ROOT = new URL('../../', import.meta.url).pathname

/**
 * Chạy SQL thẳng vào D1 local qua `wrangler d1 execute --file=` — CÙNG cơ chế
 * `npm run db:seed:local` dùng (xem src/worker/db/seed.ts). KHÔNG dùng lệnh
 * seed đầy đủ ở đây vì nó XOÁ SẠCH mọi bảng trước khi insert — hai agent khác
 * (T-10, T-12) đang chạy song song trên cùng D1 local, xoá bảng giữa chừng sẽ
 * phá dữ liệu của họ. Thay vào đó chỉ INSERT thêm, không bao giờ DELETE.
 *
 * Ghi thẳng vào booking_items thay vì gọi POST /api/bookings vì cần start_at
 * ở một mốc chính xác (ví dụ đúng 90 phút nữa) để test "dưới 2 tiếng" TẤT
 * ĐỊNH — không phụ thuộc giờ chạy thật có rơi vào ca làm việc 09:00-19:00 hay
 * không. Cách này bỏ qua toàn bộ validateBooking (đúng như
 * tests/api/cancel-status.test.ts đã làm — xem seedBooking ở đó), là lựa chọn
 * có chủ đích: mục tiêu ở đây là test UI + cutoff huỷ, không phải test luồng
 * đặt lịch (đã có test riêng ở T-04).
 */
function runSql(statements: string): void {
  const tmpFile = join(tmpdir(), `ccf-2-spa-e2e-lookup-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)
  writeFileSync(tmpFile, statements, 'utf8')
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', `--file=${tmpFile}`], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    })
  } finally {
    unlinkSync(tmpFile)
  }
}

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
function seedCustomerBooking(offsetMinutes: number, opts: { status?: string } = {}): SeededBooking {
  const phone = `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
  const nowSec = Math.floor(Date.now() / 1000)
  const startAt = nowSec + Math.round(offsetMinutes * 60)
  const status = opts.status ?? 'booked'
  const durationMin = 60
  const bufferMin = 10
  const endAt = startAt + durationMin * 60
  const blockEndAt = endAt + bufferMin * 60
  const custName = `E2E Lookup ${phone}`

  runSql(`
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
  test('tra cứu bằng đúng số điện thoại hiện đúng các lịch hẹn của số đó, không lẫn số khác', async ({
    page,
  }) => {
    const mine = seedCustomerBooking(180) // 3 tiếng nữa
    const other = seedCustomerBooking(180) // số khác, không liên quan

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
    const booking = seedCustomerBooking(180) // 3 tiếng nữa — thoả định nghĩa "xong" của card

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
    const booking = seedCustomerBooking(180)

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    page.once('dialog', (d) => d.accept())
    await page.locator('[data-testid^="cancel-"]').click()

    await expect(page.getByText('Đã huỷ')).toBeVisible()
    await expect(page.getByText('Đã xác nhận')).not.toBeVisible()
  })

  test('lịch hẹn còn dưới 2 tiếng KHÔNG hiện nút Huỷ lịch mà hiện thẻ số điện thoại tel:', async ({ page }) => {
    const booking = seedCustomerBooking(90) // 90 phút nữa — dưới ngưỡng 120

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    await expect(page.locator('[data-testid^="cancel-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="tel-"]')).toBeVisible()
  })

  test('thẻ số điện thoại của lịch dưới 2 tiếng là link tel: bấm gọi được, không phải chữ thường', async ({
    page,
  }) => {
    const booking = seedCustomerBooking(90)

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    const telLink = page.locator('[data-testid^="tel-"]')
    await expect(telLink).toHaveAttribute('href', /^tel:/)
  })

  test('khi server trả 409 CANCEL_TOO_LATE bất ngờ, giao diện chuyển sang hiện hotline thay vì hiện lỗi thô', async ({
    page,
  }) => {
    // Mô phỏng đúng tình huống PRD nêu: khách mở trang khi còn đủ xa (UI hiện
    // nút Huỷ), rồi thời gian trôi qua tới lúc khách thực sự bấm — server
    // đánh giá lại "now" tại thời điểm nhận request và thấy đã dưới cutoff.
    //
    // Seed cách "bây giờ" đúng 120 phút + 8 giây — đủ xa để canCustomerCancel
    // (now <= startAt - 120*60) còn đúng lúc trang tải (UI hiện nút Huỷ vì
    // hoursUntil ~2.002h >= 2), nhưng CHỦ ĐỘNG chờ 10 giây trước khi bấm để
    // "now" thật của server tại lúc POST /cancel vượt qua ranh giới
    // startAt-120', khiến server trả 409 CANCEL_TOO_LATE dù UI đã hiện nút.
    // Tất định: không phụ thuộc giờ/ngày chạy, chỉ phụ thuộc độ trễ ta chủ
    // động tạo ra, luôn > 8 giây biên đã chừa.
    const booking = seedCustomerBooking(120 + 8 / 60)

    await page.goto('/lookup')
    await page.getByTestId('lookup-phone-input').fill(booking.phone)
    await page.getByTestId('lookup-submit').click()

    const cancelBtn = page.locator('[data-testid^="cancel-"]')
    await expect(cancelBtn).toBeVisible()

    // Chờ cho "now" thật vượt qua ranh giới cutoff của server trước khi bấm.
    await page.waitForTimeout(10_000)

    page.once('dialog', (d) => d.accept())
    await cancelBtn.click()

    // Server trả 409 CANCEL_TOO_LATE (đã qua ranh giới 120 phút thật lúc bấm)
    // → UI phải hiện hotline, không hiện lỗi kỹ thuật thô.
    await expect(page.locator('[data-testid^="tel-"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('CANCEL_TOO_LATE')).not.toBeVisible()
    await expect(page.getByText(/error/i)).not.toBeVisible()
  })

  test('nút Huỷ lịch và thẻ số điện thoại đều có vùng chạm tối thiểu 48px', async ({ page }) => {
    const farBooking = seedCustomerBooking(180)
    const nearBooking = seedCustomerBooking(90)

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
