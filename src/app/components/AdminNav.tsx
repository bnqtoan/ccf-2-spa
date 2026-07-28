import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useSession, canAccess, type NavKey } from '../lib/useSession'
import { logout } from '../lib/authClient'
import './AdminNav.css'

/**
 * Thanh điều hướng dùng chung cho các màn quản trị. T-22: LỌC THEO ROLE — mỗi
 * vai trò chỉ thấy mục mình có quyền (defense-in-depth; server mới là gate thật).
 * technician chỉ thấy "Lịch ngày"; lễ tân thấy timeline/reassign/setup; owner
 * thấy thêm Tổng quan + Người dùng. Kèm nút Đăng xuất.
 */
const LINKS: { to: string; label: string; icon: string; key: NavKey }[] = [
  { to: '/admin/overview', label: 'Tổng quan', icon: '📊', key: 'overview' },
  { to: '/admin/timeline', label: 'Lịch ngày', icon: '📅', key: 'timeline' },
  { to: '/admin/reassign', label: 'Hàng chờ xếp lại', icon: '🔁', key: 'reassign' },
  { to: '/admin/setup', label: 'Thiết lập', icon: '⚙️', key: 'setup' },
  { to: '/admin/users', label: 'Người dùng', icon: '👥', key: 'users' },
]

export default function AdminNav() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { role } = useSession()

  // technician không có "hub" /admin (họ vào thẳng timeline) → logo trỏ timeline.
  const homeTo = role === 'technician' ? '/admin/timeline' : '/admin'
  const visible = LINKS.filter((l) => canAccess(role, l.key))

  async function onLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <nav className="ccf-adm-nav" data-testid="admin-nav">
      <Link to={homeTo} className="ccf-adm-nav-home" data-testid="admin-nav-home" aria-label="Trang quản lý">
        Sen Spa
      </Link>
      <div className="ccf-adm-nav-links">
        {visible.map((l) => {
          const active = pathname === l.to
          return (
            <Link
              key={l.to}
              to={l.to}
              className={`ccf-adm-nav-link${active ? ' ccf-adm-nav-link--active' : ''}`}
              aria-current={active ? 'page' : undefined}
              data-testid={`admin-nav-link-${l.to}`}
            >
              <span aria-hidden="true">{l.icon}</span> {l.label}
            </Link>
          )
        })}
        <button
          type="button"
          className="ccf-adm-nav-link ccf-adm-nav-logout"
          onClick={onLogout}
          data-testid="admin-nav-logout"
        >
          <span aria-hidden="true">🚪</span> Đăng xuất
        </button>
      </div>
    </nav>
  )
}
