import { Link } from 'react-router-dom'
import { useSession, canAccess, type NavKey } from '../lib/useSession'
import './AdminPage.css'

/**
 * Trang chủ khu quản lý (owner/lễ tân — technician vào thẳng timeline). T-22:
 * LỌC THEO ROLE — chỉ hiện thẻ user có quyền (lễ tân không thấy "Tổng quan"/
 * "Người dùng"). Defense-in-depth; server mới là gate thật.
 */
const CARDS: { to: string; icon: string; title: string; desc: string; key?: NavKey }[] = [
  {
    to: '/admin/overview',
    icon: '📊',
    title: 'Tổng quan',
    desc: 'Doanh thu, tỷ lệ lấp đầy, khách không đến hôm nay — bấm 1 KTV xem tiền công.',
    key: 'overview',
  },
  {
    to: '/admin/timeline',
    icon: '📅',
    title: 'Lịch ngày',
    desc: 'Xem lịch tất cả kỹ thuật viên, nhận khách vãng lai, đổi trạng thái booking.',
    key: 'timeline',
  },
  {
    to: '/admin/reassign',
    icon: '🔁',
    title: 'Hàng chờ xếp lại',
    desc: 'Các lịch bị ảnh hưởng khi kỹ thuật viên nghỉ đột xuất — gọi khách và chuyển người.',
    key: 'reassign',
  },
  {
    to: '/admin/setup',
    icon: '⚙️',
    title: 'Thiết lập',
    desc: 'Quản lý nhân viên, kỹ năng, dịch vụ, gói và ca làm việc.',
    key: 'setup',
  },
  {
    to: '/admin/users',
    icon: '👥',
    title: 'Người dùng',
    desc: 'Thêm/sửa/vô hiệu tài khoản, gán vai trò và liên kết kỹ thuật viên.',
    key: 'users',
  },
  {
    to: '/',
    icon: '🌿',
    title: 'Trang đặt lịch của khách',
    desc: 'Mở giao diện khách nhìn thấy khi đặt lịch.',
    // Không có key → luôn hiện (trang khách công khai).
  },
]

export default function AdminPage() {
  const { role } = useSession()
  const cards = CARDS.filter((c) => c.key === undefined || canAccess(role, c.key))
  return (
    <div className="ccf-adm-home">
      <header className="ccf-adm-head">
        <h1>Sen Spa · Quản lý</h1>
        <p>Chọn khu vực cần làm việc.</p>
      </header>
      <nav className="ccf-adm-grid">
        {cards.map((c) => (
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
