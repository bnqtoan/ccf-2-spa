// T-19 — guard cho mọi route SPA /admin/*. Bọc quanh trang admin: hỏi server
// phiên còn hợp lệ không; chưa đăng nhập → redirect /login (giữ lại đích để
// quay lại sau khi login). Đang kiểm → hiện trạng thái chờ ngắn, không nháy nội
// dung admin ra trước.
//
// Nguồn sự thật là server (GET /api/auth/session) — KHÔNG tự đoán từ cookie phía
// client (cookie httpOnly, JS không đọc được, đúng ý đồ chống XSS).

import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { fetchSession } from '../../../lib/authClient'

type Status = 'checking' | 'authed' | 'anon'

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('checking')
  const location = useLocation()

  useEffect(() => {
    let alive = true
    fetchSession()
      .then((ok) => {
        if (alive) setStatus(ok ? 'authed' : 'anon')
      })
      .catch(() => {
        if (alive) setStatus('anon')
      })
    return () => {
      alive = false
    }
  }, [])

  if (status === 'checking') {
    return (
      <div style={{ padding: 24, color: 'var(--ink-2)' }} data-testid="auth-checking">
        Đang kiểm tra đăng nhập…
      </div>
    )
  }

  if (status === 'anon') {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }

  return <>{children}</>
}
