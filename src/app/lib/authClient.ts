// T-19 — client auth cho SPA. Phiên là cookie httpOnly ký phía server: SPA
// KHÔNG đọc/lưu token (tránh XSS — card cạm bẫy). Cookie same-origin tự đính
// vào mọi request /api/* nên các fetch admin sẵn có không phải sửa. Ta chỉ gọi
// 3 endpoint auth và để cookie tự lo phần còn lại.
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
}

/**
 * GET /api/auth/session — phiên còn hợp lệ không + vai trò gì? Luôn 200. Trả cả
 * role để nav/guard lọc theo vai trò. Chưa đăng nhập → { authenticated: false }.
 */
export async function fetchSession(): Promise<SessionState> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' })
  if (!res.ok) return { authenticated: false }
  const body = (await res.json()) as SessionState
  return body.authenticated === true ? body : { authenticated: false }
}

/**
 * POST /api/auth/login — username + password (T-22). Trả role khi thành công
 * (server đã set cookie phiên). Trả `null` khi sai (401). Ném lỗi khi mạng hỏng
 * để UI phân biệt "sai đăng nhập" với "không gọi được máy chủ".
 */
export async function login(username: string, password: string): Promise<Role | null> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username, password }),
  })
  if (res.status === 401) return null
  if (!res.ok) throw new Error('login-failed')
  const body = (await res.json()) as { role: Role }
  return body.role
}

/** POST /api/auth/logout — xoá cookie phiên. Idempotent. */
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}
