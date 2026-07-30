import { useState } from 'react'
import StaffTab from './StaffTab'
import ServicesTab from './ServicesTab'
import ShiftsTab from './ShiftsTab'
import './setup.css'

type TabKey = 'staff' | 'services' | 'shifts'

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'staff', label: 'Nhân viên', icon: '👤' },
  { key: 'services', label: 'Dịch vụ', icon: '🧴' },
  { key: 'shifts', label: 'Ca làm việc', icon: '🕒' },
]

/**
 * Trang Thiết lập (T-17) — CRUD nền cho nhân viên/skill, dịch vụ/gói, ca làm
 * việc. Backend (T-06) đã đủ 19 endpoint; đây là giao diện còn thiếu.
 *
 * Ba khu vực dạng tab thay vì 3 route con riêng: dữ liệu liên quan chặt (gán
 * skill cần danh sách skill, gói cần danh sách dịch vụ) nên giữ trong một
 * trang, chuyển tab không mất state đã tải.
 */
export default function SetupPage() {
  const [tab, setTab] = useState<TabKey>('staff')

  return (
    <div className="ccf-su-page">
      <header className="ccf-su-head">
        <h1>Thiết lập</h1>
        <p>Quản lý nhân viên, kỹ năng, dịch vụ, gói và ca làm việc.</p>
      </header>

      <div className="ccf-su-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`ccf-su-tab${tab === t.key ? ' ccf-su-tab--active' : ''}`}
            data-testid={`setup-tab-${t.key}`}
            onClick={() => setTab(t.key)}
          >
            <span aria-hidden="true">{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {/* Ba tab giữ mounted song song (ẩn bằng CSS thay vì unmount) để state
          đã tải (danh sách, kỹ năng vừa gán trong phiên...) không mất khi
          chuyển qua lại giữa các tab.
          Mỗi tab nhận `active` để tự refetch nhân viên/kỹ năng khi được CHUYỂN
          TỚI (không chỉ lúc mount) — bug thật tự phát hiện khi kiểm bằng
          trình duyệt: thêm nhân viên ở tab Nhân viên rồi sang tab Ca làm việc
          ngay, dropdown chọn nhân viên KHÔNG có người vừa thêm vì ShiftsTab
          chỉ fetch một lần lúc mount trang, không biết StaffTab vừa đổi dữ
          liệu. Vi phạm đúng định nghĩa "xong" của card (mọi thao tác qua UI,
          không cần F5). */}
      <div className="ccf-su-body" hidden={tab !== 'staff'}>
        <StaffTab />
      </div>
      <div className="ccf-su-body" hidden={tab !== 'services'}>
        <ServicesTab active={tab === 'services'} />
      </div>
      <div className="ccf-su-body" hidden={tab !== 'shifts'}>
        <ShiftsTab active={tab === 'shifts'} />
      </div>
    </div>
  )
}
