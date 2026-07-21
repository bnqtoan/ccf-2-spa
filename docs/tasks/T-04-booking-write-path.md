---
id: T-04
title: Booking write path + transaction re-check + 409 SLOT_TAKEN
status: todo
model: opus
effort: high
depends_on: ["T-03"]
touches:
  - src/worker/lib/validate-booking.ts
  - src/worker/routes/bookings.ts
  - src/worker/db/bookings.ts
  - src/worker/index.ts
  - tests/api/bookings.test.ts
prd_refs: ["§5", "§11", "§9"]
owner: null
started_at: null
finished_at: null
---

# T-04 · Booking write path + transaction re-check

## Mục tiêu
Ghi được một lịch hẹn vào DB **mà không bao giờ tạo ra hai booking chồng nhau
trên cùng một KTV**, kể cả khi hai khách bấm cùng lúc. Đây là task quyết định
hệ thống có dùng được thật hay không.

## Ngữ cảnh cần biết
Đường ghi đã chốt (PRD §5):

```
BEGIN
  re-run availability for (variant, start_at, staff_id)   -- authoritative check
  if not available: ROLLBACK → 409 SLOT_TAKEN
  insert appointment
  insert booking_item(s)
COMMIT
```

**Kết quả availability mà client cầm chỉ là tham khảo.** Nó được tính ở một thời
điểm trước đó; giữa lúc đó và lúc bấm, người khác có thể đã chiếm chỗ. Chỉ lần
kiểm tra bên trong transaction mới là chân lý. Hai khách tranh slot cuối → một
người 201, một người 409, UI làm mới danh sách.

Auto-assign (PRD §4): khi khách không chọn KTV, chọn người **ít phút đã đặt nhất
trong ngày**, hoà thì `staff_id` nhỏ hơn.

Một booking đơn = một `appointment` + đúng một `booking_item`. Cấu trúc tách đôi
đã có sẵn từ T-02 (PRD §3.2).

## Phạm vi
**Trong:**
- `POST /api/bookings` — `{ customer: {name, phone}, variant_id, start_at, staff_id? }`
- Tìm hoặc tạo `customers` theo `phone`
- Auto-assign khi không truyền `staff_id`
- Toàn bộ validation PRD §11 áp dụng cho booking online
- Ghi trong transaction, re-check trước khi commit
- `GET /api/bookings?phone=` — khách tra cứu lịch của mình

**Ngoài:**
- Không làm huỷ lịch (T-05)
- Không làm walk-in (T-08) — walk-in có luật riêng, miễn lưới 15 phút
- Không làm UI
- Không gửi thông báo (v2)

## Đầu vào đã có
- **T-03 để lại `computeAvailability()` trong `src/worker/lib/availability.ts`**
  — dùng lại chính hàm này cho lần re-check trong transaction. Không viết lại
  logic kiểm tra rảnh/bận lần hai; hai bản sao sẽ trôi khỏi nhau.
- `src/worker/lib/intervals.ts`, `src/worker/lib/time.ts` từ T-03
- T-02: schema + types + index

## Việc phải làm
1. **`validate-booking.ts`** — hàm thuần, trả mã lỗi PRD §9:
   - `start_at` đúng lưới 15 phút → nếu không: `VALIDATION`
   - Không ở quá khứ → `VALIDATION`
   - KTV có skill của service → `STAFF_LACKS_SKILL`
   - `[start_at, block_end_at)` nằm gọn trong một ca → `OUTSIDE_SHIFT`
   - Không chồng time_off / item `booked`/`in_service` → `SLOT_TAKEN`
2. **`db/bookings.ts`** — hàm load dữ liệu cần cho re-check của **một** KTV tại
   **một** thời điểm (hẹp hơn availability cả ngày, cố ý cho nhanh và ít khoá).
3. **Route `POST /api/bookings`**:
   - Validate payload (tên, phone, variant_id, start_at)
   - Load variant + service; không có → 404 `NOT_FOUND`
   - Nếu không có `staff_id`: gọi availability cho đúng `start_at`, chọn theo
     luật auto-assign; không ai rảnh → 409 `SLOT_TAKEN`
   - Mở transaction: re-check → insert `customers` (nếu cần) → insert
     `appointments` → insert `booking_items` → commit
   - Trả 201 `{ appointment, item, staff }`
