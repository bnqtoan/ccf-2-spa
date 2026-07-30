---
id: T-39
title: E2E xanh tất định — chạy serial + busy-retry D1 ở tầng worker (khử SQLITE_BUSY tận gốc)
status: review
model: opus
effort: high
depends_on: ["T-34"]
touches:
  - playwright.config.ts
  - src/worker/index.ts
  - src/worker/lib/d1-retry.ts
  - tests/unit/d1-retry.test.ts
prd_refs: []
owner: null
started_at: 2026-07-30 15:23
finished_at: 2026-07-30 16:43
---

# T-39 · E2E tất định + busy-retry D1

## Mục tiêu
CI E2E đỏ ngẫu nhiên do `SQLITE_BUSY` / "internal error" khi hai instance miniflare
(dev-server + seed helper) chia sẻ cùng file `.wrangler/state`. Khử tận gốc, KHÔNG
papering-over (không Playwright `retries`, không tắt gate).

## Ngữ cảnh — root cause (đã đọc log CI thật, không đoán)
- Test đỏ thật là `customer-reschedule.spec.ts:43` (timeout click), KHÔNG phải các
  test timeline như tưởng. Các dòng `internal error`/`D1_ERROR` trong log là
  `[WebServer]` stderr, không phải test-fail.
- Gốc: seed-miniflare GHI va dev-server-miniflare ĐỌC cùng file SQLite → busy tạm
  thời surface thành 500 ở đường ĐỌC (availability), grid rỗng giữa lúc click. Phía
  seed đã có busy-retry (T-34) nhưng đường phục vụ HTTP của app thì KHÔNG có móc, và
  D1 CẤM `PRAGMA busy_timeout`.

## Đã làm gì
- **Serial hoá E2E** (`workers:1`, `fullyParallel:false`) + cấu trúc 5 project (auth-
  setup → guard/shared-queue/d1-seed → chromium) để cô lập global reassign-queue state.
- **busy-retry ở tầng worker** (`lib/d1-retry.ts` + middleware trong `index.ts`): bọc
  `env.DB` bằng Proxy, retry CHỈ lỗi hạ tầng thoáng qua (SQLITE_BUSY / database is
  locked / internal error) trên các call terminal — chính là `busy_timeout` mà D1 cấm
  đặt. 4 lần thử, backoff 25/50/100ms. KHÔNG bao giờ retry lỗi nghiệp vụ (SLOT_TAKEN…
  là giá trị trả về `meta.changes===0`, không throw → không chạm nhánh retry). Cũng
  hardening cho prod trước internal-error thoáng qua thật của D1.
- Unit test `d1-retry.test.ts`: retry BUSY, NÉM NGAY SLOT_TAKEN (chống double-book), cạn thì ném.
- Verify: 453/453 vitest; E2E CI-style 3× liên tiếp xanh (102/1-skip); **CI conclusion
  = success** (đọc field conclusion, không tin `gh run watch --exit-status`).
