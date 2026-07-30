---
id: T-41
title: /api/version = commit SHA thật (nhúng lúc build, bundler-agnostic)
status: review
model: sonnet
effort: low
depends_on: []
touches:
  - scripts/gen-build-tag.mjs
  - src/worker/build-tag.ts
  - src/worker/routes/index.ts
  - wrangler.jsonc
  - package.json
  - vite.config.ts
prd_refs: []
owner: null
started_at: 2026-07-30 17:26
finished_at: 2026-07-30 17:45
---

# T-41 · Build tag = SHA thật

## Mục tiêu
`/api/version` từng trả chuỗi hardcode nobody cập nhật → không phản ánh bản đang chạy.
Cho nó trả `YYYY-MM-DD-<sha7>` thật để xác nhận auto-deploy Workers Builds đã chạy.

## Ngữ cảnh — vì sao codegen chứ không Vite `define`
Thử `define` `__BUILD_TAG__` trong Vite trước → bản deploy vẫn ra 'dev' vì bundler
đường deploy (Workers Builds / wrangler) KHÔNG chắc honor Vite define cho worker.
Đã phát hiện bằng cách verify LIVE (thấy 'dev'), không assert.

## Đã làm gì
- `scripts/gen-build-tag.mjs` GHI `YYYY-MM-DD-<sha7>` vào `src/worker/build-tag.ts`
  (import như mã nguồn thường → bundler nào cũng gộp). SHA: `WORKERS_CI_COMMIT_SHA` /
  `CF_PAGES_COMMIT_SHA` → `git rev-parse` → 'unknown'.
- Chạy ở CẢ hai đường deploy: `wrangler.jsonc` `build.command` (wrangler deploy) +
  npm `prebuild` (vite build). Giá trị commit sẵn là 'dev' cho dev/vitest; generator
  ghi đè lúc build.
- Verify LIVE: `/api/version` = `2026-07-30-9b541eb` khớp commit đang chạy; 453/453 vitest.
