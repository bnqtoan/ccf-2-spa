---
id: T-16
title: Ba endpoint PRD §9 chưa ai implement
status: done
model: sonnet
effort: medium
depends_on: ["T-07"]
touches:
  - src/worker/routes/services.ts
  - src/worker/routes/admin-schedule.ts
  - src/worker/routes/admin-appointment-items.ts
  - src/worker/routes/index.ts
  - tests/api/services.test.ts
  - tests/api/admin-schedule.test.ts
  - tests/api/appointment-items.test.ts
prd_refs: ["§9", "§3.2", "§3.4"]
owner: null
started_at: null
finished_at: "2026-07-22"
---

# T-16 · Ba endpoint PRD §9 chưa ai implement

## Mục tiêu
Bịt ba lỗ hổng giữa các card đã đóng, để T-10 và T-12 chạy tiếp được.

## Ngữ cảnh cần biết
**Card này sinh ra từ lỗ hổng trong kế hoạch, không phải yêu cầu mới.**
Kiểm toán toàn bộ PRD §9 với code thật cho thấy 3 endpoint không card nào nhận:

| Endpoint | Rơi vào khe giữa | Ai phát hiện |
|---|---|---|
| `GET /api/services` | T-04 (chỉ bookings) và T-06 (chỉ `/api/admin/*`) | T-10 |
| `GET /api/admin/schedule?date=` | T-06 (CRUD) và T-07 (time-off/reassign) | T-12 |
| `POST /api/admin/appointments/:id/items` | T-04 và T-07 | kiểm toán |

Cả T-10 lẫn T-12 đều dừng lại đặt `blocked` thay vì tự vá ngoài `touches` —
đúng quy tắc CONVENTIONS §9.

Khác biệt `GET /api/services` với `GET /api/admin/services` đã có:
- Admin trả **danh sách phẳng**, gồm cả `active = 0`, không kèm variant.
- Công khai trả **chỉ active**, **lồng variant active**, không lộ trường quản trị.

## Phạm vi
**Trong:**
1. `GET /api/services` — `{ services: [...] }`, chỉ service+variant `active = 1`,
   service không còn variant active thì **không xuất hiện** (không bán được thì
   đừng cho khách chọn rồi báo lỗi ở bước sau). Sắp xếp tất định: service theo
   `id`, variant theo `duration_min`.
2. `GET /api/admin/schedule?date=YYYY-MM-DD` — lịch một ngày: tất cả KTV active
   kèm `booking_items` của họ trong ngày, cộng `time_off` trong ngày. Item phải
   có đủ `start_at`/`end_at`/`block_end_at` để UI vẽ được cả buffer, kèm tên
   khách, tên dịch vụ, `status`, `source`.
3. `POST /api/admin/appointments/:id/items` — lễ tân thêm item thủ công vào một
   appointment đã có (combo v1 làm tay, PRD §1). Validate y hệt booking mới bằng
   `validateBooking`, cộng luật `body_zone`: item chồng giờ trong cùng
   appointment phải khác `body_zone` → `ZONE_CONFLICT`.

**Ngoài:**
- Không đụng `/api/admin/services` đã có
- Không thêm lọc/tìm kiếm/phân trang
- Không làm UI

## Đầu vào đã có
- T-02: bảng + type ở `src/worker/db/types.ts`
- T-06: `src/worker/db/crud.ts` có sẵn hàm đọc — xem tái dùng được không trước
  khi tự viết truy vấn mới
- **T-04: `src/worker/lib/validate-booking.ts` — `validateBooking()`.** Endpoint
  số 3 PHẢI gọi lại hàm này, không viết lại luật. Xem `src/worker/routes/
  admin-reassign.ts` để biết cách nạp dữ liệu ngữ cảnh rồi gọi.
- T-07: `src/worker/db/timeoff.ts` có hàm đọc time-off theo ngày
- CONVENTIONS §7: khai `Bindings` ở module route của mình, mount bằng một dòng
  `app.route('/', x)` trong `registerRoutes()`

## Việc phải làm
1. **`services.ts`** — một truy vấn join `services` × `service_variants`
   (đừng N+1: một câu rồi gom nhóm trong JS). Response:
   ```json
   { "services": [
     { "id": 1, "name": "Massage thư giãn", "body_zone": "body",
       "variants": [
         { "id": 1, "name": "45 phút", "duration_min": 45,
           "buffer_after_min": 10, "price": 250000 } ] } ] }
   ```
   Không trả `skill_id` và `active` (khách không cần, đã lọc rồi).
2. **`admin-schedule.ts`** — `?date=` bắt buộc, sai định dạng → 422 `VALIDATION`.
   Dùng `localDayBounds()` từ `src/worker/lib/time.ts` để lấy biên ngày địa
   phương. Lọc item giao với ngày bằng `start_at < dayEnd AND block_end_at >
   dayStart` (**không** lọc theo `start_at` một mình — booking vắt qua nửa đêm
   vẫn chiếm chỗ buổi sáng hôm sau). Response:
   ```json
   { "date": "2026-07-22",
     "staff": [ { "id": 1, "name": "Lan",
       "items": [ { "id": 9, "start_at": 0, "end_at": 0, "block_end_at": 0,
                    "status": "booked", "source": "online",
                    "customer_name": "…", "service_name": "…",
                    "variant_name": "…" } ],
       "time_off": [ { "id": 3, "start_at": 0, "end_at": 0, "reason": "…" } ] } ] }
   ```
   Chỉ item `status IN ('booked','in_service','done','no_show')` — item
   `cancelled` không hiện trên lịch.
