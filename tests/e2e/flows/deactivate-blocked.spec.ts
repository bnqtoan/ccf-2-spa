import { test, expect } from '@playwright/test'
import { bookThroughCustomerUi, createFlowFixture, randomPhone } from './helpers'

// G0 — bẫy im lặng đã sửa: "Cho ngưng làm" một nhân viên còn lịch sắp tới KHÔNG
// còn âm thầm giấu cột + khách khỏi timeline. Nay bị CHẶN, hiện danh sách lịch
// ảnh hưởng và chỉ sang "Báo nghỉ". Nhân viên vẫn "Đang làm" sau khi bị chặn.

test('cho ngưng làm nhân viên còn lịch sắp tới bị chặn, hiện lịch ảnh hưởng, giữ nguyên đang làm', async ({
  page,
  request,
}) => {
  const fx = await createFlowFixture(request)
  const phone = randomPhone()
  const customerName = `Khách G0 ${fx.tag}`
  await bookThroughCustomerUi(page, fx, { name: customerName, phone })

  await page.goto('/admin/setup')
  await page.getByTestId('setup-tab-staff').click()
  await page.getByTestId('staff-list').getByText(fx.staffName).click()

  const sheet = page.getByTestId('staff-edit-sheet')
  await expect(sheet).toBeVisible()

  await page.getByTestId('staff-toggle-active').click()

  // Bị chặn: notice hiện, có tên khách của lịch sắp tới, và trỏ tới "Báo nghỉ".
  const blocked = page.getByTestId('deactivate-blocked')
  await expect(blocked).toBeVisible()
  await expect(page.getByTestId('deactivate-blocked-list')).toContainText(customerName)
  await expect(blocked).toContainText('Báo nghỉ')

  // Nút vẫn là "Cho ngưng làm" (chưa chuyển sang "Kích hoạt lại") => vẫn đang làm.
  await expect(page.getByTestId('staff-toggle-active')).toHaveText('Cho ngưng làm')

  // Nguồn sự thật: API vẫn báo active = 1.
  const staffList = (await request.get('/api/admin/staff').then((r) => r.json())) as {
    id: number
    active: number
  }[]
  expect(staffList.find((s) => s.id === fx.staffId)?.active).toBe(1)
})
