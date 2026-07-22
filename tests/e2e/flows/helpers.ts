import { expect, type APIRequestContext, type Page } from '@playwright/test'

export interface FlowFixture {
  tag: string
  serviceId: number
  variantId: number
  staffId: number
  staffName: string
  alternateSkilledStaffId?: number
  unskilledStaffId?: number
  date: string
  startAt: number
}

type IdResponse = { id: number }

function uniqueTag(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

/** Ngày mai lúc 10:00 theo giờ spa, luôn còn trong 14 ngày mà UI cho chọn. */
function nextBookingSlot(): { date: string; startAt: number; weekday: number } {
  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000)
  const next = new Date(Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate() + 1, 10, 0, 0))
  const date = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
  // Việt Nam không có DST; 10:00 local = 03:00 UTC.
  return { date, startAt: next.getTime() / 1000 - 7 * 60 * 60, weekday: next.getUTCDay() }
}

async function postId(request: APIRequestContext, url: string, data: unknown): Promise<number> {
  const response = await request.post(url, { data })
  expect(response.ok(), `${url} phải tạo fixture thành công`).toBe(true)
  return (await response.json() as IdResponse).id
}

/**
 * Fixture độc lập cho mỗi test: skill/service/gói/KTV riêng và ca 00:00-24:00
 * cho đúng ngày đặt. Chỉ INSERT qua API admin, không đụng dữ liệu có sẵn.
 */
export async function createFlowFixture(
  request: APIRequestContext,
  options: { withUnskilledStaff?: boolean; withAlternateSkilledStaff?: boolean } = {},
): Promise<FlowFixture> {
  const tag = uniqueTag()
  const slot = nextBookingSlot()
  const skillId = await postId(request, '/api/admin/skills', { name: `E2E Flow Skill ${tag}` })
  const staffName = `E2E Flow KTV ${tag}`
  const staffId = await postId(request, '/api/admin/staff', { name: staffName, phone: null })
  const skillResponse = await request.post(`/api/admin/staff/${staffId}/skills`, { data: { skill_id: skillId } })
  expect(skillResponse.ok()).toBe(true)
  const serviceId = await postId(request, '/api/admin/services', {
    name: `E2E Flow Service ${tag}`,
    skill_id: skillId,
    body_zone: 'body',
  })
  const variantId = await postId(request, '/api/admin/variants', {
    service_id: serviceId,
    name: `E2E Flow Variant ${tag}`,
    duration_min: 30,
    buffer_after_min: 5,
    price: 100000,
  })
  const shift = await request.post('/api/admin/shifts', {
    data: { staff_id: staffId, weekday: slot.weekday, start_min: 0, end_min: 1440 },
  })
  expect(shift.ok()).toBe(true)

  let alternateSkilledStaffId: number | undefined
  if (options.withAlternateSkilledStaff) {
    alternateSkilledStaffId = await postId(request, '/api/admin/staff', {
      name: `E2E Flow Backup KTV ${tag}`,
      phone: null,
    })
    const alternateSkill = await request.post(`/api/admin/staff/${alternateSkilledStaffId}/skills`, {
      data: { skill_id: skillId },
    })
    expect(alternateSkill.ok()).toBe(true)
    const alternateShift = await request.post('/api/admin/shifts', {
      data: { staff_id: alternateSkilledStaffId, weekday: slot.weekday, start_min: 0, end_min: 1440 },
    })
    expect(alternateShift.ok()).toBe(true)
  }

  let unskilledStaffId: number | undefined
  if (options.withUnskilledStaff) {
    unskilledStaffId = await postId(request, '/api/admin/staff', {
      name: `E2E Flow NoSkill ${tag}`,
      phone: null,
    })
    const noSkillShift = await request.post('/api/admin/shifts', {
      data: { staff_id: unskilledStaffId, weekday: slot.weekday, start_min: 0, end_min: 1440 },
    })
    expect(noSkillShift.ok()).toBe(true)
  }

  return {
    tag,
    serviceId,
    variantId,
    staffId,
    staffName,
    alternateSkilledStaffId,
    unskilledStaffId,
    date: slot.date,
    startAt: slot.startAt,
  }
}

export async function goToConfirm(page: Page, fx: FlowFixture, customer: { name: string; phone: string }): Promise<void> {
  await page.goto('/')
  await page.getByTestId(`service-${fx.serviceId}`).click()
  await page.getByTestId(`variant-${fx.variantId}`).click()
  await page.getByTestId('variant-continue').click()
  await page.getByTestId(`date-${fx.date}`).click()
  await expect(page.getByTestId(`slot-${fx.startAt}`)).toBeVisible()
  await page.getByTestId(`slot-${fx.startAt}`).click()
  await page.getByTestId(`staff-${fx.staffId}`).click()
  await page.getByTestId('time-continue').click()
  await page.getByTestId('confirm-name').fill(customer.name)
  await page.getByTestId('confirm-phone').fill(customer.phone)
}

export async function bookThroughCustomerUi(
  page: Page,
  fx: FlowFixture,
  customer: { name: string; phone: string },
): Promise<void> {
  await goToConfirm(page, fx, customer)
  await page.getByTestId('confirm-submit').click()
  await expect(page.getByTestId('booking-code')).toBeVisible()
}

export async function bookingByPhone(
  request: APIRequestContext,
  phone: string,
): Promise<{ item_id: number; staff_id: number; start_at: number; status: string }[]> {
  const response = await request.get(`/api/bookings?phone=${encodeURIComponent(phone)}`)
  expect(response.ok()).toBe(true)
  return (await response.json() as { bookings: { item_id: number; staff_id: number; start_at: number; status: string }[] }).bookings
}

export async function goTimelineToDate(page: Page, targetDate: string): Promise<void> {
  const [, targetMonth, targetDay] = targetDate.split('-').map(Number)
  const targetLabel = `${String(targetDay).padStart(2, '0')}/${String(targetMonth).padStart(2, '0')}`
  for (let i = 0; i < 14; i++) {
    if ((await page.getByTestId('date-current').textContent())?.includes(targetLabel)) return
    await page.getByTestId('date-next').click()
  }
  throw new Error(`Không đi tới được ngày ${targetDate} trên timeline`)
}

export function randomPhone(): string {
  return `09${Math.floor(100000000 + Math.random() * 900000000)}`.slice(0, 10)
}
