// T-19 — logic thuần cho auth admin (KHÔNG query DB, theo CONVENTIONS §7).
//
// Cơ chế (phương án (a) đã chốt): một MẬT KHẨU ADMIN chung. Đăng nhập đúng →
// phát một PHIÊN dạng token KÝ bằng HMAC-SHA256 với SESSION_SECRET, đặt vào một
// cookie httpOnly. Không multi-user, không bảng admin_users, không OAuth.
//
// Token = base64url(payloadJson) + '.' + base64url(hmac(payloadJson)). payload
// chứa `exp` (epoch giây) để phiên có hạn. Xác thực = chữ ký khớp VÀ chưa hết
// hạn. Đây là hàm thuần: nhận secret + chuỗi, trả boolean/token — route lo đọc
// c.env và set/clear cookie.
//
// So sánh chữ ký dùng so-sánh-thời-gian-hằng để không rò rỉ qua timing.

/** Tên cookie phiên admin. httpOnly nên SPA không đọc trực tiếp — tránh XSS. */
export const SESSION_COOKIE = 'ccf_admin_session'

/** Thời hạn phiên mặc định: 12 giờ (một ca làm việc). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60

/** Ba vai trò của hệ (T-22). Nguồn sự thật cho CHECK ở migration 0004. */
export type Role = 'owner' | 'receptionist' | 'technician'

export const ROLES: readonly Role[] = ['owner', 'receptionist', 'technician']

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x)
}

/**
 * Phiên ĐÃ XÁC THỰC — payload đã ký HMAC (client không giả được role). T-22 mở
 * rộng T-19: thêm userId/role/staffId. Route đọc c.get('user') để lọc theo role.
 */
export interface AuthUser {
  userId: number
  role: Role
  /** Chỉ technician có staffId (link tới dòng staff của họ). owner/lễ tân: null. */
  staffId: number | null
}

interface SessionPayload {
  /** Đánh dấu đây là phiên admin. Giữ 'admin' để tương thích T-19. */
  sub: 'admin'
  /** id user trong bảng users (T-22). */
  uid: number
  /** vai trò (T-22) — ký trong payload nên không giả mạo được. */
  role: Role
  /** staff_id nếu là technician, else null (T-22). */
  sid: number | null
  /** Phát hành lúc (epoch giây). */
  iat: number
  /** Hết hạn lúc (epoch giây). */
  exp: number
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecodeToString(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return atob(b64 + pad)
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  // Copy into an ArrayBuffer-backed view: TextEncoder().encode() types as
  // ArrayBufferLike (may be SharedArrayBuffer), which crypto.subtle rejects
  // under the strict lib types. This normalizes it to a plain ArrayBuffer.
  const src = new TextEncoder().encode(s)
  const out = new Uint8Array(new ArrayBuffer(src.byteLength))
  out.set(src)
  return out
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, utf8(message))
  return new Uint8Array(sig)
}

/** So sánh hai chuỗi theo thời gian hằng (không thoát sớm ở byte đầu khác). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Kiểm tra mật khẩu đăng nhập so với secret ADMIN_PASSWORD.
 * `expected` là giá trị từ c.env.ADMIN_PASSWORD (có thể undefined nếu chưa cấu
 * hình → luôn từ chối, fail-closed).
 */
export function checkPassword(input: unknown, expected: string | undefined): boolean {
  if (typeof input !== 'string' || input === '') return false
  if (typeof expected !== 'string' || expected === '') return false
  return timingSafeEqual(input, expected)
}

/**
 * Phát một token phiên đã ký. `now` epoch giây (route truyền vào để test được
 * xác định). TTL mặc định một ca làm việc. T-22: token mang userId/role/staffId
 * — ký HMAC nên client KHÔNG giả được role.
 */
export async function issueSessionToken(
  secret: string,
  now: number,
  ttlSeconds: number = SESSION_TTL_SECONDS,
  user?: AuthUser,
): Promise<string> {
  const payload: SessionPayload = {
    sub: 'admin',
    uid: user?.userId ?? 0,
    role: user?.role ?? 'owner',
    sid: user?.staffId ?? null,
    iat: now,
    exp: now + ttlSeconds,
  }
  const payloadStr = JSON.stringify(payload)
  const payloadB64 = base64urlEncode(utf8(payloadStr))
  const sig = await hmacSha256(secret, payloadB64)
  return `${payloadB64}.${base64urlEncode(sig)}`
}

