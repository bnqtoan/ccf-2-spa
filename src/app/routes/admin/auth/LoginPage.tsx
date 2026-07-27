// T-19 — trang đăng nhập admin. Một ô mật khẩu chung (phương án (a)). Đúng →
// server set cookie phiên → điều hướng tới `?next=` (mặc định /admin). Sai →
// hiện "Mật khẩu không đúng" bằng tiếng Việt tự nhiên, KHÔNG lộ mã lỗi thô.
//
// Nếu đã có phiên hợp lệ mà mở /login → đẩy thẳng vào đích (khỏi bắt đăng nhập
// lại).

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { fetchSession, login } from '../../../lib/authClient'
import './login.css'

function safeNext(raw: string | null): string {
  // Chỉ nhận path nội bộ bắt đầu bằng một dấu '/' — chặn open-redirect
  // (//evil.com hay http://…). Không hợp lệ → về /admin.
  if (!raw) return '/admin'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/admin'
  return raw
}

export default function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = safeNext(params.get('next'))

  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Đã đăng nhập rồi thì khỏi bắt nhập lại.
  useEffect(() => {
    let alive = true
    fetchSession().then((ok) => {
      if (alive && ok) navigate(next, { replace: true })
    })
    return () => {
      alive = false
    }
  }, [navigate, next])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const ok = await login(password)
      if (ok) {
        navigate(next, { replace: true })
      } else {
        setError('Mật khẩu không đúng.')
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
        <p>Nhập mật khẩu để vào khu quản lý.</p>
        <label htmlFor="ccf-login-pw">Mật khẩu</label>
        <input
          id="ccf-login-pw"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="login-password"
          autoFocus
        />
        {error && (
          <div className="ccf-login-error" role="alert" data-testid="login-error">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || password === ''} data-testid="login-submit">
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>
    </div>
  )
}
