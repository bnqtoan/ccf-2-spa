// T-19 → T-22 — guard cho mọi route SPA /admin/*. Bọc quanh trang admin: hỏi
// server phiên còn hợp lệ không; chưa đăng nhập → redirect /login. T-22: guard
// thêm THEO ROLE — `allow` liệt kê role được vào; role không đủ → đẩy về trang
// mặc định của họ (KHÔNG cho xem nội dung ngoài quyền). Server vẫn là gate thật.
//
// Nguồn sự thật là server (GET /api/auth/session) — KHÔNG tự đoán từ cookie phía
// client (cookie httpOnly, JS không đọc được, đúng ý đồ chống XSS).

import { Navigate, useLocation } from 'react-router-dom'
import { useSession } from '../../../lib/useSession'
import { defaultRouteForRole } from './roleHome'
import type { Role } from '../../../lib/authClient'

export default function RequireAuth({
  children,
  allow,
}: {
  children: React.ReactNode
  /** Nếu có: chỉ các role này được vào. Bỏ trống = bất kỳ user đã đăng nhập. */
  allow?: Role[]
}) {
  const { status, authenticated, role, mustChangePassword } = useSession()
  const location = useLocation()

  if (status === 'checking') {
    return (
      <div style={{ padding: 24, color: 'var(--ink-2)' }} data-testid="auth-checking">
        Đang kiểm tra đăng nhập…
      </div>
    )
  }

  if (!authenticated) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }

  // T-23 — phải đổi mật khẩu mặc định trước khi vào BẤT KỲ trang admin nào
  // (kể cả trang chính nó nếu đã ở /admin/change-password — tránh vòng lặp).
  if (mustChangePassword && location.pathname !== '/admin/change-password') {
    return <Navigate to="/admin/change-password" replace />
  }

  // Đăng nhập rồi nhưng role không được phép vào trang này → đưa về trang mặc
  // định của role (technician: timeline; else: /admin). Không nháy nội dung cấm.
  if (allow !== undefined && (role === null || !allow.includes(role))) {
    return <Navigate to={defaultRouteForRole(role)} replace />
  }

  return <>{children}</>
}
