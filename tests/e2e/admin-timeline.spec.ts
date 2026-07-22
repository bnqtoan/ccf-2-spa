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
}): SeededItem {
  const { staffName, serviceName, variantName, hour, status = 'booked', source = 'online', customerSuffix } = opts
  const minute = opts.minute ?? 0
  const startAt = localToEpoch(TARGET_DATE, hour, minute)
  const nowSec = Math.floor(Date.now() / 1000)
  const custName = `E2E TL ${customerSuffix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`

  runSql(`
INSERT INTO customers (name, phone) VALUES ('${custName}', NULL);
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
})

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
