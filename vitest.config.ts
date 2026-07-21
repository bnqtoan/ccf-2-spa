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
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
})
