---
id: T-30
title: Đổi giờ / đổi KTV cho lịch ngay trên timeline (kéo + nút trong sheet)
status: todo
model: opus
effort: high
depends_on: ["T-22", "T-24"]
touches:
  - src/app/routes/admin/TimelinePage.tsx
  - src/app/routes/admin/timeline.css
prd_refs: []
owner: null
started_at: null
finished_at: null
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
(agent điền khi xong)
