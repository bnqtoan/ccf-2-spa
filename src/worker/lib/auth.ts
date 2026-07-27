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

interface SessionPayload {
  /** Đánh dấu đây là phiên admin. Single-tenant nên không cần user id. */
  sub: 'admin'
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
 * Phát một token phiên admin đã ký. `now` epoch giây (route truyền vào để test
 * được xác định). TTL mặc định một ca làm việc.
 */
export async function issueSessionToken(
  secret: string,
  now: number,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const payload: SessionPayload = { sub: 'admin', iat: now, exp: now + ttlSeconds }
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
  if (typeof token !== 'string' || token === '') return false
  if (typeof secret !== 'string' || secret === '') return false

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return false
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  const expectedSig = base64urlEncode(await hmacSha256(secret, payloadB64))
  if (!timingSafeEqual(sigB64, expectedSig)) return false

  let payload: SessionPayload
  try {
    payload = JSON.parse(base64urlDecodeToString(payloadB64)) as SessionPayload
  } catch {
    return false
  }
  if (payload.sub !== 'admin') return false
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return false
  if (now >= payload.exp) return false

  return true
}