4. **`GET /api/bookings?phone=`** — trả lịch của số đó, kèm tên KTV và tên dịch
   vụ, sắp xếp theo `start_at`. Thiếu `phone` → 422 `VALIDATION`.
5. Tính và lưu đủ ba mốc: `start_at`, `end_at` (= start + duration),
   `block_end_at` (= end + buffer).

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §1, §2, §3, §5, §6, §8.

Nhấn lại:
- `block_end_at` dùng cho kiểm tra rảnh/bận; `end_at` chỉ để hiển thị. Ghi cả hai.
- Không xoá dòng bao giờ.
- Mã lỗi chỉ lấy trong danh sách PRD §9. Cần mã mới → dừng lại, báo.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test -- tests/api/bookings.test.ts` xanh
- [ ] `npm test` toàn bộ vẫn xanh (không làm vỡ T-03)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/api/bookings.test.ts`
- `đặt lịch hợp lệ trả 201 và tạo đúng 1 appointment + 1 booking_item`
- `booking_item lưu đúng cả end_at lẫn block_end_at, block_end_at = end_at + buffer`
- `không truyền staff_id thì auto-assign chọn KTV ít phút đặt nhất trong ngày`
- `auto-assign hoà thì chọn staff_id nhỏ hơn (tất định, chạy 2 lần cùng kết quả)`
- `đặt vào slot đã có người trả 409 SLOT_TAKEN`
- `đặt chồng lên phần buffer của booking trước trả 409 SLOT_TAKEN`
- `đặt ngay tại block_end_at của booking trước thành công (kề nhau hợp lệ)`
- `hai request song song cùng slot: đúng một cái 201, một cái 409`
- `chọn KTV không có skill trả 409 STAFF_LACKS_SKILL`
- `đặt ngoài ca làm việc trả 409 OUTSIDE_SHIFT`
- `đặt trùng giờ nghỉ phép của KTV trả 409 SLOT_TAKEN`
- `start_at lệch lưới 15 phút trả 422 VALIDATION`
- `đặt trong quá khứ trả 422 VALIDATION`
- `variant_id không tồn tại trả 404 NOT_FOUND`
- `khách đã có số điện thoại thì tái sử dụng customer cũ, không tạo bản ghi mới`
- `GET /api/bookings?phone= trả đúng lịch của số đó, không lẫn số khác`
- `GET /api/bookings thiếu phone trả 422 VALIDATION`

## Định nghĩa "xong"
Bắn hai `POST /api/bookings` cùng lúc (`Promise.all`) vào đúng một slot với đúng
một KTV rảnh: đúng một request trả 201, request kia trả 409 `SLOT_TAKEN`, và
truy vấn DB sau đó thấy **đúng một** `booking_item` cho khoảng thời gian đó.

## Cạm bẫy đã biết
- **Kiểm tra rảnh/bận ngoài transaction rồi mới ghi là lỗi kinh điển.** Test tuần
  tự vẫn xanh; chỉ vỡ khi có tải thật. Test "hai request song song" là chốt chặn
  duy nhất — đừng làm nó thành tuần tự cho dễ qua.
- D1 dùng `batch()` để chạy nhiều câu lệnh nguyên tử; kiểm tra kỹ ngữ nghĩa
  transaction thật sự của nó và **ghi lại phát hiện vào "Đã làm gì"**. Nếu
  `batch()` không đủ đảm bảo, hãy dùng thêm điều kiện chống chồng ngay trong câu
  `INSERT ... SELECT ... WHERE NOT EXISTS (...)` để DB tự là trọng tài, rồi kiểm
  số dòng đã ghi.
- Viết lại logic overlap ở đây thay vì gọi lại T-03 sẽ tạo hai bản sự thật; vài
  tuần sau chúng khác nhau và không ai biết bản nào đúng.
- Auto-assign không tất định (ví dụ dựa vào thứ tự trả về của SQL không có
  `ORDER BY`) làm test chập chờn và khiến việc điều tra sự cố thật bất khả thi.

## Đã làm gì
(agent điền khi xong)
