---
id: T-37
title: Khử SQLITE_BUSY còn sót — app write path chưa có busy-retry (CI đỏ thật)
status: todo
model: opus
effort: medium
depends_on: []
touches:
  - src/worker/db/bookings.ts
  - src/worker/db/d1.ts
  - tests/e2e/admin-timeline.spec.ts
prd_refs: []
owner: null
started_at: null
finished_at: null
---

# T-37 · Khử SQLITE_BUSY còn sót trong đường GHI của app

## Mục tiêu
Làm CI E2E xanh TẤT ĐỊNH bằng cách bịt nốt nửa contention T-34/T-35 CHƯA đóng.
CI đang ĐỎ THẬT (không phải flake mơ hồ): test `admin-timeline.spec.ts:576`
("tạo lịch trùng slot → SLOT_TAKEN") chết vì `SQLITE_BUSY: database is locked`
→ `selectOption` timeout 30s.

## Ngữ cảnh — root cause CHÍNH XÁC (đã đọc source, không đoán)
Cùng file local `.wrangler/state/v3/d1/*.sqlite` bị HAI miniflare mở song song:
(1) dev-server (vite plugin) phục vụ request của app, (2) `getPlatformProxy()` mà
`_seed.ts` dùng để seed. Hai connection WAL va nhau → SQLITE_BUSY thoáng qua.

T-34 CHỈ vá MỘT nửa: `_seed.ts` có busy-retry (BUSY_PATTERNS + backoff, xem
`tests/e2e/_seed.ts:114-129`). Nhưng đường GHI của APP (POST /api/admin/bookings →
`insertBookingAtomically` trong `src/worker/db/bookings.ts`) **KHÔNG có retry** —
khi seed đang ghi mà app cũng ghi (đúng kịch bản `:576`: seed một booking rồi tạo
booking trùng qua UI), app-write ăn SQLITE_BUSY và KHÔNG thử lại → 500/timeout.
Comment trong _seed.ts tự nhận miniflare không expose `busy_timeout` pragma ra
binding — nên phải retry ở tầng ứng dụng.

Đây KHÔNG phải "làm test xanh cho xong": app-write ăn SQLITE_BUSY không retry là
một điểm yếu THẬT (D1 dưới tải đồng thời cũng trả BUSY) — vá đúng chỗ này làm cứng
cả production lẫn test.

## Phạm vi
**Trong:**
- Thêm helper retry-on-BUSY DÙNG CHUNG cho D1 writes (vd `src/worker/db/d1.ts`):
  bọc một thao tác D1 (`.run()`/`.batch()`), bắt lỗi khớp BUSY_PATTERNS
  ('SQLITE_BUSY', 'database is locked', 'internal error'), retry với backoff nhẹ
  (vd 3-5 lần, 25/50/100ms), ném lại lỗi KHÁC ngay. Dùng chung một danh sách
  pattern với `_seed.ts` (đừng copy lệch).
- Áp vào đường GHI chính có thể va: `insertBookingAtomically` (create + reschedule)
  trong `bookings.ts`. Chỉ bọc GHI, KHÔNG bọc mọi read (read BUSY hiếm và retry
  read có thể che lỗi logic).
- Giữ nguyên `SLOT_TAKEN`/`CANCEL_TOO_LATE`/logic nghiệp vụ — retry CHỈ cho lỗi
  BUSY hạ tầng, KHÔNG nuốt lỗi nghiệp vụ (SLOT_TAKEN vẫn phải ném ra ngay, không
  retry, không đổi thông điệp).

**Ngoài:**
- KHÔNG dùng Playwright `retries` (vá triệu chứng — đã cấm trong .claude/rules).
- KHÔNG serialize toàn bộ E2E (giữ pha `chromium` fullyParallel cho tốc độ).
- KHÔNG đổi schema. KHÔNG đổi ngữ nghĩa cutoff/slot/skill.
- KHÔNG bọc read path bừa.

## Đầu vào đã có
- `tests/e2e/_seed.ts:114-129` — mẫu busy-retry + BUSY_PATTERNS đã có (tái dùng/
  chia sẻ pattern).
- `src/worker/db/bookings.ts` — `insertBookingAtomically` (đường ghi va chạm).
- `playwright.config.ts` — pha shared-queue (workers:1) chứa admin-timeline; app
  vẫn ghi qua dev-server nên retry ở app cần thiết dù seed đã workers:1.

## Việc phải làm
1. Helper `withBusyRetry(fn)` (hoặc tên phù hợp) ở tầng db, chia sẻ BUSY_PATTERNS.
2. Bọc GHI trong `insertBookingAtomically` (create + reschedule path).
3. Chạy E2E full 3× → `:576` và cả bộ xanh tất định, KHÔNG retries/serialize-toàn-cục.
4. Xác nhận lỗi nghiệp vụ (SLOT_TAKEN) KHÔNG bị retry/đổi.

## Checklist đầu ra
- [ ] Typecheck xanh
- [ ] `npm test` (unit/API) xanh ≥ hiện tại; thêm 1 unit test cho withBusyRetry
      (retry đúng lỗi BUSY, ném ngay lỗi khác, KHÔNG retry SLOT_TAKEN)
- [ ] `CI=true npm run e2e` full suite xanh **3× liên tiếp**, KHÔNG Playwright
      retries, KHÔNG workers:1 toàn cục (dán output cả 3)
- [ ] `:576` (SLOT_TAKEN dup) xanh cả 3 lần
- [ ] Không đụng file ngoài touches
- [ ] `status: review` + `finished_at` + "Đã làm gì" (root cause + chỗ bọc + số 3×)

## Test phải viết
- Unit: `withBusyRetry` — (a) thành công sau 1-2 lần BUSY; (b) ném NGAY lỗi
  không-BUSY (vd SLOT_TAKEN); (c) hết retry vẫn BUSY → ném.
- E2E: `:576` xanh 3× (bằng chứng contention đã hết ở app-write).

## Định nghĩa "xong"
CI E2E xanh tất định (3/3) mà không cần Playwright-retry / serialize-toàn-cục; app
write path sống sót SQLITE_BUSY như seed path đã làm; lỗi nghiệp vụ không bị nuốt.

## Cạm bẫy đã biết
- **Chỉ retry lỗi BUSY hạ tầng** — nếu retry cả SLOT_TAKEN/CANCEL_TOO_LATE là SAI
  (che lỗi nghiệp vụ, đặt trùng thật). Phân biệt bằng error code, không bằng chuỗi
  chung chung.
- Backoff phải ngắn (ms) — đừng làm request người dùng chậm rõ.
- Chia sẻ BUSY_PATTERNS với `_seed.ts`, đừng để hai bản lệch nhau.
- T-34 vá seed-side; card này vá app-side. Đừng đụng lại seed-side đã đúng.

## Đã làm gì
(agent điền khi xong)
