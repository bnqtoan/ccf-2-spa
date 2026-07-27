// T-19 — client auth cho SPA. Phiên là cookie httpOnly ký phía server: SPA
// KHÔNG đọc/lưu token (tránh XSS — card cạm bẫy). Cookie same-origin tự đính
// vào mọi request /api/* nên các fetch admin sẵn có không phải sửa. Ta chỉ gọi
// 3 endpoint auth và để cookie tự lo phần còn lại.
//
// `credentials: 'same-origin'` là mặc định của fetch cho same-origin, nhưng khai
// tường minh để ý định rõ ràng và an toàn nếu sau này đổi origin.

export interface SessionState {
  authenticated: boolean
}

/** GET /api/auth/session — phiên hiện tại còn hợp lệ không? Luôn 200. */
export async function fetchSession(): Promise<boolean> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' })
  if (!res.ok) return false
  const body = (await res.json()) as SessionState
  return body.authenticated === true
}

/**
 * POST /api/auth/login. Trả `true` khi đăng nhập thành công (server đã set
 * cookie phiên). Trả `false` khi mật khẩu sai (401). Ném lỗi khi mạng/hệ thống
 * hỏng để UI phân biệt "sai mật khẩu" với "không gọi được máy chủ".
 */
export async function login(password: string): Promise<boolean> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  })
  if (res.status === 401) return false
  if (!res.ok) throw new Error('login-failed')
  return true
}

/** POST /api/auth/logout — xoá cookie phiên. Idempotent. */
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}
