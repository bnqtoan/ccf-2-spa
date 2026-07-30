import { Link, useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, Calendar, LogOut, RefreshCw, Settings, Users, type LucideIcon } from 'lucide-react'
import { useSession, canAccess, type NavKey } from '../lib/useSession'
import { logout } from '../lib/authClient'
import './AdminNav.css'

/**
 * Thanh điều hướng dùng chung cho các màn quản trị. T-22: LỌC THEO ROLE — mỗi
 * vai trò chỉ thấy mục mình có quyền (defense-in-depth; server mới là gate thật).
 * technician chỉ thấy "Lịch ngày"; lễ tân thấy timeline/reassign/setup; owner
 * thấy thêm Tổng quan + Người dùng. Kèm nút Đăng xuất.
 */
const LINKS: { to: string; label: string; icon: LucideIcon; key: NavKey }[] = [
  { to: '/admin/overview', label: 'Tổng quan', icon: BarChart3, key: 'overview' },
  { to: '/admin/timeline', label: 'Lịch ngày', icon: Calendar, key: 'timeline' },
  { to: '/admin/reassign', label: 'Hàng chờ xếp lại', icon: RefreshCw, key: 'reassign' },
  { to: '/admin/setup', label: 'Thiết lập', icon: Settings, key: 'setup' },
  { to: '/admin/users', label: 'Người dùng', icon: Users, key: 'users' },
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
          const Icon = l.icon
          return (
            <Link
              key={l.to}
              to={l.to}
              className={`ccf-adm-nav-link${active ? ' ccf-adm-nav-link--active' : ''}`}
              aria-current={active ? 'page' : undefined}
              data-testid={`admin-nav-link-${l.to}`}
            >
              <Icon size="1em" className="ccf-ico-inline" aria-hidden="true" /> {l.label}
            </Link>
          )
        })}
        <button
          type="button"
          className="ccf-adm-nav-link ccf-adm-nav-logout"
          onClick={onLogout}
          data-testid="admin-nav-logout"
        >
          <LogOut size="1em" className="ccf-ico-inline" aria-hidden="true" /> Đăng xuất
        </button>
      </div>
    </nav>
  )
}
