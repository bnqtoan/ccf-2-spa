import { test, expect, type Page } from '@playwright/test'

// Luồng khách đặt lịch (T-10) — service list → variant → date/time → confirm
// → done, trên app thật (Worker + D1 thật, không mock).
//
// DỮ LIỆU TẤT ĐỊNH: mỗi test tự tạo skill/staff/service/variant/shift RIÊNG
// qua `/api/admin/*` (đã có sẵn, xem src/worker/routes/admin-crud.ts) thay vì
// dựa vào seed dùng chung — hai agent khác (T-11, T-12) đang chạy song song
// trên cùng D1 local, và `npm run db:seed:local` XOÁ SẠCH bảng trước khi
// insert (thấy trong src/worker/db/seed.ts) nên không được gọi giữa chừng.
// Tên riêng theo timestamp+random tránh trùng giữa các lần chạy/test song song
// (Playwright fullyParallel).
//
// Ca làm việc tạo cho CẢ 7 ngày trong tuần (weekday 0..6), 00:00–23:59 giờ địa
// phương, để test không phụ thuộc "hôm nay" rơi vào thứ mấy — tự chủ hoàn
// toàn với giờ chạy thật.

interface Fixture {
  serviceId: number
  serviceName: string
  variantId: number
  variantName: string
  variantPrice: number
  durationMin: number
  bufferMin: number
  staffId: number
  staffName: string
}

async function createFixture(
  request: Page['request'],
  opts: { durationMin?: number; bufferMin?: number; price?: number } = {},
): Promise<Fixture> {
  const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
  const skillName = `E2EBookSkill-${tag}`
  const staffName = `E2EBookStaff-${tag}`
  const serviceName = `E2EBookService-${tag}`
  const variantName = `E2EBookVariant-${tag}`
  const durationMin = opts.durationMin ?? 45
  const bufferMin = opts.bufferMin ?? 10
  const price = opts.price ?? 199000

  const skillRes = await request.post('/api/admin/skills', { data: { name: skillName } })
  const skill = (await skillRes.json()) as { id: number }

  const staffRes = await request.post('/api/admin/staff', { data: { name: staffName, phone: null } })
  const staff = (await staffRes.json()) as { id: number }

  await request.post(`/api/admin/staff/${staff.id}/skills`, { data: { skill_id: skill.id } })

  const serviceRes = await request.post('/api/admin/services', {
    data: { name: serviceName, skill_id: skill.id, body_zone: 'body' },
  })
  const service = (await serviceRes.json()) as { id: number }

  const variantRes = await request.post('/api/admin/variants', {
    data: {
      service_id: service.id,
      name: variantName,
      duration_min: durationMin,
      buffer_after_min: bufferMin,
      price,
    },
  })
  const variant = (await variantRes.json()) as { id: number }

  // Cả 7 ngày trong tuần, gần như trọn ngày — test không phụ thuộc "hôm nay"
  // rơi vào thứ mấy hay giờ chạy CI.
  for (let weekday = 0; weekday <= 6; weekday++) {
    await request.post('/api/admin/shifts', {
      data: { staff_id: staff.id, weekday, start_min: 0, end_min: 1439 },
    })
  }

  return {
    serviceId: service.id,
    serviceName,
    variantId: variant.id,
    variantName,
    variantPrice: price,
    durationMin,
    bufferMin,
    staffId: staff.id,
    staffName,
  }
}

