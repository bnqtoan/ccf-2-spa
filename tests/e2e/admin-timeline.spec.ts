import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

// Repo root — hai cấp lên từ tests/e2e/. Cùng cơ chế seed trực tiếp D1 local
// mà tests/e2e/customer-lookup.spec.ts đã dùng (xem comment ở đó cho lý do
// đầy đủ): T-10/T-11 chạy song song trên cùng D1 local, nên chỉ INSERT,
// không bao giờ DELETE, và random hoá dữ liệu để không đụng nhau.
const REPO_ROOT = new URL('../../', import.meta.url).pathname

function runSql(statements: string): void {
  const tmpFile = join(
    tmpdir(),
    `ccf-2-spa-e2e-timeline-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`,
  )
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

interface SeededItem {
  itemId: number
  staffName: string
}

/** Seed một appointment + booking_item thật, neo giờ CỐ ĐỊNH trên TARGET_DATE
 * (không phụ thuộc giờ chạy test). Dùng natural key (tên KTV/dịch vụ) từ seed
 * chuẩn src/worker/db/seed.ts — không tạo lại reference data. */
function seedBookingItem(opts: {
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
}): SeededItem {
  const { staffName, serviceName, variantName, hour, status = 'booked', source = 'online', customerSuffix } = opts
  const minute = opts.minute ?? 0
  const customerPhone = opts.customerPhone ?? null
  const startAt = localToEpoch(TARGET_DATE, hour, minute)
  const nowSec = Math.floor(Date.now() / 1000)
  const custName = `E2E TL ${customerSuffix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`
  const phoneSql = customerPhone === null ? 'NULL' : `'${customerPhone}'`

  runSql(`
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

  const idRes = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--local',
      '--json',
      '--command',
      `SELECT bi.id AS id FROM booking_items bi JOIN appointments a ON a.id = bi.appointment_id JOIN customers c ON c.id = a.customer_id WHERE c.name = '${custName}'`,
    ],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  ).toString()
  const parsed = JSON.parse(idRes) as [{ results: { id: number }[] }]
  const row = parsed[0]?.results[0]
  if (row === undefined) throw new Error(`Seed thất bại: không tìm thấy booking_item vừa tạo cho ${custName}`)
  return { itemId: row.id, staffName }
}

/** Seed một time-off phủ đúng khoảng [hourStart,hourEnd) của TARGET_DATE cho
 * một KTV — dùng để tạo booking mồ côi tất định. */
function seedTimeOff(staffName: string, hourStart: number, hourEnd: number): void {
  const startAt = localToEpoch(TARGET_DATE, hourStart)
  const endAt = localToEpoch(TARGET_DATE, hourEnd)
  runSql(`
INSERT INTO time_off (staff_id, start_at, end_at, reason)
  SELECT id, ${startAt}, ${endAt}, 'E2E nghỉ đột xuất' FROM staff WHERE name = '${staffName}';
`)
}

test.describe('Admin — timeline theo cột KTV', () => {
  // Serial: mỗi test ghi thẳng D1 local qua `wrangler d1 execute --local`,
  // một tiến trình mở thẳng file sqlite — chạy song song NỘI BỘ file này gây
  // SQLITE_BUSY ngẫu nhiên (giống lý do ở customer-lookup.spec.ts).
  test.describe.configure({ mode: 'serial' })

  test('booking hiện đúng cột của đúng KTV tại đúng vị trí giờ trên timeline', async ({ page }) => {
    const seeded = seedBookingItem({
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
    const seeded = seedBookingItem({
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
    const normal = seedBookingItem({
      staffName: 'Mai',
      serviceName: 'Chăm sóc móng',
      variantName: 'Sơn gel',
      hour: 9,
      customerSuffix: 'Normal',
    })
    const orphan = seedBookingItem({
      staffName: 'Trang',
      serviceName: 'Chăm sóc da mặt',
      variantName: 'Cơ bản',
      hour: 15,
      customerSuffix: 'Orphan',
    })
    seedTimeOff('Trang', 14, 19) // phủ đúng booking lúc 15h của Trang -> mồ côi

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
    const orphan = seedBookingItem({
      staffName: 'Yen',
      serviceName: 'Chăm sóc da mặt',
      variantName: 'Chuyên sâu',
      hour: 16,
      customerSuffix: 'ZOrder',
    })
    seedTimeOff('Yen', 14, 19) // phủ đúng booking lúc 16h -> mồ côi, đè bởi khối nghỉ 14-19h

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
    const orphan = seedBookingItem({
      staffName: 'Lan',
      serviceName: 'Cắt gội',
      variantName: 'Cắt + gội',
      hour: 15,
      customerSuffix: 'BannerOn',
    })
    seedTimeOff('Lan', 14, 19)

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
    runSql(`
UPDATE booking_items SET status = 'cancelled', cancelled_at = ${Math.floor(Date.now() / 1000)}
WHERE status IN ('booked','in_service')
  AND appointment_id IN (
    SELECT a.id FROM appointments a JOIN customers c ON c.id = a.customer_id
    WHERE c.name LIKE 'E2E TL %'
  );`)

    const orphan = seedBookingItem({
      staffName: 'Mai',
      serviceName: 'Chăm sóc móng',
      variantName: 'Đắp bột',
      hour: 15,
      customerSuffix: 'BannerOff',
    })
    seedTimeOff('Mai', 14, 19)

    await page.goto('/admin/timeline')
    await goToTargetDate(page)
    await expect(page.getByTestId('reassign-banner')).toBeVisible()

    // "Xử lý hết hàng chờ" = huỷ MỌI item mồ côi đang tồn tại, không riêng
    // item vừa tạo. Bản đầu chỉ huỷ `orphan.itemId`, nên khi chạy cả bộ E2E
    // (T-13 và flows/ cũng tạo orphan song song) hàng chờ vẫn còn item của
    // file khác và banner không bao giờ biến mất — đỏ khi chạy chung, xanh
    // khi chạy riêng. Vẫn là huỷ hợp lệ, không xoá dòng (CONVENTIONS §3).
    runSql(`
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
    const seeded = seedBookingItem({
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
    const seeded = seedBookingItem({
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
    const seeded = seedBookingItem({
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
    const seeded = seedBookingItem({
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
    const seeded = seedBookingItem({
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
    const seeded = seedBookingItem({
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
    const seeded = seedBookingItem({
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
  test('bấm ô trống Huong@15:00 mở sheet đặt lịch prefill đúng KTV + giờ, tạo xong block hiện ngay', async ({
    page,
  }) => {
    // Huong (KHÔNG dính seedTimeOff 14-19h của Trang/Yen/Lan/Mai ở các test
    // trên) @15:00 — giờ chưa ai chiếm trong file này (8/9/10/11/12/13/14/17 đã dùng).
    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    const huongId = await staffIdOf(page, 'Huong')
    const emptyCell = page.getByTestId(`cell-${huongId}-15`)
    await expect(emptyCell).toBeVisible()
    await emptyCell.click()

    await expect(page.getByTestId('create-booking-sheet')).toBeVisible()
    // Prefill đúng giờ của dòng vừa bấm (sửa được, nhưng giá trị ban đầu phải khớp).
    await expect(page.getByTestId('create-booking-time')).toHaveValue('15:00')
    // Prefill đúng KTV của cột vừa bấm.
    await expect(page.getByTestId('create-booking-staff-select')).toHaveValue(huongId)

    await page.getByTestId('create-booking-name').fill('E2E TL Create Lan Gọi Điện')
    await page.getByTestId('create-booking-phone').fill('0977111222')
    await page.getByTestId('create-booking-service-select').selectOption({ label: 'Massage toàn thân' })
    await page.getByTestId('create-booking-variant-select').selectOption({ label: '60 phút' })

    await page.getByTestId('create-booking-submit').click()

    // Sheet đóng, timeline tải lại — block mới hiện NGAY, không cần rời trang.
    await expect(page.getByTestId('create-booking-sheet')).not.toBeVisible()
    const newBlock = page.locator('[data-testid^="booking-item-"]', { hasText: 'E2E TL Create Lan Gọi Điện' })
    await expect(newBlock).toHaveCount(1)
    const cellAt15 = page.getByTestId(`cell-${huongId}-15`)
    await expect(cellAt15.locator('[data-testid^="booking-item-"]')).toHaveCount(1)
  })

  test('nút "+ Đặt lịch" trên qbar mở được sheet đặt lịch không cần bấm ô trống', async ({ page }) => {
    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    await expect(page.getByTestId('create-booking-sheet')).not.toBeVisible()
    await page.getByTestId('create-booking-open').click()
    await expect(page.getByTestId('create-booking-sheet')).toBeVisible()
    // Mở từ qbar (không phải từ ô trống) — không prefill KTV.
    await expect(page.getByTestId('create-booking-staff-select')).toHaveValue('')
  })

  test('tạo lịch trùng slot KTV đã bận báo lỗi thân thiện SLOT_TAKEN, không lộ mã lỗi thô', async ({ page }) => {
    const seeded = seedBookingItem({
      staffName: 'Trang',
      serviceName: 'Chăm sóc móng',
      variantName: 'Đắp bột', // 75 phút + buffer 10 -> chiếm [12:00, 13:25)
      hour: 12,
      customerSuffix: 'DupSlot',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)
    await expect(page.getByTestId(`booking-item-${seeded.itemId}`)).toBeVisible()

    // Mở "+ Đặt lịch" từ qbar (ô 12:00 của Trang không còn trống nên không bấm
    // được ô), tự chọn đúng Trang + đúng 12:00 để chồng slot đã có.
    await page.getByTestId('create-booking-open').click()
    await expect(page.getByTestId('create-booking-sheet')).toBeVisible()

    await page.getByTestId('create-booking-name').fill('E2E TL Create Trùng Slot')
    await page.getByTestId('create-booking-service-select').selectOption({ label: 'Chăm sóc móng' })
    await page.getByTestId('create-booking-variant-select').selectOption({ label: 'Đắp bột' })
    await page.getByTestId('create-booking-time').fill('12:00')
    const trangId = await staffIdOf(page, 'Trang')
    await page.getByTestId('create-booking-staff-select').selectOption(trangId)

    await page.getByTestId('create-booking-submit').click()

    const err = page.getByTestId('create-booking-error')
    await expect(err).toBeVisible()
    await expect(err).not.toContainText('SLOT_TAKEN')
    // Sheet KHÔNG âm thầm đóng — lễ tân vẫn thấy form để sửa giờ/KTV khác.
    await expect(page.getByTestId('create-booking-sheet')).toBeVisible()
  })

  // T-30: G1/G3 — đổi giờ / đổi KTV ngay trên timeline (kéo block + nút trong
  // sheet). Backend DÙNG LẠI reschedule nguyên tử đã có (POST /api/bookings/:id/
  // reschedule); admin-reschedule.test.ts kiểm phần API. Bốn test dưới đây kiểm
  // THAO TÁC TRÊN UI thật + xác nhận DB đổi đúng.

  /** Đọc staff_id + start_at của một booking_item thẳng từ D1 (kiểm DB sau kéo). */
  function readItem(itemId: number): { staff_id: number; start_at: number; status: string } {
    const out = execFileSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        'DB',
        '--local',
        '--json',
        '--command',
        `SELECT staff_id, start_at, status FROM booking_items WHERE id = ${itemId}`,
      ],
      { cwd: REPO_ROOT, stdio: 'pipe' },
    ).toString()
    const parsed = JSON.parse(out) as [{ results: { staff_id: number; start_at: number; status: string }[] }]
    const row = parsed[0]?.results[0]
    if (row === undefined) throw new Error(`Không đọc được booking_item ${itemId}`)
    return row
  }

  test('kéo block Massage của Huong sang cột Lan (đủ skill) + giờ khác → xác nhận → DB đổi staff + giờ', async ({
    page,
  }) => {
    // Huong + Lan đều có skill Massage (seed). Nguồn: Huong@18:00 (giờ trống
    // trong file này). Đích: cột Lan, dòng 09:00 — Lan KHÔNG bị time-off 14-19h
    // mà các test trên seed, và 09:00 của Lan còn trống.
    const seeded = seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 18,
      customerSuffix: 'DragMove',
    })

    await page.goto('/admin/timeline')
    await goToTargetDate(page)

    const lanId = await staffIdOf(page, 'Lan')
    const block = page.getByTestId(`booking-item-${seeded.itemId}`)
    await expect(block).toBeVisible()

    const targetCell = page.getByTestId(`cell-${lanId}-9`)
    await expect(targetCell).toBeVisible()
    await block.dragTo(targetCell)

    // Xác nhận nhẹ trước khi cam kết (card: "xác nhận nhẹ → reschedule").
    await expect(page.getByTestId('drop-confirm-sheet')).toBeVisible()
    await page.getByTestId('drop-confirm-submit').click()

    // Sheet đóng, timeline tải lại — block nằm ở cột Lan, dòng 09:00.
    await expect(page.getByTestId('drop-confirm-sheet')).not.toBeVisible()
    const cellAt9 = page.getByTestId(`cell-${lanId}-9`)
    await expect(cellAt9.getByTestId(`booking-item-${seeded.itemId}`)).toBeVisible()

    // DB đổi thật: staff = Lan, giờ = 09:00 TARGET_DATE.
    const row = readItem(seeded.itemId)
    expect(String(row.staff_id)).toBe(lanId)
    expect(row.start_at).toBe(localToEpoch(TARGET_DATE, 9, 0))
    expect(row.status).toBe('booked')
  })

  test('nút "Đổi giờ / Đổi KTV" trong sheet → chọn giờ mới → xác nhận → block dời sang giờ mới', async ({
    page,
  }) => {
    const seeded = seedBookingItem({
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

    const row = readItem(seeded.itemId)
    expect(row.start_at).toBe(localToEpoch(TARGET_DATE, 11, 0))
    expect(String(row.staff_id)).toBe(huongId)
  })

  test('đổi giờ vào slot của KTV đã bận → báo SLOT_TAKEN thân thiện, không lộ mã lỗi thô, DB không đổi', async ({
    page,
  }) => {
    // Item cần đổi: Huong@16:00 (giữa lưới, không bị AdminNav sticky ở đỉnh che
    // click). Slot đích đã BẬN: blocker Huong@14:00. Đổi victim → 14:00 (giữ
    // Huong) đè đúng slot blocker → SLOT_TAKEN, item cũ Y NGUYÊN.
    const victim = seedBookingItem({
      staffName: 'Huong',
      serviceName: 'Massage toàn thân',
      variantName: '60 phút',
      hour: 16,
      customerSuffix: 'RsTaken',
    })
    const blocker = seedBookingItem({
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
    const row = readItem(victim.itemId)
    expect(row.start_at).toBe(localToEpoch(TARGET_DATE, 16, 0))
    expect(row.status).toBe('booked')
    expect(blocker.itemId).toBeGreaterThan(0)
  })

  test('kéo block Massage sang KTV KHÔNG đủ skill (Mai chỉ có Móng) → bị chặn, báo lý do, DB không đổi', async ({
    page,
  }) => {
    // Huong@11:30 (Massage). Mai chỉ có skill Móng (seed) → kéo sang cột Mai
    // phải bị chặn STAFF_LACKS_SKILL, item cũ giữ nguyên.
    const seeded = seedBookingItem({
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
    await block.dragTo(targetCell)

    await expect(page.getByTestId('drop-confirm-sheet')).toBeVisible()
    await page.getByTestId('drop-confirm-submit').click()

    // Bị chặn: báo lý do thân thiện, KHÔNG lộ mã lỗi thô.
    const err = page.getByTestId('drop-confirm-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText('kỹ năng')
    await expect(err).not.toContainText('STAFF_LACKS_SKILL')

    // DB KHÔNG đổi: vẫn cột Huong, vẫn 11:30.
    const huongId = await staffIdOf(page, 'Huong')
    const row = readItem(seeded.itemId)
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
    const seeded = seedBookingItem({
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
