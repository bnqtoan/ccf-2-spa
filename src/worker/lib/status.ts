// Trạng thái booking_item — PRD §3.3, CONVENTIONS §3. PURE: nhận dữ liệu đã
// load sẵn, không tự query D1 (CONVENTIONS §7).
//
// Cutoff huỷ (PRD §6) tồn tại vì lý do THƯƠNG MẠI, không phải kỹ thuật: ép
// khách gọi điện khi còn dưới 2 tiếng, để lễ tân có cơ hội đổi lịch thay vì
// mất trắng slot. Phải chặn ở SERVER — ẩn nút trên UI không phải là chính
// sách, chỉ là gợi ý thẩm mỹ.

import type { AppointmentStatus } from '../db/types.ts'

/** Cutoff huỷ của khách, tính bằng phút trước giờ hẹn (PRD §6). */
export const CANCEL_CUTOFF_MIN = 120

/**
 * Bảng chuyển trạng thái hợp lệ (PRD §3.3):
 * `booked -> in_service -> done`; `cancelled`/`no_show` chỉ là lối ra
 * terminal từ `booked`. Mọi transition khác — kể cả từ chính nó (huỷ cái đã
 * huỷ) — đều sai.
 */
export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  if (from === 'booked') {
    return to === 'in_service' || to === 'cancelled' || to === 'no_show'
  }
  if (from === 'in_service') {
    return to === 'done'
  }
  return false
}

/**
 * Khách được tự huỷ khi còn cách giờ hẹn ít nhất `CANCEL_CUTOFF_MIN` phút.
 * Cả hai tham số đều là epoch giây. So sánh dùng THỜI ĐIỂM SERVER — gọi hàm
 * này với `now` lấy từ `Date.now()` phía worker, không bao giờ tin giá trị
 * client gửi lên.
 *
 * Ranh giới đúng 120 phút vẫn hợp lệ (kề nhau, không phải "trong cutoff"):
 * `now <= startAt - CANCEL_CUTOFF_MIN * 60`.
 */
export function canCustomerCancel(startAt: number, now: number): boolean {
  return now <= startAt - CANCEL_CUTOFF_MIN * 60
}
