// T-23 — helper dùng chung: đăng nhập `owner` seed cho các spec cần vào ĐƯỢC
// khu quản lý (không phải chính spec test luồng đổi mật khẩu).
//
// Vì sao cần: owner seed có must_change_password=1 (mật khẩu mặc định cố định
// 'admin123', xem src/worker/db/seed.ts). RequireAuth phía SPA chặn CỨNG mọi
// trang admin khi cờ này còn =1 (T-23) — nên bất kỳ spec nào đăng nhập owner rồi
// mong vào thẳng /admin/* phải tự đổi mật khẩu trước, giống một owner thật.
//
// D1 local dùng CHUNG cho cả lần chạy Playwright (nhiều spec/project không phụ
// thuộc thứ tự nhau — xem comment trong playwright.config.ts). owner là MỘT
// dòng DUY NHẤT trong bảng users, nên hàm này phải IDEMPOTENT qua nhiều lần gọi
// từ nhiều file khác nhau: thử mật khẩu mặc định trước; nếu sai (một spec khác
// ĐÃ đổi rồi) thì thử luôn mật khẩu SAU-KHI-ĐỔI — không đổi lần hai.
import type { APIRequestContext } from '@playwright/test'

export const OWNER_USERNAME = 'owner'
export const OWNER_DEFAULT_PASSWORD = 'admin123' // khớp DEFAULT_PW trong seed.ts
// Mật khẩu owner mang sau khi tự đổi lần đầu — CỐ ĐỊNH để mọi spec đồng thuận.
export const OWNER_CHANGED_PASSWORD = 'admin123-changed'

/**
 * Đăng nhập owner với phiên KHÔNG còn must_change_password (đổi mật khẩu mặc
 * định nếu cần). Trả mật khẩu hiện tại của owner (để test khác dùng lại nếu
 * cần đăng nhập lần nữa trong cùng file). request phải là context CHƯA có
 * cookie owner (mỗi Playwright test có context riêng).
 */
export async function loginOwnerPastMustChange(request: APIRequestContext): Promise<string> {
  const first = await request.post('/api/auth/login', {
    data: { username: OWNER_USERNAME, password: OWNER_DEFAULT_PASSWORD },
  })
  if (first.status() === 200) {
    const body = (await first.json()) as { must_change_password?: boolean }
    if (body.must_change_password !== true) return OWNER_DEFAULT_PASSWORD // đã hết bắt đổi (không nên xảy ra, an toàn)
    const changed = await request.post('/api/auth/change-password', {
      data: { current_password: OWNER_DEFAULT_PASSWORD, new_password: OWNER_CHANGED_PASSWORD },
    })
    if (changed.status() !== 200) {
      throw new Error(`đổi mật khẩu owner lần đầu thất bại: HTTP ${changed.status()}`)
    }
    return OWNER_CHANGED_PASSWORD
  }

  // Mật khẩu mặc định không còn đúng nữa → một spec khác (chạy trước trong
  // cùng suite) đã đổi rồi. Đăng nhập lại bằng mật khẩu SAU-KHI-ĐỔI.
  const retry = await request.post('/api/auth/login', {
    data: { username: OWNER_USERNAME, password: OWNER_CHANGED_PASSWORD },
  })
  if (retry.status() !== 200) {
    throw new Error(
      `đăng nhập owner thất bại với cả mật khẩu mặc định lẫn mật khẩu đã đổi (HTTP ${first.status()} / ${retry.status()})`,
    )
  }
  return OWNER_CHANGED_PASSWORD
}
