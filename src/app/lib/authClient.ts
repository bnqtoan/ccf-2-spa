// T-19 — client auth cho SPA. Phiên là cookie httpOnly ký phía server: SPA
// KHÔNG đọc/lưu token (tránh XSS — card cạm bẫy). Cookie same-origin tự đính
// vào mọi request /api/* nên các fetch admin sẵn có không phải sửa. Ta chỉ gọi
// các endpoint auth và để cookie tự lo phần còn lại.
//
// `credentials: 'same-origin'` là mặc định của fetch cho same-origin, nhưng khai
// tường minh để ý định rõ ràng và an toàn nếu sau này đổi origin.

// T-22 — ba vai trò. role quyết định nav + guard route phía SPA (defense-in-depth;
// server mới là gate thật).
export type Role = 'owner' | 'receptionist' | 'technician'

export interface SessionState {
  authenticated: boolean
  role?: Role
  staffId?: number | null
  /** T-23 — true → guard chặn vào /admin/*, phải đổi mật khẩu trước. */
  mustChangePassword?: boolean
}

/**
 * GET /api/auth/session — phiên còn hợp lệ không + vai trò gì? Luôn 200. Trả cả
 * role + must_change_password để nav/guard lọc theo vai trò / chặn đổi mật khẩu.
 * Chưa đăng nhập → { authenticated: false }.
 */
export async function fetchSession(): Promise<SessionState> {
  // cache: 'no-store' — phòng-thủ-kép cùng header Cache-Control: no-store phía
  // server (T-23). Không có cả hai thì sau đổi mật khẩu, fetch() có thể trả bản
  // cache CŨ (must_change_password vẫn true) → guard kẹt lại màn đổi mật khẩu dù
  // server đã đổi xong. Đã thấy thật khi test tay luồng này.
  const res = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
  if (!res.ok) return { authenticated: false }
  const body = (await res.json()) as {
    authenticated: boolean
    role?: Role
    staffId?: number | null
    must_change_password?: boolean
  }
  if (body.authenticated !== true) return { authenticated: false }
  return {
    authenticated: true,
    role: body.role,
    staffId: body.staffId,
    mustChangePassword: body.must_change_password === true,
  }
}

export interface LoginResult {
  role: Role
  mustChangePassword: boolean
}

/**
 * POST /api/auth/login — username + password (T-22). Trả role + must_change_
 * password khi thành công (server đã set cookie phiên; T-23). Trả `null` khi
 * sai (401). Ném lỗi khi mạng hỏng để UI phân biệt "sai đăng nhập" với "không
 * gọi được máy chủ".
 */
export async function login(username: string, password: string): Promise<LoginResult | null> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username, password }),
  })
  if (res.status === 401) return null
  if (!res.ok) throw new Error('login-failed')
  const body = (await res.json()) as { role: Role; must_change_password?: boolean }
  return { role: body.role, mustChangePassword: body.must_change_password === true }
}

/** POST /api/auth/logout — xoá cookie phiên. Idempotent. */
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}

/**
 * POST /api/auth/change-password — đổi mật khẩu CỦA CHÍNH MÌNH (T-23). Trả
 * `true` khi thành công (server đã cập nhật must_change_password=0 + phát cookie
 * mới). Trả `false` khi mật khẩu hiện tại sai (401) hoặc mật khẩu mới không hợp
 * lệ (422). Ném lỗi khi mạng hỏng.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  })
  if (res.status === 401 || res.status === 422) return false
  if (!res.ok) throw new Error('change-password-failed')
  return true
}
