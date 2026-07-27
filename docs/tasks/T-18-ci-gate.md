---
id: T-18
title: CI gate chặn merge nếu typecheck/test đỏ
status: review
model: sonnet           # sonnet | opus | codex
effort: medium          # low | medium | high
depends_on: []          # độc lập — chỉ thêm CI, không đụng code app
touches:
  - .github/workflows/
  - playwright.config.ts
  - package.json
prd_refs: []            # hạ tầng, không phải feature nghiệp vụ
owner: null
started_at: null
finished_at: null
---

# T-18 · CI gate chặn merge nếu typecheck/test đỏ

## Mục tiêu
Không cho code đỏ lên `main`. Hiện deploy tự động khi push `main` (Cloudflare
Workers Builds) nhưng **test không chạy trong pipeline** — giờ đã có tiền chạy
qua hệ thống (payment), một lần merge đỏ có thể đẩy thẳng lỗi lên production.
Task này thêm một CI gate chạy typecheck + test + e2e trên mỗi PR và mỗi push.

## Ngữ cảnh cần biết
- Deploy hiện KHÔNG qua GitHub Actions — Cloudflare Workers Builds tự `npm run
  build` + `wrangler deploy` khi push `main` (xem `docs/DEPLOY.md`). Task này
  KHÔNG thay cơ chế deploy đó; nó thêm một tầng kiểm tra CHẶN TRƯỚC.
