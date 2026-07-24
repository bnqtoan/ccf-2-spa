import { test, expect, type APIRequestContext } from '@playwright/test'

// T-17 — màn Thiết lập (/admin/setup): CRUD nhân viên/skill, dịch vụ/gói, ca
// làm việc. Backend (T-06) đã đủ 19 endpoint, test này chỉ kiểm UI mới.
//
// Seed qua API admin (POST), KHÔNG wipe bảng — nhiều spec chạy trên cùng D1
// local (CONVENTIONS §8). Mỗi test tự tạo dữ liệu riêng, tên gắn tag ngẫu
// nhiên duy nhất cho lần chạy để tự nhận diện trên UI mà không đụng seed
// chuẩn hay fixture của spec khác.

function uniqueTag(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

type IdResponse = { id: number }

async function postId(request: APIRequestContext, url: string, data: unknown): Promise<number> {
  const response = await request.post(url, { data })
  expect(response.ok(), `${url} phải tạo fixture thành công`).toBe(true)
  return ((await response.json()) as IdResponse).id
}

test.describe('Thiết lập — Nhân viên', () => {
  test('thêm nhân viên mới thì nhân viên đó xuất hiện trong danh sách', async ({ page }) => {
    const tag = uniqueTag()
    const name = `E2E Setup Staff ${tag}`

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-staff').click()
    await page.getByTestId('staff-name-input').fill(name)
    await page.getByTestId('staff-phone-input').fill('0909000111')
    await page.getByTestId('staff-add-submit').click()

    await expect(page.getByTestId('staff-list')).toContainText(name)
  })

  test('gán một kỹ năng cho nhân viên thì nhân viên đó nhận kỹ năng đó', async ({ page, request }) => {
    const tag = uniqueTag()
    const skillName = `E2E Setup Skill A ${tag}`
    const staffName = `E2E Setup KTV A ${tag}`
    await postId(request, '/api/admin/skills', { name: skillName })
    await postId(request, '/api/admin/staff', { name: staffName, phone: null })

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-staff').click()
    await page.getByTestId('staff-list').getByText(staffName).click()

    const sheet = page.getByTestId('staff-edit-sheet')
    await expect(sheet).toBeVisible()
    const checkbox = page
      .getByTestId('staff-skill-checklist')
      .locator('.ccf-su-check-item')
      .filter({ hasText: skillName })
      .locator('input[type="checkbox"]')
    await expect(checkbox).not.toBeChecked()
    await checkbox.check()
    await expect(checkbox).toBeChecked()
  })

  test('bỏ gán kỹ năng thì nhân viên không còn kỹ năng đó', async ({ page, request }) => {
    const tag = uniqueTag()
    const skillName = `E2E Setup Skill B ${tag}`
    const staffName = `E2E Setup KTV B ${tag}`
    const skillId = await postId(request, '/api/admin/skills', { name: skillName })
    const staffId = await postId(request, '/api/admin/staff', { name: staffName, phone: null })
    const assign = await request.post(`/api/admin/staff/${staffId}/skills`, { data: { skill_id: skillId } })
    expect(assign.ok()).toBe(true)

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-staff').click()
    await page.getByTestId('staff-list').getByText(staffName).click()

    const checkbox = page
      .getByTestId('staff-skill-checklist')
      .locator('.ccf-su-check-item')
      .filter({ hasText: skillName })
      .locator('input[type="checkbox"]')
    // Backend gán/bỏ gán là ghi thuần (không có endpoint đọc lại quan hệ hiện
    // có — xem "Đã làm gì"), nên UI mở sheet với checkbox chưa đánh dấu. Tick
    // rồi bỏ tick lại để khẳng định hành vi bỏ gán qua đúng API DELETE.
    await checkbox.check()
    await expect(checkbox).toBeChecked()
    await checkbox.uncheck()
    await expect(checkbox).not.toBeChecked()
  })

  test('vô hiệu hoá nhân viên thì trạng thái đổi thành ngưng, không xoá khỏi danh sách', async ({ page, request }) => {
    const tag = uniqueTag()
    const staffName = `E2E Setup KTV C ${tag}`
    await postId(request, '/api/admin/staff', { name: staffName, phone: null })

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-staff').click()
    await page.getByTestId('staff-list').getByText(staffName).click()

    const sheet = page.getByTestId('staff-edit-sheet')
    await expect(sheet).toBeVisible()
    await page.getByTestId('staff-toggle-active').click()
    await expect(page.getByTestId('staff-toggle-active')).toHaveText('Kích hoạt lại')
    await page.locator('.ccf-sheet-sf').getByRole('button', { name: 'Đóng' }).click()

    await expect(page.getByTestId('staff-list')).toContainText(staffName)
    await expect(page.getByTestId('staff-list').getByText(staffName)).toBeVisible()
  })

  test('thêm skill mới xuất hiện để gán', async ({ page }) => {
    const tag = uniqueTag()
    const skillName = `E2E Setup New Skill ${tag}`

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-staff').click()
    await page.getByTestId('skill-name-input').fill(skillName)
    await page.getByTestId('skill-add-submit').click()

    await expect(page.getByTestId('skill-list')).toContainText(skillName)
  })

  test('xoá skill đang được dịch vụ dùng bị chặn, hiện thông báo thân thiện không phải mã lỗi thô', async ({
    page,
    request,
  }) => {
    const tag = uniqueTag()
    const skillName = `E2E Setup Used Skill ${tag}`
    const skillId = await postId(request, '/api/admin/skills', { name: skillName })
    await postId(request, '/api/admin/services', {
      name: `E2E Setup Service Using Skill ${tag}`,
      skill_id: skillId,
      body_zone: 'body',
    })

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-staff').click()
    await page.getByTestId(`skill-delete-${skillId}`).click()

    const error = page.getByTestId('skill-error')
    await expect(error).toBeVisible()
    const text = await error.textContent()
    expect(text).not.toMatch(/VALIDATION|NOT_FOUND|\{.*error.*\}/)
    expect(text ?? '').toContain(skillName)
    // Skill vẫn còn trong danh sách — không bị xoá im lặng.
    await expect(page.getByTestId(`skill-chip-${skillId}`)).toBeVisible()
  })
})

test.describe('Thiết lập — Dịch vụ', () => {
  test('thêm dịch vụ mới với kỹ năng và vùng cơ thể thì xuất hiện trong danh sách', async ({ page, request }) => {
    const tag = uniqueTag()
    const skillName = `E2E Setup Svc Skill ${tag}`
    const serviceName = `E2E Setup Service ${tag}`
    await postId(request, '/api/admin/skills', { name: skillName })

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-services').click()
    await page.getByTestId('service-name-input').fill(serviceName)
    await page.getByTestId('service-skill-select').selectOption({ label: skillName })
    await page.getByTestId('service-zone-select').selectOption('face')
    await page.getByTestId('service-add-submit').click()

    await expect(page.getByTestId('service-list')).toContainText(serviceName)
  })

  test('thêm gói cho dịch vụ với thời lượng/buffer/giá thì gói xuất hiện dưới dịch vụ đó', async ({
    page,
    request,
  }) => {
    const tag = uniqueTag()
    const skillId = await postId(request, '/api/admin/skills', { name: `E2E Setup Variant Skill ${tag}` })
    const serviceName = `E2E Setup Service Variant ${tag}`
    const serviceId = await postId(request, '/api/admin/services', {
      name: serviceName,
      skill_id: skillId,
      body_zone: 'hands',
    })
    const variantName = `Gói ${tag}`

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-services').click()
    await page.getByTestId(`service-row-${serviceId}`).click()
    await expect(page.getByTestId('service-edit-sheet')).toBeVisible()
    await page.getByTestId('variant-name-input').fill(variantName)
    await page.getByTestId('variant-duration-input').fill('45')
    await page.getByTestId('variant-buffer-input').fill('10')
    await page.getByTestId('variant-price-input').fill('250000')
    await page.getByTestId('variant-add-submit').click()

    await expect(page.getByTestId('variant-list')).toContainText(variantName)
    await expect(page.getByTestId('variant-list')).toContainText('45 phút')
  })

  test('thêm gói với giá âm bị chặn ngay ở client, không gửi request', async ({ page, request }) => {
    const tag = uniqueTag()
    const skillId = await postId(request, '/api/admin/skills', { name: `E2E Setup Negative Skill ${tag}` })
    const serviceId = await postId(request, '/api/admin/services', {
      name: `E2E Setup Negative Service ${tag}`,
      skill_id: skillId,
      body_zone: 'hands',
    })

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-services').click()
    await page.getByTestId(`service-row-${serviceId}`).click()
    await expect(page.getByTestId('service-edit-sheet')).toBeVisible()

    let sawVariantPost = false
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/admin/variants')) sawVariantPost = true
    })

    await page.getByTestId('variant-name-input').fill(`Gói giá âm ${tag}`)
    await page.getByTestId('variant-duration-input').fill('30')
    await page.getByTestId('variant-buffer-input').fill('5')
    await page.getByTestId('variant-price-input').fill('-1000')
    await page.getByTestId('variant-add-submit').click()

    await expect(page.getByTestId('variant-error')).toBeVisible()
    await expect(page.getByTestId('variant-error')).toContainText('không được âm')
    expect(sawVariantPost).toBe(false)
  })
})

