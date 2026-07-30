import { defineConfig, devices } from '@playwright/test'

// E2E ĐƠN GIẢN, TUẦN TỰ. App nhỏ chạy solo → không cần tối ưu song song.
// Chạy serial (workers:1) khử tận gốc mọi race D1 (hai miniflare / một file
// .wrangler/state) — không cần busy-retry, không cần phân-pha nhiều project.
// Chỉ còn 3 project vì lý do PHIÊN ĐĂNG NHẬP, không phải vì contention:
//   - auth-setup: đăng nhập một lần → storageState cho các test admin.
//   - chromium-auth-guard: test hành vi CHƯA đăng nhập (KHÔNG storageState).
//   - chromium: mọi test còn lại, dùng storageState. Chạy SAU auth-setup.
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'auth-setup',
      testMatch: ['**/auth.setup.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Test hành vi CHƯA đăng nhập + rbac tự-đăng-nhập-per-role → KHÔNG
      // storageState. depends auth-setup chỉ để chạy SAU (tránh race đổi mật
      // khẩu owner dùng chung — race LOGIC, không phải tài nguyên).
      name: 'chromium-auth-guard',
      testMatch: ['**/admin-auth.spec.ts', '**/rbac.spec.ts'],
      dependencies: ['auth-setup'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: ['**/admin-auth.spec.ts', '**/rbac.spec.ts', '**/auth.setup.ts'],
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
