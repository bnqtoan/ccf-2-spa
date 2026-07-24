import { Link } from 'react-router-dom'
import './AdminPage.css'

/**
 * Trang chủ khu quản lý. Trước đây chỉ là placeholder trống ("Trang quản trị
 * viên.") từ scaffold — lễ tân mở /admin sẽ lạc vì không có lối vào các chức
 * năng thật (timeline, hàng chờ xếp lại). Đây là bảng điều hướng dẫn tới chúng.
 */
const CARDS = [
  {
    to: '/admin/timeline',
    icon: '📅',
    title: 'Lịch ngày',
    desc: 'Xem lịch tất cả kỹ thuật viên, nhận khách vãng lai, đổi trạng thái booking.',
  },
  {
    to: '/admin/reassign',
    icon: '🔁',
    title: 'Hàng chờ xếp lại',
    desc: 'Các lịch bị ảnh hưởng khi kỹ thuật viên nghỉ đột xuất — gọi khách và chuyển người.',
  },
  {
    to: '/admin/setup',
    icon: '⚙️',
    title: 'Thiết lập',
    desc: 'Quản lý nhân viên, kỹ năng, dịch vụ, gói và ca làm việc.',
  },
  {
    to: '/',
    icon: '🌿',
    title: 'Trang đặt lịch của khách',
    desc: 'Mở giao diện khách nhìn thấy khi đặt lịch.',
  },
]

export default function AdminPage() {
  return (
    <div className="ccf-adm-home">
      <header className="ccf-adm-head">
        <h1>Sen Spa · Quản lý</h1>
        <p>Chọn khu vực cần làm việc.</p>
      </header>
      <nav className="ccf-adm-grid">
        {CARDS.map((c) => (
          <Link key={c.to} to={c.to} className="ccf-adm-card" data-testid={`admin-nav-${c.to}`}>
            <span className="ccf-adm-card-icon" aria-hidden="true">
              {c.icon}
            </span>
            <span className="ccf-adm-card-body">
              <span className="ccf-adm-card-title">{c.title}</span>
              <span className="ccf-adm-card-desc">{c.desc}</span>
            </span>
            <span className="ccf-adm-card-chev" aria-hidden="true">
              ›
            </span>
          </Link>
        ))}
      </nav>
    </div>
  )
}
