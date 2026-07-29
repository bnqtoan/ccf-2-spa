---
id: T-29
title: Tạo lịch ngay trên timeline (click ô trống → đặt lịch prefill)
status: todo
model: sonnet
effort: high
depends_on: ["T-22"]
touches:
  - src/app/routes/admin/TimelinePage.tsx
  - src/app/routes/admin/timeline.css
  - src/worker/routes/index.ts
prd_refs: []
owner: null
started_at: null
finished_at: null
---

# T-29 · Tạo lịch ngay trên timeline (click ô trống → đặt lịch prefill)

## Mục tiêu
Lễ tân đặt được lịch cho khách (gọi điện / vãng lai) **ngay trên timeline** — nơi
họ đang nhìn thấy ai rảnh — thay vì phải rời sang trang khách `/` đóng vai khách,
hoặc dùng "+ Khách vãng lai" ở /reassign (chỉ tạo được "ngay bây giờ", không có
tên khách, không chọn giờ/KTV).

## Ngữ cảnh cần biết
Audit code-blind (con-mắt-không-biết-code, thao tác app thật) kết luận: timeline là
**Calendar/Timeline archetype nhưng vi phạm contract của chính nó** — click ô trống
không làm gì, không có nút tạo lịch nào trên trang. Đây là gap **P1 Archetype
mismatch** (G1 mặt "create" + G2). Người dùng trả tax mỗi lần dùng.

Contract calendar đòi: **click ô trống tại toạ độ → tạo object prefill (KTV cột đó +
giờ dòng đó).**

## Phạm vi
**Trong:**
- Click một ô trống (KTV × giờ) trên grid → mở sheet đặt lịch, **prefill sẵn** KTV
  của cột đó và giờ của dòng đó.
- Sheet nhập: tên khách, SĐT, dịch vụ (+ variant), giờ (prefill, sửa được), KTV
  (prefill, sửa được).
- Nút "+ Đặt lịch" hiện diện trên chính trang timeline (không chỉ dựa vào click ô).
- Ghi qua đúng write-path đã có (validate slot/skill/shift server-side), source =
  `admin` hoặc `walk_in` phù hợp.
- Sau khi tạo: block hiện ngay trên timeline (`loadAll()`).

**Ngoài:**
- KHÔNG làm combo nhiều dịch vụ ở đây (đã có card riêng T-25/T-26).
- KHÔNG đụng luồng đặt lịch của khách ở trang `/`.
- KHÔNG drag/reschedule — đó là T-30.

## Đầu vào đã có
- `TimelinePage.tsx` — grid KTV×giờ, sheet chi tiết block đã có.
- Walk-in API + write-path validate (slot/skill/shift) đã tồn tại — dùng lại, đừng
  viết validate mới. Kiểm tra endpoint hiện có trước khi thêm.
- RBAC: tạo lịch chỉ owner + receptionist (theo T-22/T-28 pattern) — technician KHÔNG
  được tạo. Gate ở route, không chỉ ẩn UI.

## Việc phải làm
1. Grid: ô trống nhận onClick → tính (staff_id, start_at) từ toạ độ ô.
2. Mở sheet đặt lịch prefill; cho sửa giờ/KTV.
3. Submit → gọi API tạo (dùng lại validate có sẵn); render lại grid.
4. Thêm nút "+ Đặt lịch" trên qbar của timeline (mở sheet, không prefill hoặc prefill
   giờ hiện tại + KTV đầu).
5. Gate RBAC ở route nếu route mới; nếu dùng route cũ đã gated thì xác nhận.

## Quy ước bắt buộc
Copy các mục liên quan từ `docs/tasks/CONVENTIONS.md` (đặc biệt: chỉ thêm 1 dòng vào
`registerRoutes()` nếu cần route mới; không tự sửa `src/worker/index.ts`).

## Checklist đầu ra
- [ ] Typecheck: `npm run typecheck` xanh
- [ ] Test API: `npm test` xanh
- [ ] Test E2E: `npm run e2e` xanh (task có UI)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết
- E2E: `reception` login → timeline → click ô trống Lan@10:00 → sheet mở prefill
  Lan + 10:00 → nhập khách + dịch vụ → tạo → block xuất hiện đúng cột/giờ.
- E2E: nút "+ Đặt lịch" mở được sheet.
- API/gate: technician gọi endpoint tạo → 403.
- API: tạo trùng slot đã có → báo lỗi thân thiện (SLOT_TAKEN), không tạo.

## Định nghĩa "xong"
Lễ tân tạo được một lịch tương lai cho khách có tên+SĐT, chọn giờ+KTV, hoàn toàn từ
timeline, và thấy nó xuất hiện ngay — không rời trang.

## Cạm bẫy đã biết
- Đừng viết lại validate slot/skill/shift — dùng lại write-path có sẵn, nếu không sẽ
  lệch luật một-chỗ.
- Toạ độ → giờ phải khớp cách grid render (buffer, block_end). Kiểm bằng mắt.
- Nhớ gate RBAC ở **route**; ẩn nút UI không đủ (bài học T-28).

## Đã làm gì
(agent điền khi xong)
