// T-19 → T-22 — trang đăng nhập. Username + password tra bảng users. Đúng →
// server set cookie phiên mang role → điều hướng theo role (technician: timeline;
// else: `?next=` hoặc /admin). Sai → "Tên đăng nhập hoặc mật khẩu không đúng"
// tiếng Việt tự nhiên, KHÔNG lộ mã lỗi thô (không phân biệt sai-user với sai-pw).
//
// Nếu đã có phiên hợp lệ mà mở /login → đẩy thẳng vào trang mặc định của role.

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { fetchSession, login } from '../../../lib/authClient'
import { defaultRouteForRole } from './roleHome'
import type { Role } from '../../../lib/authClient'
import './login.css'

function safeNext(raw: string | null): string | null {
  // Chỉ nhận path nội bộ bắt đầu bằng một dấu '/' — chặn open-redirect
  // (//evil.com hay http://…). Không hợp lệ → null (dùng trang mặc định của role).
  if (!raw) return null
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  return raw
}

export default function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = safeNext(params.get('next'))

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function go(role: Role, mustChangePassword: boolean) {
    // T-23 — mật khẩu mặc định lần đầu → bắt đổi TRƯỚC, bỏ qua mọi `next`/trang
    // mặc định của role (RequireAuth cũng chặn lại nếu vào thẳng URL khác).
    if (mustChangePassword) {
      navigate('/admin/change-password', { replace: true })
      return
    }
    // technician chỉ có lịch của mình → luôn về timeline, kể cả khi `next` trỏ
    // tới trang ngoài quyền (guard sẽ tự đẩy về, nhưng tránh nháy).
    if (role === 'technician') {
      navigate('/admin/timeline', { replace: true })
      return
    }
    navigate(next ?? defaultRouteForRole(role), { replace: true })
  }

  // Đã đăng nhập rồi thì khỏi bắt nhập lại.
  useEffect(() => {
    let alive = true
    fetchSession().then((s) => {
      if (alive && s.authenticated && s.role) go(s.role, s.mustChangePassword === true)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const result = await login(username.trim(), password)
      if (result) {
        go(result.role, result.mustChangePassword)
      } else {
        setError('Tên đăng nhập hoặc mật khẩu không đúng.')
      }
    } catch {
      setError('Không kết nối được máy chủ. Vui lòng thử lại.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ccf-login">
      <form className="ccf-login-card" onSubmit={onSubmit} data-testid="login-form">
        <h1>Sen Spa · Quản lý</h1>
        <p>Nhập tên đăng nhập và mật khẩu để vào khu quản lý.</p>
        <label htmlFor="ccf-login-user">Tên đăng nhập</label>
        <input
          id="ccf-login-user"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          data-testid="login-username"
          autoFocus
        />
        <label htmlFor="ccf-login-pw">Mật khẩu</label>
        <input
          id="ccf-login-pw"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="login-password"
        />
        {error && (
          <div className="ccf-login-error" role="alert" data-testid="login-error">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || username === '' || password === ''} data-testid="login-submit">
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>
    </div>
  )
}
