import { test, expect } from '@playwright/test'
import { bookingByPhone, createFlowFixture, goToConfirm, randomPhone } from './helpers'

test('hai tab cùng đặt một slot thì đúng một tab thành công, tab còn lại nhận thông báo hết chỗ và danh sách được làm mới', async ({ browser, request }) => {
  const fx = await createFlowFixture(request)
  const firstContext = await browser.newContext()
  const secondContext = await browser.newContext()
  const first = await firstContext.newPage()
  const second = await secondContext.newPage()
  const firstPhone = randomPhone()
  const secondPhone = randomPhone()

  try {
    await Promise.all([
      goToConfirm(first, fx, { name: `Khách đua A ${fx.tag}`, phone: firstPhone }),
      goToConfirm(second, fx, { name: `Khách đua B ${fx.tag}`, phone: secondPhone }),
    ])

    // Hai BrowserContext thật, cùng bấm trong một Promise.all — không tuần tự
    // hoá race bằng await. Server/SQL là trọng tài cuối cùng.
    await Promise.all([
      first.getByTestId('confirm-submit').click(),
      second.getByTestId('confirm-submit').click(),
    ])

    await Promise.all([
      first.locator('[data-testid="booking-code"], [data-testid="time-continue"]').waitFor(),
      second.locator('[data-testid="booking-code"], [data-testid="time-continue"]').waitFor(),
    ])

    const [firstDone, secondDone] = await Promise.all([
      first.getByTestId('booking-code').isVisible().catch(() => false),
      second.getByTestId('booking-code').isVisible().catch(() => false),
    ])
    expect(Number(firstDone) + Number(secondDone)).toBe(1)

    const losingPage = firstDone ? second : first
    await expect(losingPage.getByTestId('time-continue')).toBeVisible()
    // onSlotTaken quay lại màn giờ và fetch availability mới; slot đã mất
    // không còn xuất hiện, thay vì đứng ở màn xác nhận/lỗi trắng.
    await expect(losingPage.getByTestId(`slot-${fx.startAt}`)).toHaveCount(0)

    const [firstBookings, secondBookings] = await Promise.all([
      bookingByPhone(request, firstPhone),
      bookingByPhone(request, secondPhone),
    ])
    // Khẳng định dữ liệu cuối trong D1 qua endpoint đọc thật, không chỉ tin UI.
    expect([...firstBookings, ...secondBookings].filter((booking) => booking.status === 'booked')).toHaveLength(1)
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()])
  }
})