- Repo đã có sẵn 2 workflow do phiên khác thêm (`Claude Code Review`,
  `Claude PR Assistant` — merge vào qua PR #1). Kiểm `.github/workflows/` trước;
  KHÔNG ghi đè chúng, thêm workflow test riêng.
- **E2E flaky dưới parallel** là vấn đề đã biết: 2 spec race nhau do dùng chung
  D1 local + một `waitForTimeout(10_000)`. Trên CI phải chạy **tuần tự** để
  deterministic — đã xác minh `--workers=1` cho 76/76 xanh. (Một session riêng
  đang fix flaky tận gốc; nếu lúc làm task này flaky đã fix thì bỏ ràng buộc
  `--workers=1`, còn chưa thì GIỮ nó cho CI xanh ổn định.)

## Phạm vi
**Trong:**
- Một GitHub Actions workflow chạy trên `pull_request` → `main` và `push` → `main`:
  cài deps, `npm run typecheck`, `npm test`, `npm run e2e` (browser cài qua
  `playwright install --with-deps chromium`).
- Migrate + seed D1 local trong Cg trước khi chạy test (test cần D1 thật trong workerd).
- Đặt job làm **required check** (ghi hướng dẫn bật branch protection ở mục "Đã
  làm gì" — bật protection cần quyền repo admin của người dùng, agent không tự bật).

**Ngoài:**
- KHÔNG đụng logic app, route, migration.
- KHÔNG thay cơ chế Cloudflare Workers Builds deploy.
- KHÔNG sửa/nới assertion test cho CI xanh. Test đỏ thật thì để đỏ, báo.
- KHÔNG tự bật branch protection (cần quyền admin) — chỉ ghi hướng dẫn.

## Đầu vào đã có
- `package.json` scripts: `typecheck` (`tsc --noEmit`), `test` (`vitest run`),
  `e2e` (`playwright test`), `db:migrate:local`, `db:seed:local`.
- `playwright.config.ts`: `webServer.command = 'npm run dev'`, project
  `chromium-shared-queue` (serial) cho spec coupled toàn cục.
- `.github/workflows/` đã có workflow của Claude (không đụng).

## Việc phải làm
1. Thêm `.github/workflows/ci.yml` (hoặc tên tương tự, không trùng workflow sẵn có).
2. Trigger: `pull_request` nhắm `main`, `push` nhắm `main`.
3. Các bước: checkout → setup Node (khớp bản dev đang dùng) → `npm ci` →
   `npm run typecheck` → migrate+seed D1 local → `npm test` →
   `playwright install --with-deps chromium` → `npm run e2e -- --workers=1`.
4. Cache node_modules / Playwright browsers nếu hợp lý để CI nhanh.
5. Ghi vào `docs/DEPLOY.md` (hoặc card này) cách bật required status check trên
   branch `main` để CI thật sự CHẶN merge.

## Quy ước bắt buộc
Từ `CONVENTIONS.md`:
- **§8 Test:** test API chạy trong workerd + D1 thật (`tests/api/`), E2E Playwright
  (`tests/e2e/`). CI phải migrate+seed D1 local trước khi chạy — test cần DB thật.
- **§9 Quy tắc agent:** không xoá test, không nới assertion cho xanh; đỏ không sửa
  được thì `blocked` + ghi lý do.
- **BOARD.md:** agent không tự đặt `done`, cao nhất `review`.

## Checklist đầu ra
- [ ] Workflow chạy được trên PR thử (typecheck + test + e2e đều thực thi)
- [ ] E2E chạy `--workers=1` (hoặc bỏ nếu flaky đã fix) → xanh ổn định
- [ ] Không đụng file ngoài `touches`
- [ ] Không ghi đè workflow Claude sẵn có
- [ ] Hướng dẫn bật required check đã ghi lại
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết
Task hạ tầng — không thêm unit/e2e test app. "Test" ở đây là **chạy thử workflow
trên một PR nháp** và xác nhận: typecheck chạy, `npm test` chạy đủ ~304 case,
`npm run e2e` chạy đủ 76 spec, và một PR cố tình làm đỏ (vd sửa 1 assertion) bị
workflow báo fail.

## Định nghĩa "xong"
Một PR có test đỏ KHÔNG merge được vào `main` vì CI check fail; một PR xanh thì pass.

## Cạm bẫy đã biết
- **E2E flaky dưới parallel**: nếu chạy `npm run e2e` mặc định (nhiều worker) trên
  CI, 2 spec (`admin-setup:60`, `cancel-too-late-hotline`) sẽ fail giả do shared
  D1 + `waitForTimeout`. Dùng `--workers=1` cho tới khi flaky được fix tận gốc.
- **Flaky cũng ở tầng vitest**: `tests/api/cancel-status.test.ts` xanh khi chạy cô
  lập (16/16) nhưng 1 fail khi chạy full `npm test` — cùng gốc shared-D1 state
  giữa test file. Đã giao task riêng fix cả 2 tầng (e2e + vitest). CHƯA bật
  required check cho tới khi task đó xong, nếu không CI đỏ giả ở `npm test`.
- **`vite dev` không rebuild worker khi sửa** trong môi trường này — nhưng CI
  cold-start server mỗi lần (Playwright `reuseExistingServer: !CI`) nên không
  dính; chỉ là lưu ý nếu chuyển sang chế độ reuse server.
- Quên `playwright install` → E2E fail vì thiếu browser.
- D1 local chưa migrate/seed → test API đỏ hàng loạt.

## Đã làm gì
- Thêm `.github/workflows/ci.yml` (KHÔNG đụng 2 workflow claude-*.yml sẵn có).
  Trigger: PR→main và push→main. Bước: `npm ci` → `typecheck` → migrate+seed D1
  local → `npm test` → cache+install Playwright chromium → `e2e --workers=1`.
- `concurrency` huỷ run cũ khi push mới; `CI=true` để Playwright cold-start server
  (không reuse) + global-setup seed sạch. Cache npm + Playwright browser theo version.
- Mô phỏng đúng chuỗi lệnh CI tại local (CI=true): typecheck xanh, migrate+seed OK,
  e2e --workers=1 xanh. `npm test` lộ 1 flaky vitest (cancel-status, shared-D1) —
  KHÔNG sửa test trong scope này (CONVENTIONS §9); đã giao task fix riêng.
- **CÒN LẠI (cần người dùng, quyền admin repo):** bật required status check "CI /
  verify" trên branch `main` (Settings → Branches → protection) để CI thật sự
  CHẶN merge. Chỉ bật SAU khi task fix flaky xong, nếu không PR nào cũng đỏ.
- status → review (chờ CI chạy thật trên 1 PR + đọc diff).
