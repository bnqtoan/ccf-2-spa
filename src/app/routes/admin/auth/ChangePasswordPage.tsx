// T-23 — bắt đổi mật khẩu lần đầu. RequireAuth (allow=bất kỳ role đã đăng nhập)
// đẩy mọi user có mustChangePassword=true tới đây TRƯỚC khi cho vào bất kỳ
// trang admin nào khác (kể cả /admin trang chủ). Sau khi đổi thành công, server
// đã phát cookie phiên mới (mustChangePassword=false) → điều hướng thẳng vào
// trang mặc định của role, không bắt đăng nhập lại.
//
// Lý do tồn tại: owner gốc seed với mật khẩu mặc định CỐ ĐỊNH 'admin123' (công
// khai trong tài liệu bàn giao, KHÔNG phải secret) — bắt đổi ngay lần đầu để
// mặc định đó không tồn tại lâu trên production.

import { useState } from 'react'
import { changePassword } from '../../../lib/authClient'
import { useSession } from '../../../lib/useSession'
import { defaultRouteForRole } from './roleHome'
import './login.css'

export default function ChangePasswordPage() {
  const { role } = useSession()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setError(null)

    if (newPassword.length < 6) {
      setError('Mật khẩu mới phải có ít nhất 6 ký tự.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Xác nhận mật khẩu không khớp.')
      return
    }

    setBusy(true)
    try {
      const ok = await changePassword(currentPassword, newPassword)
      if (ok) {
        // T-23 cạm bẫy phát hiện khi test tay: điều hướng SPA (react-router
        // navigate()) ở đây bị bounce ngược lại /admin/change-password — guard
        // RequireAuth() bọc /admin TÁI SỬ DỤNG instance/hook state CŨ của chính
        // RequireAuth() đang bọc trang này (cùng vị trí trong cây route), nên
        // useSession() vẫn thấy mustChangePassword=true của phiên TRƯỚC KHI đổi,
        // dù server đã đổi xong (network log xác nhận). RELOAD TRANG THẬT (không
        // phải SPA navigate) buộc mount lại từ đầu — không có state cũ nào sống
        // sót được, luôn tra phiên MỚI 100%.
        const dest = role === 'technician' ? '/admin/timeline' : defaultRouteForRole(role)
        window.location.assign(dest)
      } else {
        setError('Mật khẩu hiện tại không đúng.')
      }
    } catch {
      setError('Không kết nối được máy chủ. Vui lòng thử lại.')
    } finally {
      setBusy(false)
    }
  }

  const disabled =
    busy || currentPassword === '' || newPassword === '' || confirmPassword === ''

  return (
    <div className="ccf-login">
      <form className="ccf-login-card" onSubmit={onSubmit} data-testid="change-password-form">
        <h1>Đổi mật khẩu</h1>
        <p>Đây là mật khẩu mặc định lần đầu. Vui lòng đặt mật khẩu mới trước khi tiếp tục.</p>

        <label htmlFor="ccf-cp-current">Mật khẩu hiện tại</label>
        <input
          id="ccf-cp-current"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          data-testid="change-password-current"
          autoFocus
        />

        <label htmlFor="ccf-cp-new">Mật khẩu mới (≥ 6 ký tự)</label>
        <input
          id="ccf-cp-new"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          data-testid="change-password-new"
        />

        <label htmlFor="ccf-cp-confirm">Xác nhận mật khẩu mới</label>
        <input
          id="ccf-cp-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          data-testid="change-password-confirm"
        />

        {error && (
          <div className="ccf-login-error" role="alert" data-testid="change-password-error">
            {error}
          </div>
        )}

        <button type="submit" disabled={disabled} data-testid="change-password-submit">
          {busy ? 'Đang đổi…' : 'Đổi mật khẩu'}
        </button>
      </form>
    </div>
  )
}
