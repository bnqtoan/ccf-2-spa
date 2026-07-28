// T-22 — hook đọc phiên hiện tại (authenticated + role) cho SPA. Dùng chung cho
// RequireAuth (guard) và AdminNav/AdminPage (lọc mục theo role). Nguồn sự thật là
// server (GET /api/auth/session) — KHÔNG tự đoán role phía client (cookie httpOnly).
//
// Lọc UI theo role là DEFENSE-IN-DEPTH: ẩn mục không có quyền để người dùng khỏi
// bấm nhầm, NHƯNG server mới là gate thật (role-gate/row-filter/ownership-check).

import { useEffect, useState } from 'react'
import { fetchSession, type Role, type SessionState } from './authClient'

export type SessionStatus = 'checking' | 'ready'

export interface UseSessionResult {
  status: SessionStatus
  authenticated: boolean
  role: Role | null
}

export function useSession(): UseSessionResult {
  const [state, setState] = useState<{ status: SessionStatus; session: SessionState }>({
    status: 'checking',
    session: { authenticated: false },
  })

  useEffect(() => {
    let alive = true
    fetchSession()
      .then((s) => {
        if (alive) setState({ status: 'ready', session: s })
      })
      .catch(() => {
        if (alive) setState({ status: 'ready', session: { authenticated: false } })
      })
    return () => {
      alive = false
    }
  }, [])

  return {
    status: state.status,
    authenticated: state.session.authenticated,
    role: state.session.role ?? null,
  }
}

/** Mỗi role thấy những mục quản trị nào (dùng cho nav + trang chủ admin). */
export function canAccess(role: Role | null, key: NavKey): boolean {
  if (role === null) return false
  return NAV_ACCESS[key].includes(role)
}

export type NavKey = 'overview' | 'timeline' | 'reassign' | 'setup' | 'users'

// Ma trận quyền cho từng khu (khớp server RBAC):
//   overview (tiền/lương) — owner.
//   timeline / reassign   — owner + lễ tân + KTV (KTV thấy row-filter của mình).
//   setup (nhân viên/ca/giá) — owner + lễ tân (giá chỉ owner sửa được, server chặn).
//   users (quản lý user)  — owner.
const NAV_ACCESS: Record<NavKey, Role[]> = {
  overview: ['owner'],
  timeline: ['owner', 'receptionist', 'technician'],
  reassign: ['owner', 'receptionist'],
  setup: ['owner', 'receptionist'],
  users: ['owner'],
}
