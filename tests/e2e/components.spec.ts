import { test, expect } from '@playwright/test'

/** Tỉ lệ tương phản WCAG giữa hai màu rgb() */
function contrastRatio(fg: string, bg: string): number {
  const lum = (rgb: string) => {
    const ch = (rgb.match(/\d+/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0)
  }
  const [l1, l2] = [lum(fg), lum(bg)]
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

test.describe('Component base — /dev/components', () => {
  // Ba test dưới đây bắt lỗi mà bộ test ban đầu để lọt: không test nào đo màu
  // chữ hay font, nên `button.ccf-btn { color: inherit }` (đặc hiệu cao hơn
  // `.ccf-btn { color:#fff }`) kéo chữ nút về đen trên nền xanh đậm — tương
  // phản ~1.9:1 — mà 8/8 test vẫn xanh. Đo giá trị tính toán thật, không tin
  // vào việc CSS "trông có vẻ đúng".
  test('chữ trên nút primary đủ tương phản với nền (WCAG AA ≥ 4.5:1)', async ({ page }) => {
    await page.goto('/dev/components')
    const color = await page.getByTestId('btn-primary').evaluate(
      (el) => getComputedStyle(el).color
    )
    // nền là gradient var(--g-600) → var(--g-800); kiểm cả hai đầu
    for (const bg of ['rgb(47, 128, 100)', 'rgb(28, 74, 58)']) {
      expect(contrastRatio(color, bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('trang dùng font sans-serif của hệ thống, không rơi về serif mặc định', async ({ page }) => {
    await page.goto('/dev/components')
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    expect(font.toLowerCase()).not.toMatch(/^times|^serif/)
    expect(font).toMatch(/-apple-system|BlinkMacSystemFont|sans-serif/i)
  })

  test('cỡ chữ gốc tối thiểu 17px theo đúng prototype', async ({ page }) => {
    await page.goto('/dev/components')
    const size = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.body).fontSize)
    )
    expect(size).toBeGreaterThanOrEqual(17)
  })

  test('nút Button primary có vùng chạm cao tối thiểu 48px', async ({ page }) => {
    await page.goto('/dev/components')
    const box = await page.getByTestId('btn-primary').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(48)
  })

  test('nút Button size sm vẫn đủ cao tối thiểu 44px theo đúng prototype', async ({ page }) => {
    await page.goto('/dev/components')
    const box = await page.getByTestId('btn-sm').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  })

  test('Sheet mở ra khi trigger, đóng được khi bấm nút X', async ({ page }) => {
    await page.goto('/dev/components')
    await page.getByTestId('sheet-trigger').click()
    await expect(page.getByTestId('sheet-content')).toBeVisible()

    await page.locator('.ccf-x').click()
    await expect(page.getByTestId('sheet-content')).not.toBeVisible()
  })

  test('Sheet đóng được khi bấm vào lớp nền mờ phía sau', async ({ page }) => {
    await page.goto('/dev/components')
    await page.getByTestId('sheet-trigger').click()
    await expect(page.getByTestId('sheet-content')).toBeVisible()

    // Bấm vào mask ở toạ độ ngoài sheet (góc trên) để chắc chắn nhắm vào nền, không phải nội dung
    await page.locator('.ccf-mask').click({ position: { x: 5, y: 5 } })
    await expect(page.getByTestId('sheet-content')).not.toBeVisible()
  })

  test('Sheet không đóng khi bấm vào nội dung bên trong sheet', async ({ page }) => {
    await page.goto('/dev/components')
    await page.getByTestId('sheet-trigger').click()
    await expect(page.getByTestId('sheet-content')).toBeVisible()

    await page.getByTestId('sheet-content').click()
    await expect(page.getByTestId('sheet-content')).toBeVisible()
  })

  test('Field input hiện viền xanh rõ ràng khi focus (không mất outline)', async ({ page }) => {
    await page.goto('/dev/components')
    const input = page.getByTestId('field-name')
    await input.focus()
    // --g-500: #3d9b7a -> rgb(61, 155, 122). toHaveCSS tự retry cho đến khi
    // transition border-color (.18s) hoàn tất, tránh đọc màu giữa chừng animation.
    await expect(input).toHaveCSS('border-color', 'rgb(61, 155, 122)')
  })

  test('component render đúng ở viewport 375px, không có phần tử nào tràn ngang trang', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto('/dev/components')

    const hasOverflow = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth
      const all = document.querySelectorAll('body *')
      for (const el of Array.from(all)) {
        const rect = el.getBoundingClientRect()
        if (rect.right > docWidth + 1) {
          return true
        }
      }
      return false
    })
    expect(hasOverflow).toBe(false)
  })

  test('Button disabled không nhận click (onClick không được gọi)', async ({ page }) => {
    await page.goto('/dev/components')
    await page.getByTestId('btn-disabled').click({ force: true })
    await expect(page.getByTestId('disabled-clicked-flag')).toHaveText('not-clicked')
  })
})
