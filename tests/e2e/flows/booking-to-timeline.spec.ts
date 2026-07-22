import { test, expect } from '@playwright/test'
import { bookingByPhone, bookThroughCustomerUi, createFlowFixture, goTimelineToDate, randomPhone } from './helpers'

test('khách đặt lịch xong thì lịch xuất hiện đúng cột KTV đúng giờ trên admin timeline', async ({ page, request }) => {
  const fx = await createFlowFixture(request)
  const phone = randomPhone()
  await bookThroughCustomerUi(page, fx, { name: `Khách timeline ${fx.tag}`, phone })

  const [booking] = await bookingByPhone(request, phone)
  expect(booking).toMatchObject({ staff_id: fx.staffId, start_at: fx.startAt, status: 'booked' })

  await page.goto('/admin/timeline')
  await goTimelineToDate(page, fx.date)
  const block = page.getByTestId(`booking-item-${booking!.item_id}`)
  await expect(block).toBeVisible()
  await expect(page.getByTestId(`cell-${fx.staffId}-10`).getByTestId(`booking-item-${booking!.item_id}`)).toBeVisible()
})
