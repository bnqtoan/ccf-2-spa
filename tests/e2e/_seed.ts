// T-34 — Helper seed E2E ghi THẲNG vào D1 local qua binding in-process
// (`getPlatformProxy()` của wrangler), thay cho kiểu cũ spawn
// `execFileSync('npx wrangler d1 execute ...')` mỗi lần seed.
//
// Vì sao đổi: mỗi lần `wrangler d1 execute` là một cold-boot Node+wrangler+
// miniflare (~1.2s) mở THẲNG file SQLite cục bộ. Có ~29 call-site rải trên 6
// file, nhiều cái chạy mỗi test → 100+ cold-boot/lần chạy (~2+ phút chỉ để
// spawn), và nhiều tiến trình wrangler tranh cùng một file gây SQLITE_BUSY /
// ECONNRESET ngẫu nhiên (đây là ROOT CAUSE của cả chậm lẫn flaky mà T-33 đụng).
//
// `getPlatformProxy()` trả về binding D1 in-process (`env.DB`) dùng ĐÚNG API D1
// như app, KHÔNG spawn subprocess, KHÔNG thêm dependency, KHÔNG đọc thẳng file
// sqlite theo đường dẫn. Nó mở CÙNG store `.wrangler/state` mà dev-server (vite
// plugin, persistState '../../.wrangler/state') và test pool dùng — nên seed
// vào đây là dev-server đọc thấy ngay.
//
// QUY TẮC then-chốt (xem card T-34, Cạm bẫy): handle mở MỘT LẦN, tái dùng cho
// mọi seed, đóng ở teardown. Mở/đóng mỗi seed lại thành cold-boot mới, mất hết
// lợi ích.

import { getPlatformProxy } from 'wrangler'

// Kiểu tối thiểu của handle getPlatformProxy trả về — chỉ khai những gì dùng.
interface PlatformProxy {
  env: { DB: D1Database }
  dispose: () => Promise<void>
}

// Singleton handle. Mở lười ở lần seed đầu tiên, tái dùng cho tất cả.
let proxyPromise: Promise<PlatformProxy> | null = null

async function getProxy(): Promise<PlatformProxy> {
  if (proxyPromise === null) {
    proxyPromise = getPlatformProxy() as unknown as Promise<PlatformProxy>
    // Mỗi worker-process của Playwright import module này sẽ mở handle riêng
    // (một lần, tái dùng trong process đó). global-teardown chỉ chạy ở process
    // CHÍNH, nên đăng ký dispose khi process THOÁT để handle ở worker-process
    // cũng được đóng — nếu không, miniflare còn giữ tài nguyên khiến worker
    // treo lúc kết thúc. Idempotent với closeSeed().
    process.once('exit', () => {
      // 'exit' đồng bộ — không await được; dispose là best-effort để giải
      // phóng tài nguyên. Đường đóng tất định là closeSeed() ở teardown.
      void closeSeed()
    })
  }
  return proxyPromise
}

/** Lấy binding D1 in-process (mở handle nếu chưa mở). Dùng khi cần gọi trực
 * tiếp API D1 (vd seed() của src/worker/db/seed.ts nhận D1Database). */
export async function getSeedDb(): Promise<D1Database> {
  const proxy = await getProxy()
  return proxy.env.DB
}

/**
 * Tách một chuỗi nhiều câu SQL (ngăn bằng `;`) thành từng câu.
 *
 * Vì sao KHÔNG dùng `db.exec()`: `exec` của D1/miniflare tách câu theo XUỐNG
 * DÒNG, nên một câu `INSERT ... SELECT ...` trải nhiều dòng (kiểu seed hiện có
 * dùng khắp nơi) bị cắt giữa chừng → "incomplete input: SQLITE_ERROR". Vì vậy
 * ta tự tách theo `;` rồi chạy từng câu qua prepared statement trong một batch.
 *
 * Tách theo `;` an toàn ở đây vì mọi giá trị trong seed E2E là số / tên /
 * SĐT — KHÔNG chứa dấu `;` trong string literal (đã rà toàn bộ call-site).
 * Vẫn bỏ qua dòng comment `--` cho chắc.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    // Bỏ câu rỗng và câu chỉ-comment. Comment giữa câu hiếm trong seed E2E;
    // nếu có comment dòng lẫn SQL thì tách bỏ dòng `--` ở đầu mỗi câu.
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0)
}

// --- Xử lý va chạm SQLite giữa HAI instance miniflare (resource-layer) --------
//
// getPlatformProxy() mở MỘT instance miniflare riêng, KHÔNG phải instance của
// dev-server (vite @cloudflare/vite-plugin chạy miniflare của chính nó). Cả hai
// persist vào CÙNG file `.wrangler/state/v3/d1/.../*.sqlite`. Khi cả bộ E2E
// chạy, project `chromium` (~60 spec HTTP) dội tải lên miniflare-dev-server
// trong khi seed đọc/ghi qua miniflare-seed → hai connection SQLite (WAL) va
// nhau: `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` / "internal error" thoáng qua.
//
// SQLITE_BUSY THEO ĐỊNH NGHĨA là tín hiệu "hãy thử lại" — không phải flake logic.
// Đây là cách xử lý ĐÚNG TẦNG: chờ writer kia commit xong rồi thử lại, y hệt
// một `busy_timeout` của SQLite (miniflare không expose pragma này ra binding).
// Khác hoàn toàn với Playwright `retries` (giấu flake ở tầng assertion) — ở đây
// KHÔNG có assertion nào được nới; chỉ một thao tác DB gặp khoá tạm thời được
// chờ-rồi-lặp. Đồng thời SERIAL hoá mọi thao tác seed trong tiến trình này
// (chuỗi promise) để chúng không tự chồng nhau, thu hẹp cửa sổ va chạm.

let seedLock: Promise<unknown> = Promise.resolve()

/** Serial hoá: mỗi thao tác seed chờ thao tác trước xong mới chạy. */
function withSeedLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = seedLock.then(fn, fn)
  // Giữ chuỗi tiếp diễn kể cả khi fn ném (nuốt lỗi ở nhánh khoá, không ở kết quả).
  seedLock = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const BUSY_PATTERNS = ['SQLITE_BUSY', 'database is locked', 'internal error']

