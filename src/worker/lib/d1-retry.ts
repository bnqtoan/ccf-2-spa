// Busy-retry cho D1 — cấp cho tầng worker cái `busy_timeout` mà D1 KHÔNG cho
// đặt bằng `PRAGMA` (SQLITE_AUTH). Bọc binding `env.DB` một lần ở middleware;
// mọi route hưởng chung, không sửa từng handler.
//
// VÌ SAO CẦN: E2E chạy HAI instance miniflare cùng persist vào một file
// `.wrangler/state/.../*.sqlite` (dev-server + seed helper). Ghi-của-seed va
// đọc-của-dev-server → `SQLITE_BUSY` / "internal error" thoáng qua Ở PHÍA
// dev-server phục vụ request thật. Phía seed đã có busy-retry (tests/e2e/_seed.ts),
// nhưng phía app phục vụ HTTP thì KHÔNG có móc nào → request 500, lưới slot rỗng
// giữa chừng, test đỏ ngẫu nhiên trong CI (customer-reschedule.spec.ts:43).
// Trong production, D1 cũng có thể trả "internal error" thoáng qua dưới tải —
// nên retry đúng-tầng ở đây là HARDENING thật, không phải mẹo chỉ-cho-test.
//
// AN TOÀN NGHIỆP VỤ (ràng buộc then-chốt): CHỈ retry lỗi HẠ TẦNG thoáng qua
// (SQLITE_BUSY / database is locked / internal error) — nhận diện theo SHAPE của
// lỗi NÉM RA. KHÔNG bao giờ retry lỗi nghiệp vụ (SLOT_TAKEN, CANCEL_TOO_LATE,
// STAFF_LACKS_SKILL): retry SLOT_TAKEN = double-booking im lặng. Các lỗi nghiệp
// vụ này là GIÁ TRỊ TRẢ VỀ (vd `meta.changes === 0`), KHÔNG phải throw — nên
// chúng không bao giờ chạm nhánh retry. Giữ nguyên tính chất đó.
//
// AN TOÀN VỚI GHI: SQLITE_BUSY nghĩa là KHÔNG chiếm được khoá → câu ghi CHƯA
// bắt đầu → retry không thể áp dụng hai lần. Vì vậy wrapper an toàn cho cả đọc
// lẫn ghi; ta bọc chung một lớp mỏng theo-tín-hiệu thay vì chỉ bọc ghi (vì lỗi
// CI thực tế nằm ở đường ĐỌC /api/availability — bọc-chỉ-ghi sẽ không sửa được).

/** Tín hiệu "khoá tạm thời, hãy thử lại" của SQLite/D1. So khớp theo message. */
const TRANSIENT_PATTERNS = ['SQLITE_BUSY', 'database is locked', 'internal error']

/** True nếu lỗi là khoá HẠ TẦNG thoáng qua (đáng retry). Mọi lỗi khác → false. */
export function isTransientD1Error(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err)
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p))
}

const MAX_ATTEMPTS = 4
const BACKOFF_MS = [25, 50, 100] // giữa các lần thử (attempt 1→2, 2→3, 3→4)

/** Chạy một thao tác D1, chờ-rồi-lặp KHI VÀ CHỈ KHI gặp khoá tạm thời. Lỗi
 *  khác (gồm mọi lỗi nghiệp vụ nếu có throw) ném NGAY, không retry. */
export async function withD1Retry<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await op()
    } catch (err) {
      if (!isTransientD1Error(err) || attempt === MAX_ATTEMPTS) throw err
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]))
    }
  }
  // Không tới được (vòng lặp luôn return/throw); thoả kiểu trả về.
  throw new Error('withD1Retry: unreachable')
}

// --- Bọc binding D1 bằng Proxy sao cho mọi thao tác terminal đều busy-retry ---
//
// Chuỗi API: `db.prepare(sql).bind(...).all()` — chỉ các method TERMINAL (thực
// sự chạm DB) mới cần retry: trên statement là first/all/run/raw; trên db là
// batch/exec. `prepare`/`bind` chỉ dựng câu (không chạm DB) → trả proxy tiếp để
// giữ chuỗi. Vì SQLITE_BUSY xảy ra ở lúc terminal chạy (chưa chiếm khoá), retry
// = dựng-lại lời gọi terminal từ cùng statement đã bind, an toàn.

const STMT_TERMINALS = new Set(['first', 'all', 'run', 'raw'])
const DB_TERMINALS = new Set(['batch', 'exec'])

function wrapStatement(stmt: D1PreparedStatement): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      const name = String(prop)
      if (name === 'bind') {
        // bind() trả statement mới đã gắn tham số — bọc tiếp để giữ retry.
        return (...args: unknown[]) => wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args))
      }
      if (STMT_TERMINALS.has(name)) {
        return (...args: unknown[]) => withD1Retry(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args))
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  })
}

/** Bọc một binding D1 sao cho mọi câu chạm DB tự busy-retry. Idempotent về
 *  hành vi: bọc lại lần nữa không hại (chỉ thêm một lớp Proxy vô hại). */
export function withRetryingD1(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      const name = String(prop)
      if (name === 'prepare') {
        return (sql: string) => wrapStatement((value as (s: string) => D1PreparedStatement).call(target, sql))
      }
      if (DB_TERMINALS.has(name)) {
        return (...args: unknown[]) => withD1Retry(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args))
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  })
}
