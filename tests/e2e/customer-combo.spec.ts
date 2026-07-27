import { test, expect, type Page } from '@playwright/test'

// R1a serial-combo customer flow, on the real app (Worker + D1). Each test
// builds its OWN skills/staff/services via /api/admin/* so it is isolated from
// the shared seed and from parallel specs (same discipline as
// customer-booking.spec.ts). Shifts cover all 7 weekdays so the test never
// depends on which day "today" is.

interface ServiceFx {
  serviceId: number
  serviceName: string
  variantId: number
  variantName: string
  price: number
  durationMin: number
}

async function makeSkill(request: Page['request'], tag: string): Promise<number> {
  const r = await request.post('/api/admin/skills', { data: { name: `Skill-${tag}` } })
  return ((await r.json()) as { id: number }).id
}

async function makeStaffWithSkills(request: Page['request'], tag: string, skillIds: number[]): Promise<number> {
  const r = await request.post('/api/admin/staff', { data: { name: `Staff-${tag}`, phone: null } })
  const staffId = ((await r.json()) as { id: number }).id
  for (const skillId of skillIds) {
    await request.post(`/api/admin/staff/${staffId}/skills`, { data: { skill_id: skillId } })
  }
  for (let weekday = 0; weekday <= 6; weekday++) {
    await request.post('/api/admin/shifts', { data: { staff_id: staffId, weekday, start_min: 0, end_min: 1439 } })
  }
  return staffId
}

async function makeService(
  request: Page['request'],
  tag: string,
  skillId: number,
  zone: string,
  durationMin: number,
  bufferMin: number,
  price: number,
): Promise<ServiceFx> {
  const sr = await request.post('/api/admin/services', {
    data: { name: `Svc-${tag}`, skill_id: skillId, body_zone: zone },
  })
  const serviceId = ((await sr.json()) as { id: number }).id
  const vr = await request.post('/api/admin/variants', {
    data: { service_id: serviceId, name: `Var-${tag}`, duration_min: durationMin, buffer_after_min: bufferMin, price },
  })
  const variantId = ((await vr.json()) as { id: number }).id
  return { serviceId, serviceName: `Svc-${tag}`, variantId, variantName: `Var-${tag}`, price, durationMin }
}

