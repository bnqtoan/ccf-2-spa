---
id: T-07
title: Time-off + affected_items + reassign queue API
status: todo
model: opus
effort: high
depends_on: ["T-04"]
touches:
  - src/worker/lib/reassign.ts
  - src/worker/routes/admin-timeoff.ts
  - src/worker/routes/admin-reassign.ts
  - src/worker/db/timeoff.ts
  - src/worker/index.ts
  - tests/api/timeoff-reassign.test.ts
prd_refs: ["§8", "§9", "§11"]
owner: null
started_at: null
finished_at: null
---

# T-07 · Time-off + affected_items + reassign queue

## Mục tiêu
Khi một KTV nghỉ đột xuất, những khách đã đặt trước **không được biến mất trong
im lặng**. Hệ thống phải nêu tên từng lịch bị ảnh hưởng và giữ chúng trong một
hàng chờ cho tới khi lễ tân xử lý xong từng cái.

## Ngữ cảnh cần biết
PRD §8, nguyên văn ý chính:

> Creating `time_off` that overlaps existing bookings must never silently orphan
> them. The desk creates the time-off, and the API responds with the affected
> items rather than refusing.

```
POST /api/admin/time-off
  → 200 { time_off, affected_items: [...] }   -- created, conflicts surfaced
```

Ba điểm dễ hiểu sai:

1. **Không từ chối tạo time-off.** KTV đã nghỉ rồi, chối bỏ sự thật không giúp
   được ai. Cứ tạo, rồi phơi bày hậu quả.
2. **Booking bị ảnh hưởng giữ nguyên `status='booked'` và giữ nguyên
   `staff_id` cũ.** Không tự động huỷ, không tự động chuyển. Một người thật phải
   gọi cho từng khách. Hàng chờ chưa xử lý xong chính là mục đích.
3. **Reassign phải validate y hệt một booking mới** (skill, ca làm, chồng giờ),
   nếu không nó sẽ tạo ra đúng cái double-booking mà nó sinh ra để sửa.

Hàng chờ được suy ra, không lưu cờ: một `booking_item` là "mồ côi" khi nó đang
`booked`/`in_service` và khoảng `[start_at, block_end_at)` của nó chồng lên một
`time_off` của chính KTV đó. Suy ra từ dữ liệu sống thì không bao giờ lệch; một
cột cờ thì sẽ lệch.

## Phạm vi
**Trong:**
- `POST /api/admin/time-off` → tạo + trả `affected_items`
- `DELETE /api/admin/time-off/:id` → xoá time-off (KTV đi làm lại được)
- `GET /api/admin/reassign-queue` → các item mồ côi, kèm thông tin khách để gọi
- `GET /api/admin/bookings/:id/reassign-candidates` → ai nhận được item này
- `POST /api/admin/bookings/:id/reassign` → chuyển sang KTV khác
- `src/worker/lib/reassign.ts` — logic thuần tìm ứng viên

**Ngoài:**
- Không làm UI (T-12/T-13)
- Không tự động chuyển KTV — luôn là hành động có chủ ý của con người
- Không gửi SMS/thông báo cho khách (v2)
- Không làm CRUD time-off dạng lịch nghỉ cố định hàng tuần (đó là `work_shifts`)

## Đầu vào đã có
- **T-04 để lại `src/worker/lib/validate-booking.ts`** — reassign **phải dùng lại
  đúng hàm này** để kiểm tra KTV mới. Đây là điểm cốt lõi: một bộ luật, một chỗ.
- T-03: `computeAvailability()`, `intervals.ts` (`overlaps`), `time.ts`
- T-02: bảng `time_off` + index `time_off(staff_id, start_at)`

## Việc phải làm
1. **`POST /api/admin/time-off`** — body `{ staff_id, start_at, end_at, reason }`:
   - Validate: `start_at < end_at`, staff tồn tại → không thì 422/404
   - Insert time_off
   - Truy vấn các `booking_item` của KTV đó đang `booked`/`in_service` mà
     `[start_at, block_end_at)` chồng khoảng nghỉ
   - Trả `200 { time_off, affected_items: [...] }` với đủ thông tin để gọi khách:
     tên khách, số điện thoại, tên dịch vụ, giờ hẹn
2. **`GET /api/admin/reassign-queue`** — suy ra như mô tả trên, sắp xếp theo
   `start_at` tăng dần (khách gần giờ nhất phải gọi trước).
3. **`GET /api/admin/bookings/:id/reassign-candidates`** — với mỗi KTV active
   khác, trả `{ staff, eligible: boolean, reason }`. `reason` giải thích **vì sao
   không được**: thiếu skill / ngoài ca / bận giờ đó / đang nghỉ phép. Lễ tân cần
   biết lý do, không chỉ biết danh sách rỗng.
