---
paths:
  - "tests/e2e/**"
  - "playwright.config.ts"
---

# E2E testing rules

- **Seed via the in-process binding**, not by spawning `wrangler`. Use the shared
  helper `tests/e2e/_seed.ts` (one `getPlatformProxy()` handle, opened once, closed
  at teardown). Never add `execFileSync('wrangler d1 execute ...')` to a spec — the
  cold-boot-per-seed (~1.2s) is slow and causes SQLITE_BUSY under parallel workers.
- **Two miniflare instances share `.wrangler/state`** (the dev server's + the test
  binding's). Seed-writes vs dev-server-reads can still collide; seed-heavy specs run
  serially (`chromium-d1-seed`, `workers:1`), pure-HTTP specs stay parallel. Keep that
  split — don't globally serialize and don't add Playwright `retries` to hide flakes.
- **`chromium-shared-queue` stays serial** for a *different* reason: the reassign
  queue is global (derived from time_off × booking_items across the whole DB), a LOGIC
  race distinct from the D1 resource race. Don't merge or remove these projects.
- `global-setup` wipes + reseeds clean before every run — specs seed their own fixtures
  and don't clean up (intentional; global wipe handles accumulation). Keep it.
- Prove determinism by running the full suite green **3× consecutively**
  (`CI=true npm run e2e`), not once. Paste real output.
