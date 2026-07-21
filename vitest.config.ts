import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// @cloudflare/vitest-pool-workers >= 0.13 (paired with Vitest 4) replaced
// defineWorkersConfig/defineWorkersProject with the cloudflareTest() Vite
// plugin below. Same guarantee as the card requires: tests run for real in
// workerd against the D1 binding declared in wrangler.jsonc — no mocking.
export default defineConfig({
  test: {
    include: ['tests/api/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
})
