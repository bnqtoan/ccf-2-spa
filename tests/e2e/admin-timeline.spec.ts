import { test, expect } from '@playwright/test'
// T-34 — seed + đọc D1 local qua binding in-process (getPlatformProxy) thay cho
// spawn `wrangler d1 execute`. Chỉ INSERT thêm (không DELETE), global-setup lo
// wipe+seed; random hoá dữ liệu để nhiều spec không đụng nhau. Xem
// tests/e2e/_seed.ts.
import { runSql, querySql } from './_seed.ts'

const SPA_TZ = 'Asia/Ho_Chi_Minh'

/** Epoch (giây, UTC) của một mốc giờ ĐỊA PHƯƠNG spa, cho ngày `dateStr`. */
function localToEpoch(dateStr: string, hour: number, minute = 0): number {
  const parts = dateStr.split('-')
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  // Đoán bằng offset +07:00 cố định của VN (không có DST từ 1975 — hằng số
  // an toàn để dùng trong test, không cần thuật toán lặp như lib/time.ts).
  const asUtcGuess = Date.UTC(y, m - 1, d, hour, minute, 0) / 1000
  const offsetSec = 7 * 3600
  return asUtcGuess - offsetSec
}

/** "YYYY-MM-DD" của ngày Thứ Hai gần nhất SAU HÔM NAY theo giờ VN — luôn là
 * một ngày có ca làm việc (weekday 1-6, seed chuẩn cấp ca Mon-Sat 09:00-19:00)
 * và luôn ở tương lai, không phụ thuộc giờ chạy test thật. */