4. **`POST /api/admin/bookings/:id/reassign`** — body `{ staff_id }`:
   - Gọi lại `validate-booking.ts` với KTV mới, cùng `start_at`/`block_end_at` cũ
   - Không hợp lệ → 409 với đúng mã (`STAFF_LACKS_SKILL`, `OUTSIDE_SHIFT`,
     `SLOT_TAKEN`)
   - Hợp lệ → cập nhật `staff_id` trong transaction, re-check trước khi commit
   - Item đã `cancelled`/`done` → 409 `INVALID_TRANSITION`
5. **`DELETE /api/admin/time-off/:id`** — xoá xong, các item liên quan tự rời
   hàng chờ (vì hàng chờ là suy ra, không phải cờ).

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §1, §2, §3, §5, §6, §8.

Nhấn lại: chồng nhau là `a.start < b.end && b.start < a.end`. Nghỉ phép bắt đầu
đúng lúc `block_end_at` của một booking thì **không** ảnh hưởng booking đó.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test -- tests/api/timeoff-reassign.test.ts` xanh
- [ ] `npm test` toàn bộ vẫn xanh
- [ ] `reassign` gọi lại `validate-booking.ts` của T-04, không tự viết lại luật
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/api/timeoff-reassign.test.ts`
- `tạo time-off không đè booking nào trả affected_items rỗng`
- `tạo time-off đè 2 booking trả đúng 2 affected_items`
- `time-off vẫn được tạo dù có booking bị ảnh hưởng (không trả lỗi)`
- `affected_items giữ nguyên status booked và staff_id cũ`
- `affected_items có đủ tên khách và số điện thoại để gọi`
- `time-off bắt đầu đúng tại block_end_at của booking thì booking đó không bị ảnh hưởng`
- `time-off chỉ đè phần buffer vẫn tính là ảnh hưởng`
- `booking đã cancelled không vào affected_items`
- `reassign-queue trả các item mồ côi, sắp xếp theo start_at tăng dần`
- `xoá time-off thì hàng chờ rỗng trở lại`
- `reassign-candidates đánh dấu KTV thiếu skill là không đủ điều kiện, kèm lý do`
- `reassign-candidates đánh dấu KTV bận giờ đó là không đủ điều kiện, kèm lý do`
- `reassign-candidates đánh dấu KTV ngoài ca là không đủ điều kiện, kèm lý do`
- `reassign sang KTV hợp lệ trả 200 và đổi staff_id`
- `sau khi reassign, item rời khỏi reassign-queue`
- `reassign sang KTV thiếu skill trả 409 STAFF_LACKS_SKILL`
- `reassign sang KTV đang bận giờ đó trả 409 SLOT_TAKEN`
- `reassign sang KTV ngoài ca trả 409 OUTSIDE_SHIFT`
- `reassign item đã cancelled trả 409 INVALID_TRANSITION`
- `reassign hai item vào cùng KTV cùng khung giờ: cái thứ hai trả 409 SLOT_TAKEN`

## Định nghĩa "xong"
Kịch bản đầy đủ chạy được: đặt 2 lịch cho KTV A → tạo time-off phủ cả 2 →
API trả đúng 2 `affected_items` → `reassign-queue` có đúng 2 item → chuyển item
thứ nhất sang KTV B (đủ skill, rảnh) thành công → hàng chờ còn 1 → thử chuyển
item thứ hai sang KTV C thiếu skill nhận 409 `STAFF_LACKS_SKILL` → hàng chờ vẫn
còn 1 item chưa xử lý.

## Cạm bẫy đã biết
- **Thêm cột `is_orphaned` để đánh dấu là sai.** Cờ sẽ lệch với thực tế ngay khi
  time-off bị xoá hoặc booking bị huỷ. Suy ra từ dữ liệu sống, luôn đúng.
- **Tự động huỷ hoặc tự động chuyển các booking bị ảnh hưởng là phá nghiệp vụ.**
  Khách phải được gọi trước. Hàng chờ tồn tại chính vì con người phải can thiệp.
- **Viết lại luật kiểm tra trong reassign** thay vì gọi `validate-booking.ts` sẽ
  tạo ra một lỗ hổng: reassign trở thành đường vòng để tạo double-booking. Đây
  là lỗi nguy hiểm nhất trong card này.
- Reassign cũng cần re-check trong transaction, y như T-04 — hai lễ tân cùng
  chuyển hai khách vào một KTV rảnh sẽ tạo trùng lịch nếu chỉ kiểm tra rồi ghi.
- Quên rằng buffer cũng thuộc khoảng bị ảnh hưởng: một time-off chỉ chạm vào
  phần buffer vẫn khiến KTV không kịp dọn dẹp, vẫn phải vào hàng chờ.

## Đã làm gì
(agent điền khi xong)
