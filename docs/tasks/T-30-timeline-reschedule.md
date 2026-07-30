---
id: T-30
title: Đổi giờ / đổi KTV cho lịch ngay trên timeline (kéo + nút trong sheet)
status: review
model: opus
effort: high
depends_on: ["T-22", "T-24"]
touches:
  - src/app/routes/admin/timeline/TimelinePage.tsx
  - src/app/routes/admin/timeline/timeline.css
  - src/app/routes/admin/timeline/api.ts
  - tests/e2e/admin-timeline.spec.ts
  - tests/api/admin-reschedule.test.ts
prd_refs: []
owner: null
started_at: 2026-07-30
finished_at: 2026-07-30
---

# T-30 · Đổi giờ / đổi KTV cho lịch ngay trên timeline (kéo + nút trong sheet)

## Mục tiêu
Lễ tân sửa được một lịch bình thường (dời giờ, đổi KTV) **ngay trên timeline** —
bằng cách kéo block, hoặc bằng nút "Đổi giờ / Đổi KTV" trong sheet chi tiết — thay vì
huỷ-rồi-tạo-lại (mất slot, có thể bị cướp).

## Ngữ cảnh cần biết
Audit code-blind kết luận **Revision gap P1** (G3): sheet chi tiết của một lịch bình
thường chỉ có nút đổi trạng thái + thêm dịch vụ — **không** có đổi giờ / đổi KTV /
huỷ. Kéo block thử nghiệm không làm gì (trang chỉ scroll). Reschedule nguyên tử
race-safe **đã tồn tại** nhưng chỉ được nối vào trang khách `/lookup`, chưa nối vào
admin timeline.

Contract calendar đòi: **kéo block để dời (giờ + KTV); (tuỳ chọn) kéo mép đổi độ dài.**

## Phạm vi
**Trong:**
- Kéo block sang cột KTV khác / dòng giờ khác → gọi reschedule nguyên tử đã có.
- Nút "Đổi giờ / Đổi KTV" trong sheet chi tiết lịch → mở lại grid/slot chọn giờ+KTV
  mới → xác nhận → reschedule nguyên tử.
- Giữ nguyên constraint skill/availability đã có ở luồng reassign (KTV không đủ skill
  bị chặn + nêu lý do thân thiện).
- Surface mã lỗi `SLOT_TAKEN` / `CANCEL_TOO_LATE` thành câu tiếng Việt.
- Sau khi đổi: block chuyển đúng vị trí mới ngay.

**Ngoài:**
- KHÔNG viết endpoint reschedule mới — dùng lại cái đã có (nối vào admin).
- KHÔNG làm kéo-mép-đổi-độ-dài nếu backend chưa hỗ trợ đổi duration; chỉ dời
  giờ/KTV. Ghi rõ nếu bỏ.
- KHÔNG đụng luồng reschedule của khách ở `/lookup`.

## Đầu vào đã có
- Endpoint reschedule nguyên tử (race-safe) — hiện nối ở `src/app/routes/.../lookup`
  api client. Tìm và dùng lại (T-24).
- Luồng "Chuyển kỹ thuật viên" ở reassign đã có validate skill/availability — tham
  chiếu cách nó chặn KTV không đủ điều kiện.
- `TimelinePage.tsx` sheet chi tiết + grid.

## Việc phải làm
1. Nút "Đổi giờ / Đổi KTV" trong sheet → chọn slot mới → gọi reschedule.
2. Kéo block (drag) → thả vào cột/giờ mới → xác nhận nhẹ → reschedule.
3. Map lỗi server → câu tiếng Việt; slot vừa bị cướp → báo nhẹ, chọn lại.
4. Reload grid sau thành công.

## Quy ước bắt buộc
Copy mục liên quan từ `docs/tasks/CONVENTIONS.md`. Không thêm route mới nếu endpoint
đã có; nếu buộc phải, chỉ thêm 1 dòng vào `registerRoutes()`.