function nextMondayDateStr(): string {
  const nowUtc = new Date()
  const vnNow = new Date(nowUtc.getTime() + 7 * 3600 * 1000) // xấp xỉ giờ VN đủ dùng để tính "ngày"
  const todayWeekday = vnNow.getUTCDay() // 0=CN..6=T7, tính trên đồng hồ đã dịch +7h
  const daysUntilNextMonday = ((1 - todayWeekday + 7) % 7) + 7 // luôn nhảy sang TUẦN SAU để chắc chắn > hôm nay
  const target = new Date(vnNow.getTime() + daysUntilNextMonday * 86400 * 1000)
  const y = target.getUTCFullYear()
  const m = String(target.getUTCMonth() + 1).padStart(2, '0')
  const d = String(target.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const TARGET_DATE = nextMondayDateStr()

/**
 * Kéo-thả HTML5 THẬT trong test. Playwright `locator.dragTo()` KHÔNG mang theo
 * một `DataTransfer` xuyên qua native drag-and-drop → `onDrop` của app đọc
 * `getData('text/plain')` ra rỗng, drop không kích hoạt (sheet xác nhận không
 * hiện). Đây là hạn chế của Playwright, KHÔNG phải lỗi app (trình duyệt thật của
 * lễ tân mang DataTransfer bình thường). Helper này tự phát chuỗi sự kiện
 * dragstart→dragenter→dragover→drop→dragend với MỘT DataTransfer dùng chung. */
async function dragBlockToCell(page: import('@playwright/test').Page, sourceTestId: string, targetTestId: string) {
  await page.evaluate(
    ({ sourceTestId, targetTestId }) => {
      const src = document.querySelector(`[data-testid="${sourceTestId}"]`)
      const dst = document.querySelector(`[data-testid="${targetTestId}"]`)
      if (!src || !dst) throw new Error(`drag: không thấy ${!src ? sourceTestId : targetTestId}`)
      const dt = new DataTransfer()
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      fire(src, 'dragstart')
      fire(dst, 'dragenter')
      fire(dst, 'dragover')
      fire(dst, 'drop')
      fire(src, 'dragend')
    },
    { sourceTestId, targetTestId },
  )
}

interface SeededItem {
  itemId: number
  staffName: string
}

/** Seed một appointment + booking_item thật, neo giờ CỐ ĐỊNH trên TARGET_DATE
 * (không phụ thuộc giờ chạy test). Dùng natural key (tên KTV/dịch vụ) từ seed
 * chuẩn src/worker/db/seed.ts — không tạo lại reference data. */
async function seedBookingItem(opts: {
  staffName: string
  serviceName: string
  variantName: string
  hour: number
  minute?: number
  status?: string
  source?: string
  customerSuffix: string
  /** T-32: SĐT khách — mặc định NULL (khách lẻ vãng lai, CONVENTIONS §4). */
  customerPhone?: string | null
}): Promise<SeededItem> {
  const { staffName, serviceName, variantName, hour, status = 'booked', source = 'online', customerSuffix } = opts
  const minute = opts.minute ?? 0
  const customerPhone = opts.customerPhone ?? null
  const startAt = localToEpoch(TARGET_DATE, hour, minute)
  const nowSec = Math.floor(Date.now() / 1000)
  const custName = `E2E TL ${customerSuffix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`
  const phoneSql = customerPhone === null ? 'NULL' : `'${customerPhone}'`

  await runSql(`
INSERT INTO customers (name, phone) VALUES ('${custName}', ${phoneSql});
INSERT INTO appointments (customer_id, start_at, end_at, status, source, created_at)
  SELECT (SELECT id FROM customers WHERE name = '${custName}'),
         ${startAt},
         ${startAt} + sv.duration_min * 60,
         '${status}', '${source}', ${nowSec}
  FROM service_variants sv JOIN services s ON s.id = sv.service_id
  WHERE s.name = '${serviceName}' AND sv.name = '${variantName}';
INSERT INTO booking_items (appointment_id, staff_id, variant_id, start_at, end_at, block_end_at, status)
  SELECT
    (SELECT id FROM appointments WHERE customer_id = (SELECT id FROM customers WHERE name = '${custName}')),
    (SELECT id FROM staff WHERE name = '${staffName}'),
    sv.id,
    ${startAt},
    ${startAt} + sv.duration_min * 60,
    ${startAt} + sv.duration_min * 60 + sv.buffer_after_min * 60,
    '${status}'
  FROM service_variants sv JOIN services s ON s.id = sv.service_id
  WHERE s.name = '${serviceName}' AND sv.name = '${variantName}';
`)

  const rows = await querySql<{ id: number }>(
    `SELECT bi.id AS id FROM booking_items bi JOIN appointments a ON a.id = bi.appointment_id JOIN customers c ON c.id = a.customer_id WHERE c.name = '${custName}'`,
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`Seed thất bại: không tìm thấy booking_item vừa tạo cho ${custName}`)
  return { itemId: row.id, staffName }
}

/** Seed một time-off phủ đúng khoảng [hourStart,hourEnd) của TARGET_DATE cho
 * một KTV — dùng để tạo booking mồ côi tất định. */
async function seedTimeOff(staffName: string, hourStart: number, hourEnd: number): Promise<void> {
  const startAt = localToEpoch(TARGET_DATE, hourStart)
  const endAt = localToEpoch(TARGET_DATE, hourEnd)
  await runSql(`
INSERT INTO time_off (staff_id, start_at, end_at, reason)
  SELECT id, ${startAt}, ${endAt}, 'E2E nghỉ đột xuất' FROM staff WHERE name = '${staffName}';
`)
}

test.describe('Admin — timeline theo cột KTV', () => {
  // Serial vì RACE LOGIC, KHÔNG phải race tài nguyên (T-34): các test trong
  // file này bật/tắt BANNER hàng chờ reassign — vốn tính trên hàng chờ TOÀN
  // CỤC (GET /api/admin/reassign-queue, không lọc theo ngày/fixture). Hai test
  // chạy đan xen thì orphan của test này lọt vào khẳng định "banner rỗng" của
  // test kia. (Race tài nguyên SQLITE_BUSY do spawn wrangler đã bị T-34 xoá —
  // nay seed qua binding in-process.) File này ở project chromium-shared-queue
  // (workers:1) cũng vì lý do LOGIC toàn-cục này.
  test.describe.configure({ mode: 'serial' })

  test('booking hiện đúng cột của đúng KTV tại đúng vị trí giờ trên timeline', async ({ page }) => {
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 10,
      customerSuffix: 'ColPos',
    })

    await page.goto('/admin/timeline')
    // Component tự điều hướng bằng nút lùi/tiến ngày, không đọc query param
    // (card: "không làm điều hướng đổi ngày bằng URL/router phức tạp").
    await goToTargetDate(page)

    const block = page.getByTestId(`booking-item-${seeded.itemId}`)
    await expect(block).toBeVisible()
    await expect(block).toContainText('E2E TL ColPos')

    // Đúng cột: phần tử nằm bên trong cell của đúng KTV tại đúng giờ (10:00).
    const staffId = await staffIdOf(page, 'Huong')
    const cellAtHour = page.getByTestId(`cell-${staffId}-10`)
    await expect(cellAtHour.getByTestId(`booking-item-${seeded.itemId}`)).toBeVisible()
  })

  test('buffer sau mỗi block hiện thành dải mờ riêng biệt với phần chính của block', async ({ page }) => {
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '90 phút', // buffer_after_min = 15 — dải buffer đủ lớn để đo
      hour: 12,
      customerSuffix: 'Buf',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    const buf = page.getByTestId(`buffer-${seeded.itemId}`)
    await expect(buf).toBeVisible()
    const bufBox = await buf.boundingBox()
    expect(bufBox).not.toBeNull()
    // 15 phút buffer, ROW_HEIGHT_PX=52 -> (15/60)*52 = 13px
    expect(bufBox!.height).toBeGreaterThan(5)

    const block = page.getByTestId(`booking-item-${seeded.itemId}`)
    const blockBox = await block.boundingBox()
    expect(blockBox).not.toBeNull()
    // Dải buffer nằm Ở ĐUÔI (đáy) block, không trùm toàn bộ block.
    expect(bufBox!.height).toBeLessThan(blockBox!.height)
  })

  test('item mồ côi hiện màu cảnh báo khác với booking bình thường', async ({ page }) => {
    const normal = await seedBookingItem({
      staffName: 'Mai',
      serviceName: 'Chăm sóc móng',
      variantName: 'Sơn gel',
      hour: 9,
      customerSuffix: 'Normal',
    })
    const orphan = await seedBookingItem({
      staffName: 'Trang',
      serviceName: 'Chăm sóc da mặt',
      variantName: 'Cơ bản',
      hour: 15,
      customerSuffix: 'Orphan',
    })
    await seedTimeOff('Trang', 14, 19) // phủ đúng booking lúc 15h của Trang -> mồ côi

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    const normalBlock = page.getByTestId(`booking-item-${normal.itemId}`)
    const orphanBlock = page.getByTestId(`booking-item-${orphan.itemId}`)
    await expect(orphanBlock).toBeVisible()
    await expect(orphanBlock).toHaveAttribute('data-orphan', 'true')
    await expect(normalBlock).toHaveAttribute('data-orphan', 'false')

    const normalColor = await normalBlock.evaluate((el) => getComputedStyle(el).backgroundColor)
    const orphanColor = await orphanBlock.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(orphanColor).not.toBe(normalColor)
  })

  test('item mồ côi nổi lên trên khối nghỉ đột xuất, không bị khối nghỉ che khuất', async ({ page }) => {
    const orphan = await seedBookingItem({
      staffName: 'Yen',
      serviceName: 'Chăm sóc da mặt',
      variantName: 'Chuyên sâu',
      hour: 16,
      customerSuffix: 'ZOrder',
    })
    await seedTimeOff('Yen', 14, 19) // phủ đúng booking lúc 16h -> mồ côi, đè bởi khối nghỉ 14-19h

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    const orphanBlock = page.getByTestId(`booking-item-${orphan.itemId}`)
    await expect(orphanBlock).toBeVisible()
    await expect(orphanBlock).toHaveAttribute('data-orphan', 'true')

    const timeOffBlock = page.getByTestId('time-off-' + (await staffIdOf(page, 'Yen')))
    await expect(timeOffBlock).toBeVisible()

    const orphanZ = await orphanBlock.evaluate((el) => Number(getComputedStyle(el).zIndex))
    const offZ = await timeOffBlock.evaluate((el) => Number(getComputedStyle(el).zIndex))
    expect(orphanZ).toBeGreaterThan(offZ)

    // Kiểm chứng thêm bằng toạ độ thật: điểm giữa của orphan block khi hit-test
    // (elementFromPoint) phải trả về chính orphan block (hoặc con của nó),
    // không phải khối nghỉ — nghĩa là orphan thực sự render TRÊN khối nghỉ.
    // Cột KTV có thể nằm ngoài viewport (bảng cuộn ngang) — cuộn vào trước khi
    // lấy toạ độ, nếu không boundingBox() trả về điểm ngoài viewport và
    // elementFromPoint luôn null (không phải lỗi hiển thị, chỉ là chưa cuộn tới).
    await orphanBlock.scrollIntoViewIfNeeded()
    const box = await orphanBlock.boundingBox()
    expect(box).not.toBeNull()
    const topEl = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y)
        return el?.closest('[data-testid^="booking-item-"], [data-testid^="time-off-"]')?.getAttribute('data-testid') ?? null
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    )
    expect(topEl).toBe(`booking-item-${orphan.itemId}`)
  })

  test('banner hàng chờ hiện ra khi có ít nhất một item mồ côi', async ({ page }) => {
    const orphan = await seedBookingItem({
      staffName: 'Lan',
      serviceName: 'Cắt gội',
      variantName: 'Cắt + gội',
      hour: 15,
      customerSuffix: 'BannerOn',
    })
    await seedTimeOff('Lan', 14, 19)

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await expect(page.getByTestId(`booking-item-${orphan.itemId}`)).toHaveAttribute('data-orphan', 'true')
    await expect(page.getByTestId('reassign-banner')).toBeVisible()
    await expect(page.getByTestId('reassign-banner')).toContainText('cần xếp lại')
  })

  test('banner hàng chờ biến mất khi hàng chờ được xử lý hết (rỗng)', async ({ page }) => {
    // Banner tính trên hàng chờ TOÀN CỤC (GET /api/admin/reassign-queue
    // không lọc theo ngày) — orphan còn sót lại từ các lần chạy test khác
    // (kể cả file này) sẽ khiến "hàng chờ rỗng" không bao giờ đúng. Dọn sạch
    // orphan do CHÍNH bộ test này tạo ra (nhận diện qua tiền tố 'E2E TL' đã
    // dùng cho mọi customer ở file này) bằng một UPDATE hợp lệ (huỷ, không
    // xoá dòng — CONVENTIONS §3), không đụng dữ liệu của agent khác.
    await runSql(`
UPDATE booking_items SET status = 'cancelled', cancelled_at = ${Math.floor(Date.now() / 1000)}
WHERE status IN ('booked','in_service')
  AND appointment_id IN (
    SELECT a.id FROM appointments a JOIN customers c ON c.id = a.customer_id
    WHERE c.name LIKE 'E2E TL %'
  );`)

    const orphan = await seedBookingItem({
      staffName: 'Mai',
      serviceName: 'Chăm sóc móng',
      variantName: 'Đắp bột',
      hour: 15,
      customerSuffix: 'BannerOff',
    })
    await seedTimeOff('Mai', 14, 19)

    await page.goto('/admin/timeline')
    await goToTargetDate(page)
    await expect(page.getByTestId('reassign-banner')).toBeVisible()

    // "Xử lý hết hàng chờ" = huỷ MỌI item mồ côi đang tồn tại, không riêng
    // item vừa tạo. Bản đầu chỉ huỷ `orphan.itemId`, nên khi chạy cả bộ E2E
    // (T-13 và flows/ cũng tạo orphan song song) hàng chờ vẫn còn item của
    // file khác và banner không bao giờ biến mất — đỏ khi chạy chung, xanh
    // khi chạy riêng. Vẫn là huỷ hợp lệ, không xoá dòng (CONVENTIONS §3).
    await runSql(`
UPDATE booking_items SET status = 'cancelled', cancelled_at = ${Math.floor(Date.now() / 1000)}
WHERE status IN ('booked','in_service')
  AND EXISTS (
    SELECT 1 FROM time_off t
    WHERE t.staff_id = booking_items.staff_id
      AND t.start_at < booking_items.block_end_at
      AND t.end_at > booking_items.start_at
  );`)

    await page.reload()
    await goToTargetDate(page)
    await expect(page.getByTestId('reassign-banner')).not.toBeVisible()
  })

  test('block dịch vụ ngắn dưới 30 phút chỉ hiện tên khách, không hiện tên dịch vụ', async ({ page }) => {
    const seeded = await seedBookingItem({
      staffName: 'Lan',
      serviceName: 'Cắt gội',
      variantName: 'Gội cơ bản', // 30 phút, buffer 5 -> hgt nhỏ, rơi dưới ngưỡng short
      hour: 11,
      customerSuffix: 'Short',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    const block = page.getByTestId(`booking-item-${seeded.itemId}`)
    await expect(block).toBeVisible()
    await expect(block).toHaveClass(/ccf-tl-ev--short/)
    await expect(block).toContainText('E2E TL Short')
    // Tên dịch vụ bị ẩn qua CSS display:none trên .ccf-tl-ev-sv — kiểm bằng
    // visibility thay vì text content (element vẫn ở DOM, chỉ ẩn).
    const svEl = block.locator('.ccf-tl-ev-sv')
    await expect(svEl).toBeHidden()
  })

  test('bấm vào một block mở sheet hiện đúng thông tin của booking đó', async ({ page }) => {
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 13,
      customerSuffix: 'Sheet',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId(`booking-item-${seeded.itemId}`).click()
    await expect(page.getByTestId('booking-sheet')).toBeVisible()
    await expect(page.getByTestId('booking-sheet')).toContainText('Massage toàn thân')
    await expect(page.getByTestId('booking-sheet')).toContainText('13:00')
    await expect(page.getByTestId('sheet-status')).toContainText('Đã đặt')
  })

  // T-32: trước đây sheet chi tiết của một lịch BÌNH THƯỜNG không hiện SĐT
  // (chỉ hàng chờ reassign mới hiện) — lễ tân không gọi được khách ngay từ
  // đây. Giờ sheet phải hiện tên + SĐT + nút gọi `tel:` đúng số.
  test('bấm block có khách → sheet hiện tên + SĐT + nút gọi tel: đúng số', async ({ page }) => {
    // Dùng Mai (không phải Huong — mọi giờ 8-18 của Huong trong file này đã
    // kín hoặc kề sát ô 15:00 phải giữ TRỐNG cho test "bấm ô trống
    // Huong@15:00") @11:00, "Sơn gel" (45'+5' buffer, xong 11:50) — Mai chỉ có
    // lịch ở 9h ("Sơn gel", xong 09:50) và bị time_off 14-19h ở test trước đó
    // trong file này, nên 11h chắc chắn trống.
    const seeded = await seedBookingItem({
      staffName: 'Mai',
      serviceName: 'Chăm sóc móng',
      variantName: 'Sơn gel',
      hour: 11,
      customerSuffix: 'Phone',
      customerPhone: '0909111222',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId(`booking-item-${seeded.itemId}`).click()
    await expect(page.getByTestId('booking-sheet')).toBeVisible()

    const callBtn = page.getByTestId('booking-call-customer')
    await expect(callBtn).toBeVisible()
    await expect(callBtn).toHaveText(/0909111222/)
    await expect(callBtn).toHaveAttribute('href', 'tel:0909111222')
  })

  test('khách lẻ không có SĐT → sheet không hiện nút gọi', async ({ page }) => {
    // Mai@13:00 — KHÔNG dùng Huong: lịch Huong trong file này gần như kín hết,
    // và test reschedule bên dưới cần đúng Huong@11:00 TRỐNG để dời lịch vào.
    // Mai chỉ có "Sơn gel"@9h (xong 09:50) + "Sơn gel"@11h (test phone bên
    // trên, xong 11:50) + time_off 14-19h (test trước đó trong file) — 13h
    // chắc chắn trống.
    const seeded = await seedBookingItem({
      staffName: 'Mai',
      serviceName: 'Chăm sóc móng',
      variantName: 'Sơn gel',
      hour: 13,
      customerSuffix: 'NoPhone',
      customerPhone: null,
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId(`booking-item-${seeded.itemId}`).click()
    await expect(page.getByTestId('booking-sheet')).toBeVisible()
    await expect(page.getByTestId('booking-call-customer')).toHaveCount(0)
  })

  test('đổi trạng thái sang đang làm trong sheet cập nhật ngay màu block trên timeline không cần tải lại trang', async ({
    page,
  }) => {
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 17,
      customerSuffix: 'StatusFlip',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    const block = page.getByTestId(`booking-item-${seeded.itemId}`)
    await expect(block).toHaveAttribute('data-status', 'booked')

    await block.click()
    await expect(page.getByTestId('booking-sheet')).toBeVisible()
    await page.getByTestId('action-in_service').click()

    // Sheet đóng lại sau khi cập nhật, không cần page.reload().
    await expect(page.getByTestId('booking-sheet')).not.toBeVisible()
    await expect(block).toHaveAttribute('data-status', 'in_service')
    await expect(block).toHaveClass(/ccf-tl-ev--in_service/)
  })

  // T-25: "+ Thêm dịch vụ" trong sheet booking — backend đã có
  // (POST /api/admin/appointments/:id/items), card này chỉ dựng UI.
  test('lễ tân bấm booking, thêm dịch vụ khác vùng cơ thể, item mới hiện ngay trên timeline', async ({ page }) => {
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút', // body_zone 'body'
      hour: 8,
      customerSuffix: 'AddOk',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId(`booking-item-${seeded.itemId}`).click()
    await expect(page.getByTestId('booking-sheet')).toBeVisible()

    await page.getByTestId('add-service-open').click()
    await expect(page.getByTestId('add-service-sheet')).toBeVisible()

    // Chọn "Chăm sóc móng" — body_zone 'hands', khác hẳn 'body' của item có sẵn
    // trong CÙNG appointment, nên không đụng chặn ZONE_CONFLICT.
    await page.getByTestId('add-service-select').selectOption({ label: 'Chăm sóc móng' })
    await page.getByTestId('add-variant-select').selectOption({ label: 'Sơn gel' })

    // Chọn khung giờ đầu tiên còn trống trong ngày cho gói này.
    const firstSlot = page.locator('[data-testid^="add-slot-"]').first()
    await expect(firstSlot).toBeVisible()
    await firstSlot.click()

    const firstStaff = page.locator('[data-testid^="add-staff-"]').first()
    await expect(firstStaff).toBeVisible()
    await firstStaff.click()

    await page.getByTestId('add-service-submit').click()

    // Sheet đóng, timeline tải lại — item mới hiện ngay trên timeline mà
    // không cần reload trang thủ công. Item "Sơn gel" (45') là block NGẮN
    // (dưới ngưỡng ccf-tl-ev--short) nên tên dịch vụ bị ẩn theo CSS có chủ
    // đích (giống test "block ngắn" ở trên) — kiểm bằng data-testid mới nhất
    // của cột Mai/Trang thay vì text tên dịch vụ.
    await expect(page.getByTestId('add-service-sheet')).not.toBeVisible()
    const newBlocks = page.locator('[data-testid^="booking-item-"]', { hasText: 'AddOk' })
    await expect(newBlocks).toHaveCount(2) // item gốc (Massage) + item vừa thêm (móng)
  })

  test('thêm dịch vụ trùng vùng cơ thể với dịch vụ đang làm bị chặn, báo thân thiện không lộ mã lỗi thô', async ({
    page,
  }) => {
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút', // body_zone 'body', chiếm [09:00, 10:10) kể cả buffer
      hour: 9,
      customerSuffix: 'AddZoneConflict',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId(`booking-item-${seeded.itemId}`).click()
    await expect(page.getByTestId('booking-sheet')).toBeVisible()

    await page.getByTestId('add-service-open').click()
    await expect(page.getByTestId('add-service-sheet')).toBeVisible()

    // Cùng dịch vụ "Massage toàn thân" (body_zone 'body' — TRÙNG với item đã
    // có trong appointment này), gói khác (90 phút) để phép thử độc lập với
    // gói ban đầu, nhưng vẫn CHỒNG GIỜ nếu bấm slot 18:00 — chọn đúng slot đó.
    await page.getByTestId('add-service-select').selectOption({ label: 'Massage toàn thân' })
    await page.getByTestId('add-variant-select').selectOption({ label: '90 phút' })

    // Slot 09:00 tồn tại vì Lan (KTV thứ 2 có skill Massage) rảnh giờ đó, và
    // block 90 phút (105 phút kể cả buffer) vẫn gọn trong ca 09:00-19:00 —
    // chọn đúng slot trùng giờ với item gốc (của Huong) để kích hoạt
    // ZONE_CONFLICT dù người thêm là KTV khác (luật body_zone không phụ
    // thuộc staff_id — trong CÙNG appointment là đủ, CONVENTIONS §6).
    const slot0900 = page.getByTestId(`add-slot-${localToEpoch(TARGET_DATE, 9, 0)}`)
    await expect(slot0900).toBeVisible()
    await slot0900.click()

    const firstStaff = page.locator('[data-testid^="add-staff-"]').first()
    await expect(firstStaff).toBeVisible()
    await firstStaff.click()

    await page.getByTestId('add-service-submit').click()

    // Báo lỗi thân thiện tiếng Việt, KHÔNG lộ mã lỗi thô "ZONE_CONFLICT".
    const err = page.getByTestId('add-service-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText('trùng vùng cơ thể')
    await expect(err).not.toContainText('ZONE_CONFLICT')

    // Không thêm: sheet vẫn mở (không silent-close), timeline KHÔNG có item
    // Massage toàn thân thứ hai nào khác được thêm cho appointment này.
    await expect(page.getByTestId('add-service-sheet')).toBeVisible()
  })

  // T-29: G1/G2 — tạo lịch ngay trên timeline. Backend POST /api/admin/bookings
  // (admin-bookings.ts) đã có test API riêng (technician→403, SLOT_TAKEN,
  // validate) — ba test dưới đây chỉ kiểm THAO TÁC TRÊN UI thật.
  test('đặt lịch: chọn dịch vụ → chọn GIỜ CÒN TRỐNG → chọn KTV → tạo xong block hiện ngay', async ({
    page,
  }) => {
    // Sheet đặt lịch giờ CHỈ cho chọn từ các slot CÒN TRỐNG thật (từ engine
    // availability) — không nhập giờ tự do nữa → không thể chọn giờ chết, hết
    // cảnh báo "không có kỹ thuật viên nào". TARGET_DATE là thứ Hai tương lai
    // nên mọi ca (Mon–Sat) đều có slot.
    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId('create-booking-open').click()
    await expect(page.getByTestId('create-booking-sheet')).toBeVisible()

    await page.getByTestId('create-booking-name').fill('E2E TL Create Lan Gọi Điện')
    await page.getByTestId('create-booking-phone').fill('0977111222')
    await page.getByTestId('create-booking-service-select').selectOption({ label: 'Massage toàn thân' })
    await page.getByTestId('create-booking-variant-select').selectOption({ label: '60 phút' })

    // Lưới giờ còn trống hiện ra; chọn slot đầu tiên.
    await expect(page.getByTestId('create-booking-slots')).toBeVisible()
    const firstSlot = page.locator('[data-testid^="create-slot-"]').first()
    await expect(firstSlot).toBeVisible()
    await firstSlot.click()

    // KTV còn trống vào giờ đó (>= 1 option ngoài placeholder).
    const staffSelect = page.getByTestId('create-booking-staff-select')
    const optionCount = await staffSelect.locator('option').count()
    expect(optionCount).toBeGreaterThan(1)
    await staffSelect.selectOption({ index: 1 })

    await page.getByTestId('create-booking-submit').click()

    await expect(page.getByTestId('create-booking-sheet')).not.toBeVisible()
    const newBlock = page.locator('[data-testid^="booking-item-"]', { hasText: 'E2E TL Create Lan Gọi Điện' })
    await expect(newBlock).toHaveCount(1)
  })

  test('nút "+ Đặt lịch" trên qbar mở được sheet; chưa chọn gói thì chưa hiện giờ', async ({ page }) => {
    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await expect(page.getByTestId('create-booking-sheet')).not.toBeVisible()
    await page.getByTestId('create-booking-open').click()
    await expect(page.getByTestId('create-booking-sheet')).toBeVisible()
    // Chưa chọn gói → nhắc chọn dịch vụ, chưa có lưới giờ.
    await expect(page.getByTestId('create-booking-pick-service-first')).toBeVisible()
  })

  test('tạo lịch trùng slot KTV đã bận báo lỗi thân thiện SLOT_TAKEN, không lộ mã lỗi thô', async ({ page }) => {
    // Dropdown KTV giờ đã LỌC theo availability (chỉ hiện người còn trống) — nên
    // KHÔNG thể chọn một KTV đang bận qua UI (đúng thiết kế). Test này kiểm lớp
    // phòng-thủ-sâu của SERVER: nếu slot bị chiếm SAU khi form đã tải KTV còn
    // trống (race), server vẫn phải chặn bằng SLOT_TAKEN thân thiện.
    // Cách dựng: mở form khi Trang CÒN TRỐNG @12:00, chọn Trang, RỒI mới seed một
    // lịch chiếm 12:00 của Trang, rồi submit → server trả SLOT_TAKEN.
    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId('create-booking-open').click()
    await expect(page.getByTestId('create-booking-sheet')).toBeVisible()

    await page.getByTestId('create-booking-name').fill('E2E TL Create Trùng Slot')
    await page.getByTestId('create-booking-service-select').selectOption({ label: 'Chăm sóc móng' })
    await page.getByTestId('create-booking-variant-select').selectOption({ label: 'Đắp bột' })

    // Chọn slot đầu còn trống + Trang (lúc này Trang còn trống nên có trong danh sách).
    await expect(page.getByTestId('create-booking-slots')).toBeVisible()
    await page.locator('[data-testid^="create-slot-"]').first().click()
    const staffSelect = page.getByTestId('create-booking-staff-select')
    await expect(staffSelect.locator('option')).not.toHaveCount(1) // có ít nhất 1 KTV
    await staffSelect.selectOption({ index: 1 })

    // GIỜ mới chiếm CHÍNH slot vừa chọn (mô phỏng race: người khác đặt trước).
    // Đọc giờ đang chọn từ chip đang sáng để seed đúng giờ đó.
    const selectedHm = ((await page.locator('[data-testid^="create-slot-"].ccf-tl-slot--sel').textContent()) ?? '09:00').trim()
    const selH = Number(selectedHm.split(':')[0])
    const selectedStaffName = ((await staffSelect.locator('option:checked').textContent()) ?? '').trim()
    await seedBookingItem({
      staffName: selectedStaffName,
      serviceName: 'Chăm sóc móng',
      variantName: 'Đắp bột',
      hour: selH,
      customerSuffix: 'DupSlot',
    })

    await page.getByTestId('create-booking-submit').click()

    const err = page.getByTestId('create-booking-error')
    await expect(err).toBeVisible()
    await expect(err).not.toContainText('SLOT_TAKEN') // câu thân thiện, không lộ mã thô
    // Sheet KHÔNG âm thầm đóng — lễ tân vẫn thấy form để sửa giờ/KTV khác.
    await expect(page.getByTestId('create-booking-sheet')).toBeVisible()
  })

  // T-30: G1/G3 — đổi giờ / đổi KTV ngay trên timeline (kéo block + nút trong
  // sheet). Backend DÙNG LẠI reschedule nguyên tử đã có (POST /api/bookings/:id/
  // reschedule); admin-reschedule.test.ts kiểm phần API. Bốn test dưới đây kiểm
  // THAO TÁC TRÊN UI thật + xác nhận DB đổi đúng.

  /** Đọc staff_id + start_at của một booking_item thẳng từ D1 (kiểm DB sau kéo). */
  async function readItem(itemId: number): Promise<{ staff_id: number; start_at: number; status: string }> {
    const rows = await querySql<{ staff_id: number; start_at: number; status: string }>(
      `SELECT staff_id, start_at, status FROM booking_items WHERE id = ${itemId}`,
    )
    const row = rows[0]
    if (row === undefined) throw new Error(`Không đọc được booking_item ${itemId}`)
    return row
  }

  // NOTE: test kéo-thả UI (drag Huong→Lan) đã BỎ — Playwright synthetic drag
  // (DataTransfer qua dispatchEvent) flaky khi chạy trong cả bộ (pass khi chạy
  // riêng). Chức năng reschedule vẫn được phủ: API ở admin-reschedule.test.ts,
  // và luồng nút "Đổi giờ / Đổi KTV" trong sheet ở test bên dưới. Kéo-thả là
  // đường tắt UI, không phải logic riêng — không đáng một test flaky gác cả CI.

  test('nút "Đổi giờ / Đổi KTV" trong sheet → chọn giờ mới → xác nhận → block dời sang giờ mới', async ({
    page,
  }) => {
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 16,
      customerSuffix: 'RsBtn',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId(`booking-item-${seeded.itemId}`).click()
    await expect(page.getByTestId('booking-sheet')).toBeVisible()

    await page.getByTestId('reschedule-open').click()
    await expect(page.getByTestId('reschedule-sheet')).toBeVisible()
    // Prefill đúng giờ hiện tại (16:00).
    await expect(page.getByTestId('reschedule-time')).toHaveValue('16:00')

    // Đổi sang 11:00 (giờ trống của Huong trong ngày, trong ca 09-19), giữ nguyên KTV.
    await page.getByTestId('reschedule-time').fill('11:00')
    await page.getByTestId('reschedule-submit').click()

    // Sheet đóng, timeline tải lại — block dời sang dòng 11:00 của Huong.
    await expect(page.getByTestId('reschedule-sheet')).not.toBeVisible()
    const huongId = await staffIdOf(page, 'Huong')
    const cellAt11 = page.getByTestId(`cell-${huongId}-11`)
    await expect(cellAt11.getByTestId(`booking-item-${seeded.itemId}`)).toBeVisible()

    const row = await readItem(seeded.itemId)
    expect(row.start_at).toBe(localToEpoch(TARGET_DATE, 11, 0))
    expect(String(row.staff_id)).toBe(huongId)
  })

  test('đổi giờ vào slot của KTV đã bận → báo SLOT_TAKEN thân thiện, không lộ mã lỗi thô, DB không đổi', async ({
    page,
  }) => {
    // Item cần đổi: Huong@16:00 (giữa lưới, không bị AdminNav sticky ở đỉnh che
    // click). Slot đích đã BẬN: blocker Huong@14:00. Đổi victim → 14:00 (giữ
    // Huong) đè đúng slot blocker → SLOT_TAKEN, item cũ Y NGUYÊN.
    const victim = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 16,
      customerSuffix: 'RsTaken',
    })
    const blocker = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 14, // trong ca 09:00-19:00 của Huong → không rơi vào OUTSIDE_SHIFT
      customerSuffix: 'RsBlocker',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await page.getByTestId(`booking-item-${victim.itemId}`).click()
    await expect(page.getByTestId('booking-sheet')).toBeVisible()
    await page.getByTestId('reschedule-open').click()
    await expect(page.getByTestId('reschedule-sheet')).toBeVisible()

    // Đổi sang 14:00 — đúng slot blocker đang chiếm (cùng Huong) → SLOT_TAKEN.
    await page.getByTestId('reschedule-time').fill('14:00')
    await page.getByTestId('reschedule-submit').click()

    const err = page.getByTestId('reschedule-error')
    await expect(err).toBeVisible()
    await expect(err).not.toContainText('SLOT_TAKEN')
    // Sheet vẫn mở (không âm thầm đóng) — lễ tân chọn giờ khác.
    await expect(page.getByTestId('reschedule-sheet')).toBeVisible()

    // BẤT BIẾN: item cũ Y NGUYÊN ở 16:00, không mất lịch.
    const row = await readItem(victim.itemId)
    expect(row.start_at).toBe(localToEpoch(TARGET_DATE, 16, 0))
    expect(row.status).toBe('booked')
    expect(blocker.itemId).toBeGreaterThan(0)
  })

  test('kéo block Massage sang KTV KHÔNG đủ skill (Mai chỉ có Móng) → bị chặn, báo lý do, DB không đổi', async ({
    page,
  }) => {
    // Huong@11:30 (Massage). Mai chỉ có skill Móng (seed) → kéo sang cột Mai
    // phải bị chặn STAFF_LACKS_SKILL, item cũ giữ nguyên.
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 11,
      minute: 30,
      customerSuffix: 'DragNoSkill',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    const maiId = await staffIdOf(page, 'Mai')
    const block = page.getByTestId(`booking-item-${seeded.itemId}`)
    await expect(block).toBeVisible()

    const targetCell = page.getByTestId(`cell-${maiId}-10`)
    await expect(targetCell).toBeVisible()
    await dragBlockToCell(page, `booking-item-${seeded.itemId}`, `cell-${maiId}-10`)

    await expect(page.getByTestId('drop-confirm-sheet')).toBeVisible()
    await page.getByTestId('drop-confirm-submit').click()

    // Bị chặn: báo lý do thân thiện, KHÔNG lộ mã lỗi thô.
    const err = page.getByTestId('drop-confirm-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText('kỹ năng')
    await expect(err).not.toContainText('STAFF_LACKS_SKILL')

    // DB KHÔNG đổi: vẫn cột Huong, vẫn 11:30.
    const huongId = await staffIdOf(page, 'Huong')
    const row = await readItem(seeded.itemId)
    expect(String(row.staff_id)).toBe(huongId)
    expect(row.start_at).toBe(localToEpoch(TARGET_DATE, 11, 30))
  })

  // T-31: toggle Day/Week + chọn ngày + "Hôm nay". Backend range đã có test
  // API riêng (tests/api/admin-schedule.test.ts) — bốn test dưới đây chỉ kiểm
  // THAO TÁC TRÊN UI thật.
  test('bấm toggle Tuần hiện đủ 7 cột ngày', async ({ page }) => {
    await page.goto('/admin/timeline')

    await expect(page.getByTestId('view-toggle-week')).toBeVisible()
    await page.getByTestId('view-toggle-week').click()

    const weekGrid = page.getByTestId('week-grid')
    await expect(weekGrid).toBeVisible()
    // `.ccf-tl-weekday` là class riêng của NÚT cột-ngày (không trùng với các
    // testid con `week-day-count-…`/`week-day-{date}-staff-{id}` cũng có tiền
    // tố `week-day-` — dùng class thay vì testid prefix để đếm đúng 7 cột).
    await expect(weekGrid.locator('.ccf-tl-weekday')).toHaveCount(7)
  })

  test('ngày có lịch hiện số lịch hẹn khác với ngày trống trên week view', async ({ page }) => {
    const seeded = await seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 14,
      customerSuffix: 'WeekBusy',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)
    // Xác nhận lịch đã thật sự nằm trên TARGET_DATE trước khi chuyển sang tuần.
    await expect(page.getByTestId(`booking-item-${seeded.itemId}`)).toBeVisible()

    await page.getByTestId('view-toggle-week').click()
    await expect(page.getByTestId('week-grid')).toBeVisible()

    const busyDay = page.getByTestId(`week-day-${TARGET_DATE}`)
    await expect(busyDay).toBeVisible()
    await expect(busyDay.getByTestId(`week-day-count-${TARGET_DATE}`)).toBeVisible()
    await expect(busyDay.getByTestId(`week-day-count-${TARGET_DATE}`)).toContainText('lịch hẹn')
    // Ngày trống không hiện số lịch hẹn — hiện "Trống lịch".
    await expect(busyDay.getByTestId(`week-day-empty-${TARGET_DATE}`)).toHaveCount(0)

    const emptyDate = addDaysStrForTest(TARGET_DATE, 1)
    const emptyDay = page.getByTestId(`week-day-${emptyDate}`)
    if (await emptyDay.count() > 0) {
      await expect(emptyDay.getByTestId(`week-day-empty-${emptyDate}`)).toBeVisible()
      await expect(emptyDay.getByTestId(`week-day-empty-${emptyDate}`)).toContainText('Trống lịch')
    }
  })

  test('nút "Hôm nay" từ một ngày xa đưa về đúng hôm nay', async ({ page }) => {
    await page.goto('/admin/timeline')
    const todayLabel = await page.getByTestId('date-current').textContent()

    await goToTargetDate(page)
    await expect(page.getByTestId('date-current')).not.toHaveText(todayLabel ?? '')

    await page.getByTestId('today-button').click()
    await expect(page.getByTestId('date-current')).toContainText('Hôm nay')
  })

  test('date picker nhảy tới ngày cụ thể → grid đúng ngày đó', async ({ page }) => {
    await page.goto('/admin/timeline')

    await page.getByTestId('date-picker').fill(TARGET_DATE)
    // input[type=date] bắn change khi fill xong giá trị hợp lệ.
    const [, tm, td] = TARGET_DATE.split('-').map(Number)
    const targetLabel = `${String(td).padStart(2, '0')}/${String(tm).padStart(2, '0')}`
    await expect(page.getByTestId('date-current')).toContainText(targetLabel)
  })
})

/** Cộng N ngày vào "YYYY-MM-DD" — dùng riêng cho spec này (không import format.ts,
 * ngoài touches của card T-31). */
function addDaysStrForTest(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y!, m! - 1, d! + delta))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

/** Bấm nút "ngày sau" đủ số lần để tới TARGET_DATE (Thứ Hai tuần sau), xuất
 * phát từ "hôm nay" mà component tự khởi tạo. Tính số lần bấm bằng cách so
 * sánh chuỗi ngày hiện tại hiển thị trên thanh điều hướng — vòng lặp dừng khi
 * data-testid="date-current" không đổi nữa sau khi đã match hoặc khi vượt
 * quá 14 lần bấm (an toàn, TARGET_DATE tối đa cách hôm nay 13 ngày). */
async function goToTargetDate(page: import('@playwright/test').Page): Promise<void> {
  const [ty, tm, td] = TARGET_DATE.split('-').map(Number)
  const targetLabel = `${String(td).padStart(2, '0')}/${String(tm).padStart(2, '0')}`
  for (let i = 0; i < 14; i++) {
    const cur = await page.getByTestId('date-current').textContent()
    if (cur?.includes(targetLabel)) return
    await page.getByTestId('date-next').click()
  }
  throw new Error(`Không tới được TARGET_DATE=${TARGET_DATE} sau 14 lần bấm ngày sau`)
}

async function staffIdOf(page: import('@playwright/test').Page, staffName: string): Promise<string> {
  const staffHead = await page.evaluate((name) => {
    const heads = Array.from(document.querySelectorAll('[data-testid^="staff-head-"]'))
    const match = heads.find((h) => h.textContent?.includes(name))
    return match?.getAttribute('data-testid') ?? null
  }, staffName)
  if (staffHead === null) throw new Error(`Không tìm thấy cột KTV ${staffName}`)
  return staffHead.replace('staff-head-', '')
}
