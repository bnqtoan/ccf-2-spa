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
  - src/app/routes/admin/timeline/api.ts
  - src/worker/routes/admin-bookings.ts
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
- `insertBookingAtomically` (`src/worker/db/bookings.ts`) — ĐÃ type sẵn
  `source: 'online' | 'walk_in' | 'admin'` nhưng CHƯA route nào dùng `'admin'`.
  Đây là write-path để dùng lại. **Không viết validate mới.**
- `validateBooking` (slot/skill/shift) — dùng lại y hệt.
- **Endpoint cần tạo mới** (đã chốt với owner): `POST /api/admin/bookings` trong file
  MỚI `src/worker/routes/admin-bookings.ts` — mẫu giống cách T-08 tạo
  `admin-walkin.ts`. KHÁC walk-in: nhận giờ tương lai do lễ tân chọn (không phải
  `serverNow()`), status khởi tạo `booked` (không `in_service`), `source='admin'`.
  Mount bằng đúng 1 dòng trong `registerRoutes()` (CONVENTIONS §7).
- Endpoint cũ KHÔNG dùng được (ghi để khỏi lặp phân tích): `POST /api/bookings` là
  của khách (`source:'online'`, không gate); `POST /api/admin/walk-ins` chỉ tạo
  "ngay bây giờ".
- RBAC: gate `adminAuthGuard` owner + receptionist ở route mới — technician → 403.
  Gate ở route, không chỉ ẩn UI (bài học T-28).

## Việc phải làm
1. Backend: tạo `src/worker/routes/admin-bookings.ts` — `POST /api/admin/bookings`,
   gate owner+receptionist, nhận {name, phone, variant_id, start_at, staff_id?},
   gọi `validateBooking` + `insertBookingAtomically(source='admin', status='booked')`.
   Mount 1 dòng trong `index.ts`.
2. FE api client (`timeline/api.ts`): thêm hàm gọi endpoint mới.
3. Grid: ô trống nhận onClick → tính (staff_id, start_at) từ toạ độ ô.
4. Mở sheet đặt lịch prefill; cho sửa giờ/KTV.
5. Submit → gọi API tạo; render lại grid.
6. Thêm nút "+ Đặt lịch" trên qbar của timeline.

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