/**
 * Xác thực một token phiên. Trả `true` khi chữ ký khớp secret VÀ chưa hết hạn
 * tại thời điểm `now`. Mọi trường hợp hỏng (thiếu, sai định dạng, chữ ký sai,
 * hết hạn) đều trả `false` — không phân biệt lý do ra ngoài (không rò rỉ).
 */
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string | undefined,
  now: number,
): Promise<boolean> {
  return (await readSession(token, secret, now)) !== null
}

/**
 * Như verifySessionToken nhưng trả AuthUser đã ký (userId/role/staffId) khi hợp
 * lệ, else null. Guard dùng hàm này để `c.set('user', …)`. role LẤY TỪ payload
 * ĐÃ KÝ — không bao giờ từ query/header client (card cạm bẫy #2).
 */
export async function readSession(
  token: string | undefined | null,
  secret: string | undefined,
  now: number,
): Promise<AuthUser | null> {
  if (typeof token !== 'string' || token === '') return null
  if (typeof secret !== 'string' || secret === '') return null

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  const expectedSig = base64urlEncode(await hmacSha256(secret, payloadB64))
  if (!timingSafeEqual(sigB64, expectedSig)) return null

  let payload: SessionPayload
  try {
    payload = JSON.parse(base64urlDecodeToString(payloadB64)) as SessionPayload
  } catch {
    return null
  }
  if (payload.sub !== 'admin') return null
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
  if (now >= payload.exp) return null
  if (!isRole(payload.role)) return null

  const uid = typeof payload.uid === 'number' && Number.isInteger(payload.uid) ? payload.uid : 0
  const sid =
    typeof payload.sid === 'number' && Number.isInteger(payload.sid) && payload.sid > 0 ? payload.sid : null
  return { userId: uid, role: payload.role, staffId: sid }
}

/**
 * requireRole(...roles) — logic thuần authorization: user có role thuộc danh
 * sách cho phép không? Route load user từ c.get('user') rồi gọi hàm này; true →
 * cho qua, false → route trả 403 FORBIDDEN. Không query DB (CONVENTIONS §7).
 */
export function requireRole(user: AuthUser | null | undefined, ...allowed: Role[]): boolean {
  if (user == null) return false
  return allowed.includes(user.role)
}

// --- Mật khẩu: PBKDF2/SHA-256 qua crypto.subtle -----------------------------
//
// KHÔNG bcrypt (không có trong Workers runtime — card cạm bẫy). Hash tự mô tả:
//   pbkdf2$<iterations>$<saltB64url>$<hashB64url>
// so khớp constant-time. Salt ngẫu nhiên mỗi user → hai user cùng mật khẩu ra
// hash khác nhau.

const PBKDF2_ITERATIONS = 100_000
const PBKDF2_HASH_LEN = 32 // bytes (256-bit)

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', utf8(password), { name: 'PBKDF2' }, false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    PBKDF2_HASH_LEN * 8,
  )
  return new Uint8Array(bits)
}

function base64urlDecodeToBytes(s: string): Uint8Array {
  const bin = base64urlDecodeToString(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Băm một mật khẩu mới (dùng khi owner tạo/đặt lại user). Salt ngẫu nhiên. */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64urlEncode(salt)}$${base64urlEncode(hash)}`
}

/**
 * So mật khẩu người dùng nhập với hash đã lưu. Constant-time. Mọi trường hợp
 * hỏng (định dạng sai, thiếu) → false (fail-closed). KHÔNG ném lỗi ra ngoài.
 */
export async function verifyPassword(password: unknown, stored: string | undefined | null): Promise<boolean> {
  if (typeof password !== 'string' || password === '') return false
  if (typeof stored !== 'string' || stored === '') return false
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations <= 0) return false
  let salt: Uint8Array
  let expected: string
  try {
    salt = base64urlDecodeToBytes(parts[2]!)
    expected = parts[3]!
  } catch {
    return false
  }
  const actual = base64urlEncode(await pbkdf2(password, salt, iterations))
  return timingSafeEqual(actual, expected)
}
