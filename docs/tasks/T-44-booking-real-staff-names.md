---
id: T-44
title: Trang đặt lịch khách hiện TÊN KTV thật (bỏ "Kỹ thuật viên #id")
status: review
model: sonnet
effort: low
depends_on: ["T-03", "T-10"]
touches:
  - src/worker/routes/availability.ts
  - src/app/lib/apiClient.ts
  - src/app/routes/booking/BookingPage.tsx
  - tests/api/availability.test.ts
  - tests/e2e/customer-booking.spec.ts
prd_refs: []
owner: null
started_at: 2026-07-30 19:48
finished_at: 2026-07-30 19:48
---

# T-44 · Tên KTV thật ở trang đặt lịch

## Mục tiêu
Bộ chọn KTV trên trang đặt lịch của khách (và màn xác nhận) hiện "Kỹ thuật viên #2"
thay vì tên thật, vì `/api/availability` chỉ trả `staff_ids` không kèm tên.

## Phạm vi
**Trong:** thêm tên KTV vào response availability + map ở client; render tên thật.
**Ngoài:** không đổi engine tính slot; combo flow để card riêng nếu cần.

## Đã làm gì
- `/api/availability` trả thêm `staff: {id,name}[]` (ứng viên đủ kỹ năng), cạnh `slots`
  — additive, backward-compatible.
- `apiClient.getAvailability` trả `{ slots, staffNames: Map<id,name> }`.
- `BookingPage`: thẻ chọn KTV hiện tên thật; luồng tên chọn xuống màn xác nhận. Fallback
  '#id' chỉ khi thiếu tên. DoneScreen đã dùng `result.staff.name` (server truth).
- Verify: typecheck sạch; 459/459 vitest (assert `staff:[{id,name}]`); E2E 102/1-skip
  (customer-booking đổi assertion sang tên fixture thật).
