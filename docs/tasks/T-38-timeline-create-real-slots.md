---
id: T-38
title: Create-sheet timeline chọn từ SLOT CÒN TRỐNG THẬT (bỏ nhập giờ tự do)
status: review
model: sonnet
effort: medium
depends_on: ["T-29"]
touches:
  - src/app/routes/admin/timeline/TimelinePage.tsx
  - src/app/routes/admin/timeline/api.ts
prd_refs: []
owner: null
started_at: 2026-07-30 13:03
finished_at: 2026-07-30 15:58
---

# T-38 · Create-sheet chọn giờ từ availability thật

## Mục tiêu
Sửa bug người dùng báo: "đặt lịch trên timeline, chọn giờ nào cũng báo không có KTV".
Nguyên nhân: sheet cho nhập GIỜ TỰ DO (kể cả giờ quá khứ / ngoài ca) rồi mới hỏi
availability → luôn rỗng. Thay bằng: hiện LƯỚI slot còn trống thật (engine đã lọc
tương lai + kỹ năng + ca), chọn giờ → chọn KTV.

## Ngữ cảnh
- Engine `/api/availability` đã trả slot `{start_at, staff_ids}` đúng (T-03). Vấn đề
  thuần ở UI create-sheet: nó không hỏi engine trước khi cho chọn giờ.

## Phạm vi
**Trong:** create-sheet dùng `getAvailability(variant, date)`, render grid slot thật;
KTV dropdown lọc theo slot đã chọn.
**Ngoài:** không đổi engine, không đổi write-path.

## Đã làm gì
- Create-sheet: chọn dịch vụ+gói → gọi `getAvailability` → hiện GRID "Giờ còn trống"
  (chỉ slot future+skill+free). Chọn slot → KTV dropdown chỉ những người phục vụ được
  slot đó. Hết cảnh "chọn giờ chết → không có ai".
- KTV prefill: hiện tất cả staff cho tới khi chọn dịch vụ, rồi lọc theo availability.
- Verify: E2E timeline create-flow xanh (chọn dịch vụ → giờ trống → KTV → tạo, block
  hiện ngay). Verified LIVE bằng screenshot.