3. **`admin-appointment-items.ts`** — body `{ variant_id, staff_id, start_at }`.
   Appointment không tồn tại → 404. Validate bằng `validateBooking`, rồi kiểm
   `body_zone`: nếu item mới chồng giờ với item nào đã có trong **cùng
   appointment** mà trùng `body_zone` → 409 `ZONE_CONFLICT`. Ghi bằng
   `insertBookingAtomically`-style guard (re-check trong SQL), không đọc-rồi-ghi.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §1 (thời gian), §2 (chiếm chỗ), §3 (trạng thái),
§5 (API), §6 (validation), §7, §8.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test -- tests/api/services.test.ts` xanh
- [ ] `npm test -- tests/api/admin-schedule.test.ts` xanh
- [ ] `npm test -- tests/api/appointment-items.test.ts` xanh
- [ ] `npm test` toàn bộ vẫn xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết

`tests/api/services.test.ts`
- `trả danh sách service kèm variant lồng bên trong`
- `service đã vô hiệu hoá (active=0) không xuất hiện`
- `variant đã vô hiệu hoá không xuất hiện trong service còn active`
- `service không còn variant active nào thì không xuất hiện`
- `variant sắp xếp theo duration_min tăng dần`
- `service sắp xếp theo id tăng dần (tất định qua nhiều lần gọi)`
- `DB rỗng trả mảng services rỗng chứ không phải lỗi`
- `response không lộ cột active hay skill_id`

`tests/api/admin-schedule.test.ts`
- `trả mọi KTV active kèm item của họ trong ngày`
- `KTV không có lịch vẫn xuất hiện với mảng items rỗng`
- `item của ngày khác không lọt vào`
- `booking vắt qua nửa đêm vẫn xuất hiện ở ngày hôm sau`
- `item cancelled không xuất hiện trên lịch`
- `item trả đủ start_at, end_at và block_end_at để UI vẽ được buffer`
- `time_off của KTV trong ngày được trả kèm`
- `thiếu date trả 422 VALIDATION`
- `date sai định dạng trả 422 VALIDATION`

`tests/api/appointment-items.test.ts`
- `thêm item hợp lệ vào appointment có sẵn trả 201`
- `item mới chồng giờ nhưng khác body_zone thì hợp lệ (tóc + móng)`
- `item mới chồng giờ và trùng body_zone trả 409 ZONE_CONFLICT`
- `KTV thiếu skill trả 409 STAFF_LACKS_SKILL`
- `KTV đã bận giờ đó trả 409 SLOT_TAKEN`
- `appointment không tồn tại trả 404 NOT_FOUND`
- `start_at lệch lưới 15 phút trả 422 VALIDATION`

## Định nghĩa "xong"
Sau `npm run db:seed:local`: `GET /api/services` trả 4 dịch vụ × 2 variant;
`GET /api/admin/schedule?date=<ngày seed có booking>` trả đủ 5 KTV, trong đó
KTV có lịch hiện đúng item kèm `block_end_at` lớn hơn `end_at`.

## Cạm bẫy đã biết
- **N+1 query** ở cả 3 endpoint: một câu join rồi gom nhóm trong JS.
- **Quên lọc `active`** ở một trong hai bảng services/variants. Lọc service mà
  quên lọc variant thì khách chọn được gói đã ngừng bán, lỗi chỉ lộ ở bước đặt.
- Service rỗng variant mà vẫn trả về tạo màn hình cụt: bấm vào không có gì chọn.
- **Lọc lịch ngày theo `start_at` một mình** làm mất booking vắt qua nửa đêm —
  nó vẫn chiếm KTV buổi sáng hôm sau. Dùng điều kiện giao khoảng.
- Viết lại luật validate ở endpoint 3 thay vì gọi `validateBooking` sẽ tạo
  đường vòng thứ hai để double-booking lọt qua — đúng lỗi T-07 đã cảnh báo.

## Đã làm gì

Implement đủ 3 endpoint. Test: 244/244 xanh (`npm test`), `npm run typecheck` sạch.
Không đụng file ngoài `touches`. `index.ts` chỉ thêm 3 import + 3 dòng
`app.route()` ở cuối `registerRoutes()`, không sửa dòng của task khác.

### 1. `GET /api/services`
`src/worker/routes/services.ts`. Một câu JOIN `services` × `service_variants`
(`WHERE s.active = 1 AND sv.active = 1`), gom nhóm trong JS bằng `Map` giữ thứ
tự `ORDER BY s.id, sv.duration_min` từ SQL — không N+1, không sort lại trong JS.

Response:
```json
{ "services": [
  { "id": 1, "name": "Massage thư giãn", "body_zone": "body",
    "variants": [
      { "id": 1, "name": "45 phút", "duration_min": 45,
        "buffer_after_min": 10, "price": 250000 } ] } ] }
