import { test, expect } from '@playwright/test'
import { bookingByPhone, bookThroughCustomerUi, createFlowFixture, goTimelineToDate, randomPhone } from './helpers'

test.describe.configure({ mode: 'serial' })

test('admin tạo nghỉ đột xuất đè booking thì booking vào hàng chờ, chuyển sang KTV đủ skill thành công, chuyển sang KTV thiếu skill bị chặn', async ({ page, request }) => {
  // Hàng chờ là toàn cục: huỷ hợp lệ các item mồ côi từ lần chạy cũ trước khi
  // kiểm chứng item của flow này, không DELETE hay wipe bảng.
  const previous = await request.get('/api/admin/reassign-queue')
  expect(previous.ok()).toBe(true)
  const oldItems = (await previous.json() as { items: { item_id: number }[] }).items
  await Promise.all(oldItems.map((item) => request.post(`/api/admin/bookings/${item.item_id}/cancel`)))

  const fx = await createFlowFixture(request, { withUnskilledStaff: true, withAlternateSkilledStaff: true })
  const phone = randomPhone()
  await bookThroughCustomerUi(page, fx, { name: `Khách time-off ${fx.tag}`, phone })
  const [booking] = await bookingByPhone(request, phone)

  const timeOff = await request.post('/api/admin/time-off', {
    data: { staff_id: fx.staffId, start_at: fx.startAt, end_at: fx.startAt + 35 * 60, reason: `E2E time-off ${fx.tag}` },
  })
  expect(timeOff.ok()).toBe(true)
  expect((await timeOff.json() as { affected_items: { item_id: number }[] }).affected_items).toEqual(
    expect.arrayContaining([expect.objectContaining({ item_id: booking!.item_id })]),
  )

  await page.goto('/admin/timeline')
  await goTimelineToDate(page, fx.date)
  await expect(page.getByTestId(`booking-item-${booking!.item_id}`)).toHaveAttribute('data-orphan', 'true')
  await expect(page.getByTestId('reassign-banner')).toBeVisible()

  await page.goto('/admin/reassign')
  await expect(page.getByTestId(`queue-item-${booking!.item_id}`)).toBeVisible()
  await page.getByTestId(`queue-reassign-${booking!.item_id}`).click()
  await expect(page.getByTestId(`reassign-candidate-${fx.unskilledStaffId}`)).toBeDisabled()
  await expect(page.getByTestId(`reassign-reason-${fx.unskilledStaffId}`)).toContainText('kỹ năng')

  await expect(page.getByTestId(`reassign-candidate-${fx.alternateSkilledStaffId}`)).toBeEnabled()
  await page.getByTestId(`reassign-candidate-${fx.alternateSkilledStaffId}`).click()
  await expect(page.getByTestId(`queue-item-${booking!.item_id}`)).not.toBeVisible()

  const blocked = await request.post(`/api/admin/bookings/${booking!.item_id}/reassign`, {
    data: { staff_id: fx.unskilledStaffId },
  })
  expect(blocked.status()).toBe(409)
  expect((await blocked.json() as { error: { code: string } }).error.code).toBe('STAFF_LACKS_SKILL')
})
