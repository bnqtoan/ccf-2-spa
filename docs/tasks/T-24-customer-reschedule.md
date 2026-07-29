---
id: T-24
title: G5 — Khách tự đổi giờ (reschedule) lịch của mình
status: todo
model: opus
effort: medium
depends_on: []
touches:
  - src/worker/routes/           # endpoint reschedule nguyên tử
  - src/worker/db/               # bookings helper (dùng lại validate + guard)
  - src/app/routes/lookup/       # nút "Đổi giờ" + màn chọn slot mới
  - tests/
prd_refs: ["§5", "§6"]
owner: null
started_at: null
finished_at: null
---

# T-24 · G5 — Khách tự đổi giờ (reschedule)

## Mục tiêu
Hiện khách chỉ HUỶ được (LookupPage). Muốn dời giờ phải huỷ rồi đặt lại → mất slot
giữa chừng, người khác cướp mất. Task này cho khách **đổi giờ NGUYÊN TỬ**: mở lại
grid chọn giờ mới, đổi trong một thao tác, giữ cutoff 2h.

## Ngữ cảnh cần biết
- Audit G5 (P1): "khách dời lịch phải huỷ→mất slot→tranh lại". Copy app hứa "đổi
  lịch" nhưng chỉ có nút Huỷ.
- Cutoff huỷ 2h (CANCEL_CUTOFF_MIN=120) áp cho cả đổi giờ — dưới 2h thì như huỷ,
  chuyển hotline.
- Reschedule = huỷ item cũ + tạo item mới, PHẢI nguyên tử (không để trạng thái
  nửa vời: đã huỷ cũ mà chưa đặt được mới).

## Phạm vi
**Trong:**
- Endpoint `POST /api/bookings/:id/reschedule` body `{ start_at, staff_id? }`:
  re-validate slot mới (dùng lại validateBooking — skill/ca/overlap/grid), rồi
  ĐỔI item sang giờ mới NGUYÊN TỬ (SQL guard: chỉ đổi nếu slot mới còn trống VÀ
  item cũ còn 'booked'). Slot mới bị cướp giữa chừng → 409 SLOT_TAKEN, item cũ
  GIỮ NGUYÊN (không mất). Giữ cutoff 2h (dưới → CANCEL_TOO_LATE).
- LookupPage: nút "Đổi giờ" cạnh "Huỷ" (chỉ hiện khi >2h). Bấm → mở lại slot grid
  của đúng dịch vụ đó (dùng lại component chọn giờ của BookingPage) → chọn giờ mới
  → xác nhận. Slot mới bị cướp → báo nhẹ, chọn lại (như luồng đặt).

**Ngoài:**
- KHÔNG đổi dịch vụ/gói (chỉ đổi GIỜ; đổi dịch vụ = huỷ+đặt mới).
- KHÔNG cho admin reschedule ở card này (khác luồng; admin đã có reassign).

## Đầu vào đã có
- `validateBooking` (lib/validate-booking.ts) — tái dùng, đừng viết lại.
- `insertBookingAtomically` / SQL-guard pattern (db/bookings.ts) — mẫu nguyên tử.
- cancel.ts: cutoff check (canCustomerCancel), stamp cancelled_at.
- BookingPage slot grid (availability) — tái dùng UI chọn giờ.
- LookupPage:105-112 nút Huỷ — thêm nút Đổi giờ cạnh.

## Việc phải làm
1. Endpoint reschedule nguyên tử (re-validate + SQL guard, giữ cutoff 2h).
2. UI: nút Đổi giờ (>2h) → slot grid → xác nhận → cập nhật lịch.
3. States: slot mới bị cướp (409), <2h (hotline), thành công (hiện giờ mới).

## Quy ước bắt buộc (CONVENTIONS)
- §5: mã lỗi SLOT_TAKEN(409)/CANCEL_TOO_LATE(409)/VALIDATION(422)/NOT_FOUND(404) —
  KHÔNG nghĩ mã mới. §6: validate đầy đủ. §7: route 1 dòng. §8/§9.
- Nguyên tử: KHÔNG huỷ-cũ-rồi-đặt-mới bằng 2 request; một endpoint, một guard.

## Checklist đầu ra
- [ ] typecheck · npm test · e2e --workers=1 xanh
- [ ] status review + "Đã làm gì"

## Test phải viết
- `reschedule sang slot trống hợp lệ (>2h) → item đổi giờ, giờ cũ mở lại`
- `reschedule mà slot mới vừa bị chiếm → 409 SLOT_TAKEN, item CŨ GIỮ NGUYÊN (không mất)`
- `reschedule dưới 2h → CANCEL_TOO_LATE (như huỷ)`
- `reschedule sang giờ ngoài ca / KTV thiếu skill → 422 VALIDATION, item cũ giữ`
- `reschedule item đã cancelled/done → 409 INVALID_TRANSITION`
- E2E: `khách mở lookup → Đổi giờ → chọn giờ mới → thấy lịch giờ mới`

## Định nghĩa "xong"
Khách dời được lịch sang giờ khác trong một thao tác, không bao giờ rơi vào trạng
thái "đã mất giờ cũ mà chưa có giờ mới" — nếu giờ mới bất khả thi, giờ cũ nguyên vẹn.

## Cạm bẫy đã biết
- **Silent side-effect:** nếu reschedule không nguyên tử (huỷ trước, đặt sau) và
  đặt fail → khách mất lịch âm thầm. PHẢI test "slot mới bị cướp → item cũ giữ nguyên".
- Cutoff phải tính server-side như cancel, không tin client.
- Dùng lại validateBooking — đừng bỏ sót rule nào (grid/skill/ca/overlap/time-off).

## Đã làm gì
(agent điền khi xong)