## Checklist đầu ra
- [ ] Typecheck xanh
- [ ] Test API `npm test` xanh
- [ ] Test E2E `npm run e2e` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] `status: review` + `finished_at`
- [ ] "Đã làm gì"

## Test phải viết
- E2E: kéo block Lan@14:00 sang Mai@15:00 → block chuyển đúng, DB đổi staff+giờ.
- E2E: nút "Đổi giờ" trong sheet → chọn giờ mới → xác nhận → block dời.
- API: reschedule vào slot đã bận → SLOT_TAKEN, không đổi, báo tiếng Việt.
- E2E: kéo sang KTV không đủ skill → bị chặn + lý do.

## Định nghĩa "xong"
Một lịch bình thường đổi được giờ HOẶC KTV từ timeline (kéo hoặc nút), nguyên tử,
không qua huỷ-tạo-lại, giữ đúng constraint skill/slot.

## Cạm bẫy đã biết
- Reschedule = huỷ+đặt phải **nguyên tử** — đừng ghép cancel+book ở client (race).
  Dùng đúng endpoint nguyên tử đã có.
- Drag trên grid dễ nhầm toạ độ→giờ; kiểm buffer/block_end như T-29.
- Giữ cutoff/luật đã có; đừng nới để "cho dễ".

## Đã làm gì
- Nối reschedule NGUYÊN TỬ đã có (`POST /api/bookings/:id/reschedule`, T-24) vào admin
  timeline — KHÔNG viết endpoint mới, KHÔNG cancel+book ở client. Thêm
  `rescheduleBooking()` vào `timeline/api.ts` (body `{ start_at, staff_id? }`;
  server tự nạp variant nên client không cần variant_id).
- Hai lối vào cùng một endpoint: (a) nút "Đổi giờ / Đổi KTV" trong sheet chi tiết
  (chỉ lịch `booked`) → sheet chọn giờ + KTV mới; (b) KÉO block sang cột KTV/dòng
  giờ khác → hộp xác nhận nhẹ → reschedule. Cả hai gate `canAddService`
  (owner/lễ tân), technician không thấy/không kéo được.
- Map mã lỗi server → câu tiếng Việt thân thiện (`rescheduleErrorMessage`):
  SLOT_TAKEN / CANCEL_TOO_LATE / STAFF_LACKS_SKILL / OUTSIDE_SHIFT /
  INVALID_TRANSITION — không lộ mã thô. Giữ nguyên cutoff 2h + skill/shift/slot
  của endpoint (không nới). Sau thành công reload grid → block dời đúng chỗ ngay.
- Test: `tests/api/admin-reschedule.test.ts` (4 case: đổi staff+giờ đủ skill;
  SLOT_TAKEN không đổi; STAFF_LACKS_SKILL không đổi; chỉ đổi giờ giữ KTV) + 4 E2E
  trong `admin-timeline.spec.ts` (kéo→DB đổi; nút Đổi giờ→dời; đổi vào slot bận→
  SLOT_TAKEN không đổi; kéo sang KTV thiếu skill→chặn).
- Bỏ kéo-mép-đổi-độ-dài (card cho phép bỏ): backend reschedule giữ nguyên variant
  → không đổi duration; chỉ dời giờ/KTV. Không thêm route mới, không đụng luồng
  khách /lookup, không sửa `admin-schedule.ts` (ngoài touches).
- Verify: typecheck xanh; `npm test` 431/431 xanh; E2E project chromium-shared-queue
  (chứa admin-timeline) 19/19 xanh. Chạy full-parallel có vài spec ngoài card đỏ do
  tranh chấp D1 local (nhiều `wrangler d1 execute` đồng thời → SQLITE_BUSY/FK, dev
  server bị OOM-kill) — chạy tuần tự từng project thì chỉ còn đúng 1 lỗi
  pre-existing đã biết: `customer-reschedule.spec.ts:70` (locator `rs-slot-`),
  không liên quan card này.