function randomPhone(): string {
  return `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
}

async function pickFirstComboSlot(page: Page): Promise<void> {
  const dateButtons = page.locator('.ccf-bk-date')
  const count = await dateButtons.count()
  for (let i = 0; i < count; i++) {
    await dateButtons.nth(i).click()
    const anySlot = page.locator('.ccf-bk-slot').first()
    const empty = page.getByTestId('combo-time-empty')
    const uncoverable = page.getByTestId('combo-uncoverable')
    await Promise.race([
      anySlot.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
      empty.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
      uncoverable.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
    ])
    if (await anySlot.isVisible().catch(() => false)) {
      await anySlot.click()
      return
    }
  }
  throw new Error('Không tìm thấy ngày nào còn slot combo trong 14 ngày tới — fixture có vấn đề')
}

test.describe('Luồng khách đặt combo nối tiếp (R1a)', () => {
  test('chọn 2 dịch vụ do 1 KTV làm được, đặt combo thành công tạo 1 lịch với 2 mục', async ({ page, request }) => {
    const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
    const massage = await makeSkill(request, `massage-${tag}`)
    const nails = await makeSkill(request, `nails-${tag}`)
    // ONE technician holds BOTH → combo is coverable.
    await makeStaffWithSkills(request, `both-${tag}`, [massage, nails])
    const svcMassage = await makeService(request, `massage-${tag}`, massage, 'body', 60, 10, 350000)
    const svcNails = await makeService(request, `nails-${tag}`, nails, 'hands', 45, 5, 150000)
    const phone = randomPhone()

    await page.goto('/')
    // Pick service 1 → variant → "Thêm dịch vụ khác" (add to basket, back to list).
    await page.getByTestId(`service-${svcMassage.serviceId}`).click()
    await page.getByTestId(`variant-${svcMassage.variantId}`).click()
    await page.getByTestId('variant-add-more').click()

    // Basket bar visible with 1 item; pick service 2 → variant → continue combo.
    await expect(page.getByTestId('combo-basket')).toBeVisible()
    await page.getByTestId(`service-${svcNails.serviceId}`).click()
    await page.getByTestId(`variant-${svcNails.variantId}`).click()
    await page.getByTestId('variant-continue').click()

    // Combo time screen: total shown, coverable, slots present.
    await expect(page.getByTestId('combo-time-summary')).toBeVisible()
    await pickFirstComboSlot(page)
    await page.getByTestId('staff-auto').click()
    await expect(page.getByTestId('combo-time-continue')).toBeEnabled()
    await page.getByTestId('combo-time-continue').click()

    // Confirm shows the serial schedule (two service lines).
    await expect(page.getByTestId('combo-confirm-summary')).toBeVisible()
    await page.getByTestId('confirm-name').fill('Nguyễn Thu Hà')
    await page.getByTestId('confirm-phone').fill(phone)
    await expect(page.getByTestId('confirm-submit')).toBeEnabled()
    await page.getByTestId('confirm-submit').click()

    await expect(page.getByTestId('booking-code')).toBeVisible()

    // Truth check: two booking items under one appointment, retrievable by phone.
    const res = await request.get(`/api/bookings?phone=${encodeURIComponent(phone)}`)
    expect(res.ok()).toBe(true)
    const body = (await res.json()) as { bookings: Array<{ appointment_id: number; variant_name: string }> }
    expect(body.bookings).toHaveLength(2)
    const apptIds = new Set(body.bookings.map((b) => b.appointment_id))
    expect(apptIds.size).toBe(1) // both items in the SAME appointment
    const names = body.bookings.map((b) => b.variant_name).sort()
    expect(names).toEqual([svcMassage.variantName, svcNails.variantName].sort())
  })

  test('chọn 2 dịch vụ mà KHÔNG KTV nào làm được cả hai thì được báo TRƯỚC khi cam kết, không tạo lịch nào', async ({
    page,
    request,
  }) => {
    const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
    const massage = await makeSkill(request, `m-${tag}`)
    const nails = await makeSkill(request, `n-${tag}`)
    // Two DIFFERENT technicians, each with only ONE skill — nobody covers both.
    await makeStaffWithSkills(request, `m-only-${tag}`, [massage])
    await makeStaffWithSkills(request, `n-only-${tag}`, [nails])
    const svcMassage = await makeService(request, `m-${tag}`, massage, 'body', 60, 10, 350000)
    const svcNails = await makeService(request, `n-${tag}`, nails, 'hands', 45, 5, 150000)

    await page.goto('/')
    await page.getByTestId(`service-${svcMassage.serviceId}`).click()
    await page.getByTestId(`variant-${svcMassage.variantId}`).click()
    await page.getByTestId('variant-add-more').click()
    await page.getByTestId(`service-${svcNails.serviceId}`).click()
    await page.getByTestId(`variant-${svcNails.variantId}`).click()
    await page.getByTestId('variant-continue').click()

    // The uncoverable message appears BEFORE any commit; there is no way to
    // reach a confirm/submit for this combo.
    await expect(page.getByTestId('combo-uncoverable')).toBeVisible()
    await expect(page.getByTestId('combo-uncoverable')).toContainText('Chưa có kỹ thuật viên nào làm được trọn combo')
    // No slots are offered, so the continue button stays disabled.
    await expect(page.getByTestId('combo-time-continue')).toBeDisabled()
    // Raw error codes never leak to the customer. Dùng regex có RANH GIỚI TỪ để
    // không khớp nhầm số/chuỗi ngẫu nhiên trong tên fixture (vd tên chứa
    // timestamp "...856409..." từng khiến /409/ khớp nhầm span tên dịch vụ).
    await expect(page.getByText('STAFF_LACKS_SKILL')).not.toBeVisible()
    await expect(page.getByText(/\b(HTTP\s*)?409\b|\berror\b/i)).not.toBeVisible()
  })

  test('có thể bỏ một dịch vụ khỏi giỏ combo trước khi đặt', async ({ page, request }) => {
    const tag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
    const massage = await makeSkill(request, `rm-m-${tag}`)
    const nails = await makeSkill(request, `rm-n-${tag}`)
    await makeStaffWithSkills(request, `rm-both-${tag}`, [massage, nails])
    const svcMassage = await makeService(request, `rm-m-${tag}`, massage, 'body', 60, 10, 350000)
    const svcNails = await makeService(request, `rm-n-${tag}`, nails, 'hands', 45, 5, 150000)

    await page.goto('/')
    await page.getByTestId(`service-${svcMassage.serviceId}`).click()
    await page.getByTestId(`variant-${svcMassage.variantId}`).click()
    await page.getByTestId('variant-add-more').click()
    await page.getByTestId(`service-${svcNails.serviceId}`).click()
    await page.getByTestId(`variant-${svcNails.variantId}`).click()
    await page.getByTestId('variant-add-more').click()

    // Two items in basket; remove one.
    await expect(page.getByTestId(`basket-item-${svcMassage.variantId}`)).toBeVisible()
    await expect(page.getByTestId(`basket-item-${svcNails.variantId}`)).toBeVisible()
    await page.getByTestId(`basket-remove-${svcMassage.variantId}`).click()
    await expect(page.getByTestId(`basket-item-${svcMassage.variantId}`)).not.toBeVisible()
    await expect(page.getByTestId(`basket-item-${svcNails.variantId}`)).toBeVisible()
  })
})
