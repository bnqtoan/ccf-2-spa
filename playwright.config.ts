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
      ],
      fullyParallel: false,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: [
        '**/admin-timeline.spec.ts',
        '**/admin-walkin-reassign.spec.ts',
        '**/flows/timeoff-reassign-block.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