/** Random SĐT VN hợp lệ (10 số, bắt đầu 09) — mỗi test một số riêng để không lẫn dữ liệu. */
function randomPhone(): string {
  return `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
}

/** Đi từ màn service list tới màn chọn ngày giờ, đã chọn đúng service+variant của fixture. */
async function goToTimeScreen(page: Page, fx: Fixture) {
  await page.goto('/')
  await page.getByTestId(`service-${fx.serviceId}`).click()
  await page.getByTestId(`variant-${fx.variantId}`).click()
  await expect(page.getByTestId('variant-continue')).toBeEnabled()
  await page.getByTestId('variant-continue').click()
}

/** Bấm ngày đầu tiên có slot (thử tối đa 14 ngày cuộn ngang) rồi bấm slot đầu tiên xuất hiện. */
async function pickFirstAvailableSlot(page: Page): Promise<void> {
  const dateButtons = page.locator('.ccf-bk-date')
  const count = await dateButtons.count()
  for (let i = 0; i < count; i++) {
    await dateButtons.nth(i).click()
    const empty = page.getByTestId('time-empty')
    const anySlot = page.locator('.ccf-bk-slot').first()
    // Chờ 1 trong 2: hoặc rỗng, hoặc có slot — tránh race giữa render và fetch.
    await Promise.race([
      empty.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
      anySlot.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
    ])
    if (await anySlot.isVisible().catch(() => false)) {
      await anySlot.click()
      return
    }
  }
  throw new Error('Không tìm thấy ngày nào còn slot trong 14 ngày tới — fixture có vấn đề')
}

test.describe('Luồng khách đặt lịch', () => {
  test('đi hết luồng chọn dịch vụ, gói, ngày, giờ, nhập tên SĐT và xác nhận thì tạo được lịch thật (201) và thấy màn thành công', async ({
    page,
    request,
  }) => {
    const fx = await createFixture(request)
    const phone = randomPhone()

    await goToTimeScreen(page, fx)
    await pickFirstAvailableSlot(page)

    // "Để spa sắp xếp" mặc định — đủ để bấm Tiếp tục.
    await expect(page.getByTestId('time-continue')).toBeEnabled()
    await page.getByTestId('time-continue').click()

    await page.getByTestId('confirm-name').fill('Nguyễn Thu Hà')
    await page.getByTestId('confirm-phone').fill(phone)
    await expect(page.getByTestId('confirm-submit')).toBeEnabled()
    await page.getByTestId('confirm-submit').click()

    await expect(page.getByTestId('booking-code')).toBeVisible()

    // Định nghĩa "xong" của card: kiểm tra dữ liệu THẬT đã ghi qua
    // GET /api/bookings?phone=, không chỉ tin chữ "thành công" trên UI.
    const res = await request.get(`/api/bookings?phone=${encodeURIComponent(phone)}`)
    expect(res.ok()).toBe(true)
    const body = (await res.json()) as { bookings: Array<{ variant_name: string; status: string }> }
    expect(body.bookings).toHaveLength(1)
    const booking = body.bookings[0]
    expect(booking).toBeDefined()
    expect(booking!.variant_name).toBe(fx.variantName)
    expect(booking!.status).toBe('booked')
  })

  test('nút Tiếp tục ở màn chọn gói bị khoá khi chưa chọn gói nào', async ({ page, request }) => {
    const fx = await createFixture(request)

    await page.goto('/')
    await page.getByTestId(`service-${fx.serviceId}`).click()
    await expect(page.getByTestId('variant-continue')).toBeDisabled()

    await page.getByTestId(`variant-${fx.variantId}`).click()
    await expect(page.getByTestId('variant-continue')).toBeEnabled()
  })

  test('nút Tiếp tục ở màn chọn giờ bị khoá khi chưa chọn đủ ngày và giờ', async ({ page, request }) => {
    const fx = await createFixture(request)

    await goToTimeScreen(page, fx)
    await expect(page.getByTestId('time-continue')).toBeDisabled()

    await pickFirstAvailableSlot(page)
    // Slot đã chọn nhưng CHƯA chọn KTV cụ thể lẫn "Để spa sắp xếp" một cách
    // tường minh — theo state machine của BookingPage, nút vẫn khoá tới khi
    // khách chọn "Để spa sắp xếp" hoặc một KTV. Bấm nút Để spa sắp xếp để mở khoá.
    await page.getByTestId('staff-auto').click()
    await expect(page.getByTestId('time-continue')).toBeEnabled()
  })

  test('nút Xác nhận đặt lịch bị khoá khi chưa nhập tên hoặc SĐT hợp lệ', async ({ page, request }) => {
    const fx = await createFixture(request)

    await goToTimeScreen(page, fx)
    await pickFirstAvailableSlot(page)
    await page.getByTestId('staff-auto').click()
    await page.getByTestId('time-continue').click()

    await expect(page.getByTestId('confirm-submit')).toBeDisabled()

    await page.getByTestId('confirm-name').fill('A') // 1 ký tự — chưa đủ hợp lệ
    await expect(page.getByTestId('confirm-submit')).toBeDisabled()

    await page.getByTestId('confirm-name').fill('Trần Văn B')
    await page.getByTestId('confirm-phone').fill('12345') // dưới 9 chữ số
    await expect(page.getByTestId('confirm-submit')).toBeDisabled()

    await page.getByTestId('confirm-phone').fill('0901234567')
    await expect(page.getByTestId('confirm-submit')).toBeEnabled()
  })

  test('chọn một ngày đã kín lịch hiện trạng thái rỗng thân thiện, không phải lưới trống im lặng', async ({
    page,
    request,
  }) => {
    // Fixture riêng với KTV có ca làm việc chỉ đúng 1 ngày trong tuần (weekday
    // hôm nay), để các ngày còn lại chắc chắn "kín lịch" (thật ra là không có
    // ca) — tất định, không phụ thuộc slot cụ thể nào bị chiếm.
    const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
    const skillRes = await request.post('/api/admin/skills', { data: { name: `E2ENoShift-${tag}` } })
    const skill = (await skillRes.json()) as { id: number }
    const staffRes = await request.post('/api/admin/staff', {
      data: { name: `E2ENoShiftStaff-${tag}`, phone: null },
    })
    const staff = (await staffRes.json()) as { id: number }
    await request.post(`/api/admin/staff/${staff.id}/skills`, { data: { skill_id: skill.id } })
    const serviceRes = await request.post('/api/admin/services', {
      data: { name: `E2ENoShiftService-${tag}`, skill_id: skill.id, body_zone: 'face' },
    })
    const service = (await serviceRes.json()) as { id: number }
    const variantRes = await request.post('/api/admin/variants', {
      data: { service_id: service.id, name: `E2ENoShiftVariant-${tag}`, duration_min: 30, buffer_after_min: 5, price: 100000 },
    })
    const variant = (await variantRes.json()) as { id: number }
    // KHÔNG tạo shift nào — mọi ngày đều kín lịch (không có ca làm việc nào cả).

    await page.goto('/')
    await page.getByTestId(`service-${service.id}`).click()
    await page.getByTestId(`variant-${variant.id}`).click()
    await page.getByTestId('variant-continue').click()

    await expect(page.getByTestId('time-empty')).toBeVisible()
    await expect(page.getByTestId('time-empty')).toContainText('kín lịch')
  })

  test('chọn một KTV cụ thể thì chỉ còn slot của người đó được dùng cho bước xác nhận', async ({
    page,
    request,
  }) => {
    const fx = await createFixture(request)

    await goToTimeScreen(page, fx)
    await pickFirstAvailableSlot(page)

    await expect(page.getByTestId(`staff-${fx.staffId}`)).toBeVisible()
    await page.getByTestId(`staff-${fx.staffId}`).click()
    await expect(page.getByTestId('time-continue')).toBeEnabled()
    await page.getByTestId('time-continue').click()

    await expect(page.getByText(`Kỹ thuật viên #${fx.staffId}`)).toBeVisible()
  })

  test('chọn "Để spa sắp xếp" thì không cần chọn KTV cụ thể vẫn đặt được', async ({ page, request }) => {
    const fx = await createFixture(request)
    const phone = randomPhone()

    await goToTimeScreen(page, fx)
    await pickFirstAvailableSlot(page)
    await page.getByTestId('staff-auto').click()
    await expect(page.getByTestId('time-continue')).toBeEnabled()
    await page.getByTestId('time-continue').click()

    await expect(page.getByText('Spa sắp xếp')).toBeVisible()

    await page.getByTestId('confirm-name').fill('Lê Thị C')
    await page.getByTestId('confirm-phone').fill(phone)
    await page.getByTestId('confirm-submit').click()

    await expect(page.getByTestId('booking-code')).toBeVisible()
  })

  test('khi server trả 409 SLOT_TAKEN, danh sách slot được gọi lại và khách quay về bước chọn giờ', async ({
    page,
    request,
  }) => {
    const fx = await createFixture(request)
    const phone = randomPhone()

    await goToTimeScreen(page, fx)
    await pickFirstAvailableSlot(page)
    await page.getByTestId('staff-auto').click()
    await page.getByTestId('time-continue').click()

    // Chặn đúng request POST /api/bookings MỘT LẦN để mô phỏng người khác vừa
    // đặt mất chỗ (race condition thật, PRD §5) — không đụng gì tới các
    // request khác (availability vẫn gọi thật để kiểm tra "gọi lại").
    let intercepted = false
    await page.route('**/api/bookings', async (route) => {
      if (route.request().method() === 'POST' && !intercepted) {
        intercepted = true
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'SLOT_TAKEN', message: 'Khung giờ này vừa có người đặt mất' } }),
        })
        return
      }
      await route.continue()
    })

    let availabilityCalledAfter = false
    page.on('request', (req) => {
      if (intercepted && req.url().includes('/api/availability')) availabilityCalledAfter = true
    })

    await page.getByTestId('confirm-name').fill('Phạm Văn D')
    await page.getByTestId('confirm-phone').fill(phone)
    await page.getByTestId('confirm-submit').click()

    // Quay lại đúng bước chọn giờ (nhận diện qua steps/dock đặc trưng của màn time).
    await expect(page.getByTestId('time-continue')).toBeVisible()
    await expect(page.locator('.ccf-bk-dates')).toBeVisible()

    await expect.poll(() => availabilityCalledAfter).toBe(true)
  })

  test('khi gặp 409 SLOT_TAKEN, màn hình không hiện mã lỗi kỹ thuật mà hiện câu tiếng Việt dễ hiểu', async ({
    page,
    request,
  }) => {
    const fx = await createFixture(request)
    const phone = randomPhone()

    await goToTimeScreen(page, fx)
    await pickFirstAvailableSlot(page)
    await page.getByTestId('staff-auto').click()
    await page.getByTestId('time-continue').click()

    await page.route('**/api/bookings', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'SLOT_TAKEN', message: 'Khung giờ này vừa có người đặt mất' } }),
        })
        return
      }
      await route.continue()
    })

    await page.getByTestId('confirm-name').fill('Hoàng Thị E')
    await page.getByTestId('confirm-phone').fill(phone)
    await page.getByTestId('confirm-submit').click()

    await expect(page.getByTestId('time-continue')).toBeVisible()
    await expect(page.getByText('SLOT_TAKEN')).not.toBeVisible()
    await expect(page.getByText('409')).not.toBeVisible()
    await expect(page.getByText(/error/i)).not.toBeVisible()
  })

  test('mọi nút chính trên các màn hình đều có vùng chạm cao tối thiểu 48px', async ({ page, request }) => {
    const fx = await createFixture(request)

    await page.goto('/')
    const serviceCardBox = await page.getByTestId(`service-${fx.serviceId}`).boundingBox()
    expect(serviceCardBox).not.toBeNull()
    expect(serviceCardBox!.height).toBeGreaterThanOrEqual(48)

    await page.getByTestId(`service-${fx.serviceId}`).click()
    const variantCardBox = await page.getByTestId(`variant-${fx.variantId}`).boundingBox()
    expect(variantCardBox!.height).toBeGreaterThanOrEqual(48)

    await page.getByTestId(`variant-${fx.variantId}`).click()
    const continueBox = await page.getByTestId('variant-continue').boundingBox()
    expect(continueBox!.height).toBeGreaterThanOrEqual(48)

    await page.getByTestId('variant-continue').click()
    await pickFirstAvailableSlot(page)
    const slotBox = await page.locator('.ccf-bk-slot.ccf-bk-slot--sel').boundingBox()
    expect(slotBox!.height).toBeGreaterThanOrEqual(48)

    await page.getByTestId('staff-auto').click()
    const timeContinueBox = await page.getByTestId('time-continue').boundingBox()
    expect(timeContinueBox!.height).toBeGreaterThanOrEqual(48)

    await page.getByTestId('time-continue').click()
    const nameBox = await page.getByTestId('confirm-name').boundingBox()
    expect(nameBox!.height).toBeGreaterThanOrEqual(48)
    const phoneBox = await page.getByTestId('confirm-phone').boundingBox()
    expect(phoneBox!.height).toBeGreaterThanOrEqual(48)

    await page.getByTestId('confirm-name').fill('Vũ Thị F')
    await page.getByTestId('confirm-phone').fill(randomPhone())
    const submitBox = await page.getByTestId('confirm-submit').boundingBox()
    expect(submitBox!.height).toBeGreaterThanOrEqual(48)
  })
})
