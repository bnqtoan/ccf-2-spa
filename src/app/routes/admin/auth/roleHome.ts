// T-22 — trang mặc định sau đăng nhập / khi bị chặn theo role.
//   technician: thẳng vào /admin/timeline (họ chỉ có lịch của mình — không có
//     "hub" nào để chọn, nên bỏ qua trang chủ /admin).
//   owner / receptionist: trang chủ /admin (bảng điều hướng các khu).
import type { Role } from '../../../lib/authClient'

export function defaultRouteForRole(role: Role | null): string {
  if (role === 'technician') return '/admin/timeline'
  return '/admin'
}