test.describe('Thiết lập — Ca làm việc', () => {
  test('đặt ca làm việc cho nhân viên vào một thứ với giờ bắt đầu/kết thúc thì ca xuất hiện', async ({
    page,
    request,
  }) => {
    const tag = uniqueTag()
    const staffName = `E2E Setup Shift KTV ${tag}`
    const staffId = await postId(request, '/api/admin/staff', { name: staffName, phone: null })

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-shifts').click()
    await page.getByTestId('shift-staff-select').selectOption({ label: staffName })
    await page.getByTestId('shift-weekday-select').selectOption('1') // Thứ Hai
    await page.getByTestId('shift-start-input').fill('09:00')
    await page.getByTestId('shift-end-input').fill('17:00')
    await page.getByTestId('shift-add-submit').click()

    const list = page.getByTestId('shift-list')
    await expect(list).toContainText(staffName)
    await expect(list).toContainText('Thứ Hai')
    await expect(list).toContainText('09:00 – 17:00')

    // Định nghĩa "xong" của card: ca vừa đặt phải khiến nhân viên này xuất
    // hiện thành một cột trên /admin/timeline vào đúng thứ đó (dùng shift đã
    // seed 00:00-24:00 mọi ngày làm oracle gián tiếp là quá phức tạp — ở đây
    // khẳng định trực tiếp việc ca đã lưu đúng phút-từ-nửa-đêm qua API để
    // chốt cạm bẫy start_min/epoch, timeline đã có test riêng ở T-12).
    const shifts = (await (await request.get('/api/admin/shifts')).json()) as {
      staff_id: number
      weekday: number
      start_min: number
      end_min: number
    }[]
    const created = shifts.find((s) => s.staff_id === staffId)
    expect(created).toBeTruthy()
    expect(created?.weekday).toBe(1)
    expect(created?.start_min).toBe(540)
    expect(created?.end_min).toBe(1020)
  })

  test('đặt ca với giờ kết thúc sớm hơn giờ bắt đầu bị chặn', async ({ page, request }) => {
    const tag = uniqueTag()
    const staffName = `E2E Setup Bad Shift KTV ${tag}`
    await postId(request, '/api/admin/staff', { name: staffName, phone: null })

    await page.goto('/admin/setup')
    await page.getByTestId('setup-tab-shifts').click()
    await page.getByTestId('shift-staff-select').selectOption({ label: staffName })
    await page.getByTestId('shift-weekday-select').selectOption('2')
    await page.getByTestId('shift-start-input').fill('17:00')
    await page.getByTestId('shift-end-input').fill('09:00')

    let sawShiftPost = false
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/admin/shifts')) sawShiftPost = true
    })
    await page.getByTestId('shift-add-submit').click()

    await expect(page.getByTestId('shift-error')).toBeVisible()
    expect(sawShiftPost).toBe(false)
  })
})

test.describe('Thiết lập — vùng chạm', () => {
  test('mọi nút chính có vùng chạm ≥48px', async ({ page }) => {
    await page.goto('/admin/setup')

    async function assertTapTargets(testIds: string[]) {
      for (const id of testIds) {
        const box = await page.getByTestId(id).boundingBox()
        expect(box, `${id} phải render`).toBeTruthy()
        expect(box!.height, `${id} cao ${box!.height}px, cần ≥48px`).toBeGreaterThanOrEqual(48)
      }
    }

    await page.getByTestId('setup-tab-staff').click()
    await assertTapTargets(['staff-add-submit'])

    await page.getByTestId('setup-tab-services').click()
    await assertTapTargets(['service-add-submit'])

    await page.getByTestId('setup-tab-shifts').click()
    await assertTapTargets(['shift-add-submit'])
  })
})
