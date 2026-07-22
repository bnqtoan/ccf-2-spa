import { test, expect } from '@playwright/test'
import { bookingByPhone, bookThroughCustomerUi, createFlowFixture, goToConfirm, randomPhone } from './helpers'

test('khách huỷ lịch còn xa giờ hẹn thì slot mở lại và khách khác đặt được ngay slot đó', async ({ page, request }) => {
  const fx = await createFlowFixture(request)
  const firstPhone = randomPhone()
  await bookThroughCustomerUi(page, fx, { name: `Khách huỷ ${fx.tag}`, phone: firstPhone })
  const [firstBooking] = await bookingByPhone(request, firstPhone)

  await page.goto('/lookup')
  await page.getByTestId('lookup-phone-input').fill(firstPhone)
  await page.getByTestId('lookup-submit').click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByTestId(`cancel-${firstBooking!.item_id}`).click()
  await expect(page.getByTestId('lookup-empty')).toBeVisible()

  const secondPhone = randomPhone()
  await goToConfirm(page, fx, { name: `Khách nhận slot ${fx.tag}`, phone: secondPhone })
  await page.getByTestId('confirm-submit').click()
  await expect(page.getByTestId('booking-code')).toBeVisible()
  const [secondBooking] = await bookingByPhone(request, secondPhone)
  expect(secondBooking).toMatchObject({ staff_id: fx.staffId, start_at: fx.startAt, status: 'booked' })
})
