---
id: T-42
title: /api/availability trả REASON khi rỗng — nói đúng vì sao hết slot
status: review
model: sonnet
effort: medium
depends_on: ["T-03"]
touches:
  - src/worker/routes/availability.ts
  - src/app/routes/admin/timeline/api.ts
  - src/app/routes/admin/timeline/TimelinePage.tsx
  - tests/api/availability.test.ts
prd_refs: []
owner: null
started_at: 2026-07-30 18:06
finished_at: 2026-07-30 18:06
---

# T-42 · Lý do lưới slot rỗng

## Mục tiêu
Lưới rỗng chỉ báo "hết giờ, chọn ngày khác" — không phân biệt "KTV phục vụ dịch vụ
này đều nghỉ" với "thật sự kín". Trả `reason` để UI nói đúng nguyên nhân + hành động
sửa được.

## Ngữ cảnh
Ca thật gặp phải: dịch vụ tóc rỗng vì KTV tóc duy nhất bị gỡ ca hôm đó — trông như bug
nhưng là data. UI cần nói rõ để lễ tân hiểu, không tưởng lỗi.

## Đã làm gì
- `/api/availability` trả `reason` kèm `slots` rỗng (chỉ khi rỗng; backward-compatible):
  - `no_staff_skilled`: không KTV active nào có kỹ năng dịch vụ.
  - `no_staff_on_shift`: có KTV đủ kỹ năng nhưng không ai vào ca ngày đó.
  - `fully_booked`: có ca nhưng booking/nghỉ chiếm hết.
- Create-sheet admin hiện thông báo riêng từng ca (và trỏ Thiết lập/Ca làm việc cho
  các ca sửa được). (T-43 sau tách thêm `day_over` khỏi `fully_booked`.)
- Verify: typecheck sạch; 455/455 vitest (4 case reason mới); E2E 102/1-skip.
