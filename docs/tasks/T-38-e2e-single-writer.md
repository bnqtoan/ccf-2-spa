---
id: T-38
title: Xoá GỐC flake E2E — một writer D1 duy nhất (bỏ miniflare thứ 2), gỡ busy-retry
status: todo
model: opus
effort: high
depends_on: ["T-37"]
touches:
  - tests/e2e/_seed.ts
  - tests/e2e/global-setup.ts
  - playwright.config.ts
  - src/worker/db/d1.ts
  - src/worker/db/bookings.ts
prd_refs: []
owner: null
started_at: null
finished_at: null
---

# T-38 · Xoá GỐC flake E2E — một writer D1 duy nhất

## Mục tiêu
Đây là app ĐƠN GIẢN — nhưng E2E vật lộn vì test infra tự đánh nhau. Xoá GỐC:
loại nguyên nhân SQLITE_BUSY thay vì tiếp tục dán busy-retry (T-34 seed-side,
T-37 app-side đều là VÁ). Sau card này: một-writer-duy-nhất, không cần busy-retry
ở đâu cả, CI E2E xanh nhanh + tất định. T-37 là STOPGAP để CI xanh ngay; T-38 làm
nó không bao giờ tái phát rồi GỠ busy-retry.

## Ngữ cảnh — root cause KIẾN TRÚC (đã đọc source)
- Dev-server (vite plugin) persist D1 vào `../../.wrangler/state` (vite.config.ts:25).
- Seed (`getPlatformProxy()` trong `_seed.ts`) mở MỘT miniflare THỨ HAI trỏ vào
  CÙNG file `.wrangler/state/.../*.sqlite`.
- HAI miniflare, MỘT file SQLite → hai connection WAL va nhau → SQLITE_BUSY. Đây
  là toàn bộ căn bệnh. Busy-retry (T-34/T-37) chỉ giảm triệu chứng.

## Hướng fix (chọn một, nêu lý do — ưu tiên đơn giản nhất chạy được)
**A. Seed qua CHÍNH dev-server, không mở miniflare thứ 2 (ưu tiên).**
Thay `getPlatformProxy()` bằng seed qua một đường của dev-server đang chạy: hoặc
(a1) một route test-only `POST /api/__test__/seed` CHỈ bật khi `TEST_CLOCK==='1'`/
env test (đã có tiền lệ X-Test-Now gating), nhận SQL/fixture và chạy qua `c.env.DB`
của chính dev-server → MỘT writer duy nhất; hoặc (a2) seed qua các API admin thật
đã có. → Không còn miniflare thứ 2 → không còn contention → GỠ được busy-retry.

**B. DB cô lập cho E2E.** Cho dev-server + seed dùng một `--persist-to` THƯ MỤC
TẠM riêng cho mỗi lần chạy E2E (không đụng .wrangler/state chính). Vẫn hai
miniflare nhưng... vẫn cùng file → KHÔNG giải quyết contention. ⇒ B một mình KHÔNG
đủ; chỉ hữu ích kèm A. Ghi ra để loại.

⇒ Thực chất phải là A: bỏ writer thứ hai. B (temp dir) là phụ để test không bẩn
state dev.

## Phạm vi
**Trong:**
- Chuyển seed sang một-writer (hướng A). Nếu a1 (route test-only): route PHẢI
  gate chặt (chỉ env test, không bao giờ live) — không thành lỗ hổng production.
- Sau khi hết contention: GỠ busy-retry ở app write path (T-37) và ở `_seed.ts`
  (T-34) — hoặc giữ lại như phòng-thủ-sâu NHƯNG chứng minh E2E xanh KHÔNG cần nó
  (chạy 3× với retry disabled để chứng minh gốc đã sạch). Nêu rõ quyết định.
- Cân nhắc gỡ luôn sự phức tạp project `chromium-shared-queue` vs `chromium-d1-seed`
  nếu một-writer làm chúng thừa — đơn giản hoá playwright.config. CHỈ gỡ cái nào
  chứng minh được không còn cần (chạy xanh không có nó).

**Ngoài:**
- KHÔNG đổi schema/engine/business logic.
- KHÔNG thêm route seed vào production build không-gate (bảo mật).
- KHÔNG dùng Playwright retries.

## Định nghĩa "xong"
`CI=true npm run e2e` full xanh **3× tất định**, KHÔNG busy-retry ở đường ghi
(chứng minh gốc sạch), KHÔNG Playwright-retries, config E2E đơn giản hơn trước
(ít project/less-magic nếu gỡ được). Ghi số thời gian trước/sau.

## Cạm bẫy
- Route seed test-only là bề mặt tấn công nếu lọt production — gate bằng env test,
  KHÔNG bằng chuỗi đoán được; xác nhận nó 404/403 trên build production.
- Đừng gỡ busy-retry TRƯỚC khi chứng minh một-writer đã sạch — gỡ rồi mới chạy 3×
  để chứng minh, không phải ngược lại.
- Nếu hướng A hoá ra vướng (dev-server không cho seed qua binding sạch), STOP +
  báo, đừng quay lại mở miniflare thứ 2.

## Đã làm gì
(agent điền)