```
Không có `skill_id`/`active` ở cả service lẫn variant. Service không còn
variant active nào thì không xuất hiện (INNER JOIN tự loại, không cần lọc
thêm). DB rỗng → `{ "services": [] }`.

### 2. `GET /api/admin/schedule?date=YYYY-MM-DD`
`src/worker/routes/admin-schedule.ts`. Thiếu/sai định dạng `date` → 422
VALIDATION (dùng `parseDateStr` từ `lib/time.ts`, không tự viết regex mới).
`localDayBounds(date)` lấy biên ngày địa phương. 3 câu SQL tổng cộng (staff,
items, time_off), mỗi câu `IN (staffIds)` — không lặp theo từng KTV.

Lọc item theo giao khoảng `bi.start_at < dayEnd AND bi.block_end_at > dayStart`
(không phải `start_at` một mình) — đã mutation-test xác nhận bắt được booking
vắt qua nửa đêm. Chỉ item `status IN ('booked','in_service','done','no_show')`
— `cancelled` không hiện.

Response:
```json
{ "date": "2026-07-22",
  "staff": [ { "id": 1, "name": "Lan",
    "items": [ { "id": 9, "start_at": 0, "end_at": 0, "block_end_at": 0,
                 "status": "booked", "source": "online",
                 "customer_name": "…", "service_name": "…",
                 "variant_name": "…" } ],
    "time_off": [ { "id": 3, "start_at": 0, "end_at": 0, "reason": "…" } ] } ] }
```
Mọi KTV `active=1` đều xuất hiện, kể cả không có lịch (`items: []`).

### 3. `POST /api/admin/appointments/:id/items`
`src/worker/routes/admin-appointment-items.ts`. Body
`{ variant_id, staff_id, start_at }`. Appointment không tồn tại → 404
NOT_FOUND (check trước khi parse body). Gọi lại **`validateBooking`** y hệt
(không viết lại luật) sau khi nạp context giống mẫu `admin-reassign.ts`
(shifts/time_off/busyItems cho `staff_id` tại khung `[start_at, block_end_at)`).

Cộng luật riêng của endpoint này: item mới chồng giờ với item khác **trong
cùng appointment** mà trùng `body_zone` → 409 `ZONE_CONFLICT`. Check advisory
trong JS trước (để trả mã lỗi chính xác), rồi ghi bằng một `INSERT ... SELECT
... WHERE NOT EXISTS(...)` có 3 guard trong cùng câu SQL: bận-KTV, time-off,
và zone-conflict-trong-appointment — re-check ngay tại thời điểm ghi
(`meta.changes`), đúng phát hiện D1 của T-04 (không đọc-rồi-ghi). Nếu
`meta.changes = 0`, phân biệt lại nguyên nhân (zone hay slot) bằng 1 query
nhỏ để trả đúng mã lỗi.

Response 201:
```json
{ "item": { "id": 9, "appointment_id": 1, "staff_id": 1, "variant_id": 2,
            "start_at": 0, "end_at": 0, "block_end_at": 0,
            "status": "booked", "cancelled_at": null } }
```
Lỗi: 404 NOT_FOUND, 422 VALIDATION, 409 STAFF_LACKS_SKILL / OUTSIDE_SHIFT /
SLOT_TAKEN / ZONE_CONFLICT — theo đúng `{ error: { code, message } }`.

### Mutation-test (tự phá code, xác nhận đỏ, rồi khôi phục)
Cả 3 đột biến card yêu cầu đều bị bắt bởi bộ test hiện có — không có lỗ hổng:

1. Bỏ `s.active = 1 AND sv.active = 1` trong services.ts → 3 test đỏ (service
   inactive, variant inactive, service-rỗng-variant-active đều lọt qua sai).
   Grep xác nhận đột biến ăn đúng dòng `WHERE` (không phải comment) trước khi
   tin kết quả.
2. Đổi điều kiện lọc ngày trong admin-schedule.ts từ giao khoảng
   (`start_at < dayEnd AND block_end_at > dayStart`) sang chỉ `start_at`
   (`>= dayStart AND < dayEnd`) → đúng 1 test đỏ: "booking vắt qua nửa đêm vẫn
   xuất hiện ở ngày hôm sau".
3. Vô hiệu hoá cả advisory check lẫn SQL guard body_zone trong
   admin-appointment-items.ts (thử tắt riêng advisory trước — không đủ vì SQL
   guard vẫn chặn write và trả đúng mã; phải tắt luôn SQL guard mới thấy đột
   biến lọt) → test "chồng giờ trùng body_zone trả 409 ZONE_CONFLICT" đỏ
   (nhận 201 thay vì 409). Đã grep xác nhận từng điểm sửa/khôi phục đúng dòng
   code trước khi kết luận.

Sau mỗi mutation đã khôi phục nguyên trạng và chạy lại toàn bộ `npm test`
(244/244 xanh) + `npm run typecheck` (sạch) để xác nhận không còn sót thay đổi.
