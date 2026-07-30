import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // Dọn D1 local về seed sạch trước mỗi lần chạy — xem tests/e2e/global-setup.ts
  // để biết vì sao (dữ liệu fixture tích luỹ làm hàng chờ reassign và timeline
  // vỡ theo cách chỉ lộ ra khi chạy cả bộ, không lộ khi chạy từng file).
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // T-19 — đăng nhập một lần, lưu storageState cho các project admin. Xem
      // tests/e2e/auth.setup.ts. Các project admin `dependencies: ['auth-setup']`.
      name: 'auth-setup',
      testMatch: ['**/auth.setup.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // T-19 — guard đăng nhập: các test này KIỂM hành vi CHƯA đăng nhập, nên
      // KHÔNG dùng storageState và KHÔNG phụ thuộc auth-setup. Tách riêng để
      // không bị hai project admin nuốt (chúng ignore file này).
      name: 'chromium-auth-guard',
      // T-22: rbac.spec cũng tự đăng nhập per-role (KHÔNG storageState owner) →
      // đặt cùng project guard. Mỗi test có context riêng nên cookie không đụng nhau.
      testMatch: ['**/admin-auth.spec.ts', '**/rbac.spec.ts'],
      // T-34 (mang từ T-33 — RACE LOGIC mật khẩu, KHÔNG dùng storageState):
      // owner là MỘT dòng duy nhất trong `users` với must_change_password=1.
      // Helper login-past-must-change (dùng chung với auth.setup.ts) KHÔNG
      // nguyên tử: "login → thấy must_change → POST change-password". Chạy SONG
      // SONG với auth-setup thì cả hai cùng thấy must_change=true rồi cùng đổi;
      // cái sau verify 'admin123' với hash ĐÃ bị cái trước đổi → 401 → auth-setup
      // đỏ, kéo theo mọi project phụ thuộc "did not run". `dependencies:
      // ['auth-setup']` xếp guard chạy SAU auth-setup: lúc đó must_change=0,
      // helper đi nhánh "retry bằng mật khẩu đã đổi", không đổi lần hai. Đây là
      // ordering thuần — guard vẫn KHÔNG dùng storageState (test hành vi CHƯA
      // đăng nhập). Đây là race LOGIC (một dòng owner dùng chung), không phải
      // race tài nguyên wrangler mà T-34 đã xoá.
      dependencies: ['auth-setup'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Các spec dưới đây thao tác HÀNG CHỜ REASSIGN, vốn là tài nguyên TOÀN
      // CỤC: `GET /api/admin/reassign-queue` suy ra từ giao của time_off và
      // booking_items trên toàn DB, không lọc theo ngày hay theo fixture. Chạy
      // song song thì file này dọn hàng chờ xong, file kia lập tức tạo orphan
      // mới, và khẳng định "hàng chờ rỗng" không bao giờ đúng — đỏ khi chạy cả
      // bộ, xanh khi chạy từng file. Gom vào một project chạy tuần tự.
      //
      // T-34 — GIỮ project này: đây là RACE LOGIC (global state của hàng chờ),
      // KHÁC hẳn race TÀI NGUYÊN (spawn wrangler tranh file SQLite) mà T-34 đã
      // xoá bằng cách seed qua binding in-process. T-34 chỉ bỏ serialize/retry
      // sinh ra vì race tài nguyên; serialize vì logic toàn-cục thì vẫn cần —
      // quyết theo bản chất, không gỡ nhầm.
      name: 'chromium-shared-queue',
      testMatch: [
        '**/admin-timeline.spec.ts',
        '**/admin-walkin-reassign.spec.ts',
        '**/flows/timeoff-reassign-block.spec.ts',
        '**/flows/timeoff-ui.spec.ts',
      ],
      fullyParallel: false,
      workers: 1,
      // T-19 — các spec admin cần phiên đăng nhập (guard bật). Dùng storageState
      // do auth-setup tạo.
      dependencies: ['auth-setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e/.auth/admin.json' },
    },
    {
      // T-34 — RACE TÀI NGUYÊN MỚI (khác race LOGIC của shared-queue ở trên, và
      // khác race wrangler-subprocess của T-33 đã bị xoá).
      //
      // getPlatformProxy() mở MỘT instance miniflare RIÊNG cho seed, KHÔNG dùng
      // chung instance miniflare của dev-server (vite @cloudflare/vite-plugin).
      // Cả hai persist vào CÙNG file `.wrangler/state/.../*.sqlite` (WAL). Ba
      // spec dưới đây SEED nhiều (customer-lookup/reschedule/cancel-too-late):
      // nếu chạy fullyParallel trong project `chromium` chung với ~55 spec HTTP,
      // ghi-của-seed-miniflare va đọc-của-devserver-miniflare → `SQLITE_BUSY_
      // SNAPSHOT`. Busy-retry trong _seed.ts che được PHÍA SEED, nhưng phía
      // dev-server (app phục vụ request thật) KHÔNG có móc retry và D1 CẤM
      // `PRAGMA busy_timeout` (SQLITE_AUTH) → không tối ưu được từ tầng test.
      //
      // Cách khử ĐÚNG BẢN CHẤT (không phải giấu flake): TÁCH PHA thời gian. Gom
      // ba spec seed-nhiều vào một project workers:1, và cho project `chromium`
      // (luồng HTTP flood) `dependencies` vào cả hai cụm seed-miniflare
      // (shared-queue + d1-seed) → khi flood chạy, KHÔNG còn seed-miniflare nào
      // ghi song song. Trong pha seed (workers:1) áp lực đồng thời thấp nên
      // busy-retry phía seed đủ hấp thụ. KHÔNG dùng workers:1 TOÀN CỤC:
      // ~55 spec HTTP ở `chromium` vẫn fullyParallel → giữ tốc độ. KHÔNG dùng
      // Playwright `retries`. Đây là hướng "giảm đồng thời ĐÚNG cụm tài nguyên
      // va nhau", quyết theo bản chất resource-vs-logic như card yêu cầu.
      name: 'chromium-d1-seed',
      testMatch: [
        '**/customer-lookup.spec.ts',
        '**/customer-reschedule.spec.ts',
        '**/flows/cancel-too-late-hotline.spec.ts',
      ],
      // workers:1 — trong pha này, mỗi test hoặc SEED (qua seed-miniflare) hoặc
      // LOAD trang (qua dev-server-miniflare). Nếu chạy song song, seed-của-test-A
      // ghi file trong khi dev-server phục vụ page-load-của-test-B đọc file → va
      // chạm hai-instance SQLITE_BUSY_SNAPSHOT ở PHÍA dev-server (không móc retry
      // được). Chỉ workers:1 mới khử triệt để: tại mọi thời điểm chỉ một test
      // chạm D1, seed-miniflare và dev-server-miniflare không bao giờ ghi/đọc
      // đồng thời. Đây là serialize ĐÚNG cụm tài nguyên va nhau (3 spec seed-
      // nhiều), KHÔNG phải workers:1 toàn cục — ~55 spec HTTP ở `chromium` vẫn
      // fullyParallel. Hai test chờ ~32s (đợi đồng hồ vượt cutoff) là chi phí cố
      // hữu của chính test đó, không phải do phasing.
      fullyParallel: false,
      workers: 1,
      dependencies: ['auth-setup', 'chromium-shared-queue'],
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e/.auth/admin.json' },
    },
    {
      name: 'chromium',
      testIgnore: [
        '**/admin-timeline.spec.ts',
        '**/admin-walkin-reassign.spec.ts',
        '**/flows/timeoff-reassign-block.spec.ts',
        '**/flows/timeoff-ui.spec.ts',
        // T-34 — ba spec seed-nhiều chạy ở pha riêng chromium-d1-seed (xem trên).
        '**/customer-lookup.spec.ts',
        '**/customer-reschedule.spec.ts',
        '**/flows/cancel-too-late-hotline.spec.ts',
        // T-19 — guard spec chạy KHÔNG phiên ở project riêng; auth.setup là
        // project setup, không phải test thường.
        '**/admin-auth.spec.ts',
        '**/auth.setup.ts',
        // T-22 — rbac.spec tự đăng nhập per-role, chạy ở chromium-auth-guard.
        '**/rbac.spec.ts',
      ],
      // T-19 — nhiều spec ở đây (admin-setup, flows/*) cũng mở /admin/* → cần
      // phiên. Cấp storageState cho cả project.
      // T-34 — CHẠY SAU hai cụm seed-miniflare (shared-queue → d1-seed): trong
      // pha này KHÔNG còn seed-miniflare ghi vào file, chỉ dev-server chạm D1 →
      // hết va chạm hai-instance. Bên trong pha, ~55 spec HTTP vẫn fullyParallel.
      dependencies: ['auth-setup', 'chromium-shared-queue', 'chromium-d1-seed'],
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e/.auth/admin.json' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