function isTransientLock(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err)
  return BUSY_PATTERNS.some((p) => msg.includes(p))
}

/** Chạy một thao tác D1, chờ-rồi-lặp khi gặp khoá tạm thời cross-instance. */
async function withBusyRetry<T>(op: () => Promise<T>): Promise<T> {
  const maxAttempts = 8
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op()
    } catch (err) {
      if (!isTransientLock(err) || attempt === maxAttempts) throw err
      // Backoff tuyến tính nhẹ (50ms, 100ms, …) — đủ để writer kia commit WAL.
      await new Promise((r) => setTimeout(r, 50 * attempt))
    }
  }
  // Không tới được (vòng lặp luôn return/throw), nhưng thoả kiểu trả về.
  throw new Error('withBusyRetry: unreachable')
}

/**
 * Chạy một chuỗi nhiều câu SQL vào D1 local qua binding in-process.
 *
 * Thay thế nguyên xi hàm `runSql(statements)` cũ (spawn `wrangler d1 execute
 * --file=`) ở các spec: cùng chữ ký, cùng ngữ nghĩa "chạy khối SQL này",
 * nhưng KHÔNG spawn subprocess. Serial + busy-retry ở tầng resource để chịu
 * được va chạm SQLite với miniflare-dev-server (xem ghi chú phía trên).
 */
export async function runSql(statements: string): Promise<void> {
  const stmts = splitStatements(statements)
  if (stmts.length === 0) return
  await withSeedLock(() =>
    withBusyRetry(async () => {
      const db = await getSeedDb()
      await db.batch(stmts.map((s) => db.prepare(s)))
    }),
  )
}

/**
 * Chạy một câu SELECT và trả về mảng hàng kết quả. Thay hàm `querySql<T>` /
 * các chỗ đọc `wrangler d1 execute --json` cũ.
 */
export async function querySql<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return withSeedLock(() =>
    withBusyRetry(async () => {
      const db = await getSeedDb()
      const res = await db.prepare(sql).all<T>()
      return res.results ?? []
    }),
  )
}

/**
 * Wipe toàn bộ + seed lại dữ liệu chuẩn — dùng cho global-setup, thay cặp
 * `wrangler d1 execute --command <DELETE...>` + `npm run db:seed:local` cũ.
 *
 * Dùng THẲNG `seed(db)` từ src/worker/db/seed.ts (nguồn sự thật duy nhất của
 * dataset seed) — nó tự DELETE mọi bảng theo đúng thứ tự FK rồi INSERT lại,
 * và seed 3 user (owner/reception/ktv). Không lặp lại danh sách bảng ở đây.
 */
export async function wipeAndSeed(): Promise<void> {
  const { seed } = await import('../../src/worker/db/seed.ts')
  // Busy-retry để chịu va chạm nếu dev-server (webServer) đã khởi động và chạm
  // D1 song song. seed() idempotent (DELETE rồi INSERT) nên lặp lại an toàn.
  await withBusyRetry(async () => {
    const db = await getSeedDb()
    await seed(db)
  })
}

/**
 * Đóng handle getPlatformProxy. Gọi MỘT LẦN ở global-teardown — không gọi sau
 * mỗi seed (sẽ tái tạo cold-boot). An toàn khi chưa từng mở handle.
 */
export async function closeSeed(): Promise<void> {
  if (proxyPromise === null) return
  const proxy = await proxyPromise
  proxyPromise = null
  await proxy.dispose()
}
