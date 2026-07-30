---
id: T-43
title: Timeline chủ động dẫn dắt — chặn ô quá khứ / ngoài ca, tô mờ cột KTV nghỉ, nhảy ngày mai
status: review
model: opus
effort: high
depends_on: ["T-42"]
touches:
  - src/app/routes/admin/timeline/TimelinePage.tsx
  - src/app/routes/admin/timeline/timeline.css
  - src/app/routes/admin/timeline/api.ts
  - src/worker/routes/admin-schedule.ts
  - src/worker/routes/availability.ts
  - tests/api/admin-schedule.test.ts
  - tests/api/availability.test.ts
  - vitest.config.ts
prd_refs: []
owner: null
started_at: 2026-07-30 18:22
finished_at: 2026-07-30 19:13
---

# T-43 · Timeline booking guardrails

## Mục tiêu
UI phải giúp lễ tân đỡ đoán: đừng để bấm vào ô không đặt được rồi mới gặp lưới rỗng.
Chặn trực quan mọi ô KHÔNG đặt được, và nói đúng vì sao.

## Ngữ cảnh — các bug người dùng báo
- "Bấm ô giờ thì ít nhất phải có slot giờ đó" — sheet nhảy về 09:00.
- "Nói 30/7 hết slot nhưng lịch trống trơn" — thật ra là cuối ca, `fully_booked` là
  nhãn sai.
- "Mọi KTV đóng ca 19:00, sao còn ô 19/20h đặt được?" — grid vẽ 08–20 hardcode.

## Đã làm gì
- **`day_over`**: tách khỏi `fully_booked`. Chạy lại engine với `now=dayStart`; nếu có
  slot mà `now` thật thì không → rỗng do QUÁ-KHỨ (cuối ca), không phải kín. Message:
  "đã qua giờ đặt… không đủ thời gian trước giờ đóng cửa". `reason` giờ gồm
  no_staff_skilled | no_staff_on_shift | day_over | fully_booked.
- **Ô giờ quá khứ** (chỉ hôm nay): mờ + gạch chéo + không bấm, tooltip "Đã qua giờ này".
- **Tôn trọng giờ bấm**: chọn slot cùng giờ vừa bấm (14h → ~14h), không nhảy 09:00.
- **Nút "Xem ngày mai →"** trong empty-state cho các reason sửa-bằng-đổi-ngày.
- **Grey cột KTV nghỉ**: `/api/admin/schedule?date=` trả `shift {start_min,end_min}|null`
  cho weekday ngày xem (batched, fixed-2-param JOIN active staff, gộp nhiều dòng ca →
  bao ngoài). Cột không-ca: header mờ ("Nghỉ hôm nay"), ô trống không bấm.
- **Ô ngoài ca của chính KTV** (fix 19/20h): `computeHourRange` bám ca thật (fallback
  09–19), và ô `[h:00)` ngoài `[start,end)` → không bấm ("Ngoài giờ làm việc"). Booking
  cũ ngoài ca vẫn hiện; drag-drop giữ nguyên (server là trọng tài SLOT_TAKEN).
- `TEST_CLOCK='1'` bật trong vitest bindings (header-gated, prod bỏ qua) để test day_over.
- Verify: typecheck sạch; 459/459 vitest (reason + shift-field + day_over); E2E 102/1-skip;
  deploy live, đã verify `/api/version` + reason live.
