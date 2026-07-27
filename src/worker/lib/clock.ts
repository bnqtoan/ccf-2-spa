// Nguồn thời gian "bây giờ" DUY NHẤT của server (epoch giây).
//
// Vì sao tồn tại: trước đây mỗi route tự gọi `Math.floor(Date.now() / 1000)`
// rải rác ~12 chỗ. Không inject được đồng hồ → test phụ thuộc giờ thật của máy
// chạy (vd walk-in gần nửa đêm tạo block tràn ngày, đỏ chỉ trong khung
// 23:25–23:59). Gom về đây để test cố định được "now".
//
// AN TOÀN PRODUCTION: đồng hồ giả CHỈ bật khi env có cờ `TEST_CLOCK === '1'`.
// Production KHÔNG set cờ đó → header/biến test bị BỎ QUA hoàn toàn, luôn trả
// `Date.now()`. Client không thể tự giả "now" vì thiếu cờ (cờ chỉ có trong
// .dev.vars / vitest bindings, không bao giờ deploy).

/** Đọc TEST_NOW_SEC từ env (fallback tĩnh cho vitest). Bỏ qua nếu không hợp lệ. */
function fromEnv(env: unknown): number | null {
  const flag = (env as { TEST_CLOCK?: unknown } | undefined)?.TEST_CLOCK
  if (flag !== '1') return null
  const raw = (env as { TEST_NOW_SEC?: unknown }).TEST_NOW_SEC
  if (typeof raw === 'string' && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return null
}

/** `nowSec(env)` — dùng khi chỉ có env (vitest, hoặc chỗ không có request).
 *  Chỉ tin TEST_NOW_SEC khi TEST_CLOCK==='1'. */
export function nowSec(env?: unknown): number {
  return fromEnv(env) ?? Math.floor(Date.now() / 1000)
}

/** `serverNow(c)` — dùng trong route handler: cho phép e2e cố định "now"
 *  PER-REQUEST qua header `X-Test-Now` (epoch giây), NHƯNG chỉ khi env bật cờ
 *  `TEST_CLOCK==='1'`. Không có cờ → header bị bỏ qua, trả đồng hồ thật. Header
 *  ưu tiên hơn TEST_NOW_SEC tĩnh để mỗi test đặt mốc riêng. */
export function serverNow(c: {
  env: unknown
  req: { header: (name: string) => string | undefined }
}): number {
  const flagged = (c.env as { TEST_CLOCK?: unknown } | undefined)?.TEST_CLOCK === '1'
  if (flagged) {
    const raw = c.req.header('X-Test-Now')
    if (raw !== undefined && raw !== '') {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) return Math.floor(n)
    }
  }
  return nowSec(c.env)
}
