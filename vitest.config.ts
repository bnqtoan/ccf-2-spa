import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// @cloudflare/vitest-pool-workers >= 0.13 (paired with Vitest 4) replaced
// defineWorkersConfig/defineWorkersProject with the cloudflareTest() Vite
// plugin below. Same guarantee as the card requires: tests run for real in
// workerd against the D1 binding declared in wrangler.jsonc — no mocking.
export default defineConfig({
  test: {
    // T-03: tests/unit/ added so the pure-logic suites the cards require
    // (e.g. tests/unit/intervals.test.ts) are actually collected. They run in
    // the same workerd pool — they have no DB dependency, so the pool is
    // simply irrelevant to them rather than wrong.
    include: ['tests/api/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    // Chạy TUẦN TỰ (một file một lúc). Các test API dùng CHUNG một D1 local và
    // mỗi file `beforeEach` wipe sạch bảng; chạy song song thì file này wipe
    // giữa lúc file kia đang assert → đỏ ngẫu nhiên dưới tải (12–32 fail khi máy
    // bận, 0 khi rảnh; tuần tự luôn 361/361). Cùng lý do e2e chạy `--workers=1`.
    fileParallelism: false,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // PAYMENT track: inject test-only payment secrets so the webhook auth /
      // adapters have values under test. These are NOT real secrets — the real
      // ones are set in prod via `wrangler secret put` and never committed.
      miniflare: {
        bindings: {
          SEPAY_API_KEY: 'test-sepay-key',
          SEPAY_ACCOUNT_NUMBER: '0123456789',
          PAYPAL_VND_PER_USD: '25000',
          PAYPAL_WEBHOOK_ID: 'test-webhook-id',
          // T-19 auth: test-only signing key for the admin guard / login route
          // (same pattern as the payment secrets above). NOT a real secret —
          // prod sets it via secret put. T-23: ADMIN_PASSWORD removed — login
          // only ever checks the `users` table hash, no env password needed.
          SESSION_SECRET: 'test-session-secret',
          // Cho phép cố định "now" per-request qua header X-Test-Now (chỉ khi cờ
          // này = '1'). Dùng để test nhánh day_over của /api/availability. An
          // toàn: prod KHÔNG set cờ nên header luôn bị bỏ qua (xem lib/clock.ts).
          TEST_CLOCK: '1',
        },
      },
    }),
  ],
})
