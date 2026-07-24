import { Link, useLocation } from 'react-router-dom'
import './AdminNav.css'

/**
 * Thanh điều hướng dùng chung cho 3 màn quản trị (timeline / reassign / setup)
 * — trước đây chúng KHÔNG có lối qua lại nhau, lễ tân phải gõ tay URL hoặc
 * quay về /admin (G4). Đặt ở đầu mỗi màn để chuyển qua lại một chạm.
 */
const LINKS = [
  { to: '/admin/timeline', label: 'Lịch ngày', icon: '📅' },
  { to: '/admin/reassign', label: 'Hàng chờ xếp lại', icon: '🔁' },
  { to: '/admin/setup', label: 'Thiết lập', icon: '⚙️' },
]

export default function AdminNav() {
  const { pathname } = useLocation()
  return (
    <nav className="ccf-adm-nav" data-testid="admin-nav">
      <Link to="/admin" className="ccf-adm-nav-home" data-testid="admin-nav-home" aria-label="Trang quản lý">
        Sen Spa
      </Link>
      <div className="ccf-adm-nav-links">
        {LINKS.map((l) => {
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
      </div>
    </nav>
  )
}
