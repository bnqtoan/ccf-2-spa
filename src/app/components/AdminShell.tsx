// AdminShell — khung layout DÙNG CHUNG cho MỌI trang admin. Trước đây mỗi trang
// tự render <AdminNav/> + tự đặt container width riêng (overview 960, setup/users
// 720, timeline/reassign full) → nav và nội dung nhảy width khi chuyển trang.
// Shell này chuẩn hoá: một nav, một container width thống nhất, một padding.
// Trang con chỉ cung cấp NỘI DUNG bên trong, không tự bọc nav/width nữa.
import type { ReactNode } from 'react'
import AdminNav from './AdminNav'
import './AdminShell.css'

export default function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="ccf-shell">
      <AdminNav />
      <main className="ccf-shell-main">{children}</main>
    </div>
  )
}
