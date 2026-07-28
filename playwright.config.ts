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
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Ba spec dưới đây đều thao tác HÀNG CHỜ REASSIGN, vốn là tài nguyên
      // TOÀN CỤC: `GET /api/admin/reassign-queue` suy ra từ giao của time_off
      // và booking_items trên toàn DB, không lọc theo ngày hay theo fixture.
      // Chạy song song thì file này dọn hàng chờ xong, file kia lập tức tạo
      // orphan mới, và khẳng định "hàng chờ rỗng" không bao giờ đúng — đỏ khi
      // chạy cả bộ, xanh khi chạy từng file. Gom vào một project chạy tuần tự.
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
      name: 'chromium',
      testIgnore: [
        '**/admin-timeline.spec.ts',
        '**/admin-walkin-reassign.spec.ts',
        '**/flows/timeoff-reassign-block.spec.ts',
        '**/flows/timeoff-ui.spec.ts',
        // T-19 — guard spec chạy KHÔNG phiên ở project riêng; auth.setup là
        // project setup, không phải test thường.
        '**/admin-auth.spec.ts',
        '**/auth.setup.ts',
        // T-22 — rbac.spec tự đăng nhập per-role, chạy ở chromium-auth-guard.
        '**/rbac.spec.ts',
      ],
      // T-19 — nhiều spec ở đây (admin-setup, flows/*) cũng mở /admin/* → cần
      // phiên. Cấp storageState cho cả project.
      dependencies: ['auth-setup'],
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
