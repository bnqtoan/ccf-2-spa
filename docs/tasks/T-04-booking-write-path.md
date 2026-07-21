---
id: T-04
title: Booking write path + transaction re-check + 409 SLOT_TAKEN
status: done
model: opus
effort: high
depends_on: ["T-03"]
touches:
  - src/worker/lib/validate-booking.ts
  - src/worker/routes/bookings.ts
  - src/worker/db/bookings.ts
  - src/worker/routes/index.ts
  - tests/api/bookings.test.ts
prd_refs: ["§5", "§11", "§9"]
owner: null
started_at: null
finished_at: 2026-07-21
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

   **Chữ ký hàm phải nhận cờ `isWalkIn: boolean` (mặc định `false`).** Khi
   `isWalkIn = true`, bỏ qua **đúng hai** luật: lưới 15 phút và "không ở quá
   khứ" (walk-in bắt đầu tại `now`). Mọi luật còn lại giữ nguyên.

   Cờ này có mặt ngay từ T-04 dù T-04 không dùng tới, vì T-08 (walk-in) sẽ gọi
   lại chính hàm này. Không có cờ, T-08 buộc phải copy-paste một bản validate
   thứ hai — và hai bản luật sẽ trôi khỏi nhau. PRD §11 đã ghi sẵn ngoại lệ
   "trừ `source='walk_in'`", nên đây là yêu cầu đã biết trước, không phải phát
   sinh.
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
- [x] `npm run typecheck` xanh
- [x] `npm test -- tests/api/bookings.test.ts` xanh (41 test)
- [x] `npm test` toàn bộ vẫn xanh (123 test / 6 file — không làm vỡ T-03)
- [x] Không đụng file ngoài `touches`
- [x] Cập nhật `status: review` + `finished_at`
- [x] Ghi "Đã làm gì"

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
- `validate với isWalkIn=true chấp nhận start_at lệch lưới 15 phút`
- `validate với isWalkIn=true vẫn chặn KTV thiếu skill`
- `validate với isWalkIn=true vẫn chặn khi KTV đang bận`
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

### Kết quả
`npm run typecheck` xanh. `npm test` xanh — 123 test / 6 file, trong đó
`tests/api/bookings.test.ts` có 41 test. Chạy lại 3 lần liên tiếp đều xanh,
không chập chờn. Không đụng file nào ngoài `touches`; `routes/index.ts` chỉ
thêm 2 dòng (1 import + 1 `app.route`).

### Phát hiện về ngữ nghĩa transaction của D1 (đo thật, không đoán)

Đã dựng test thăm dò chạy trên D1 thật trong workerd trước khi thiết kế. Năm
kết quả, theo thứ tự quan trọng:

1. **`db.batch([...])` CÓ tính nguyên tử.** Một câu lệnh sau vi phạm ràng buộc
   sẽ cuốn ngược các câu trước. (Thăm dò: vi phạm NOT NULL ở câu 2 → bảng còn
   0 dòng, câu 1 đã bị rollback.)
2. **`BEGIN` / `COMMIT` tường minh bị D1 TỪ CHỐI thẳng**, với thông báo
   "To execute a transaction, please use the state.storage.transaction() ...
   APIs instead of the SQL BEGIN TRANSACTION". Vậy `batch()` là **primitive
   transaction duy nhất** dùng được ở đây.
3. **Hệ quả quyết định toàn bộ thiết kế:** một batch là danh sách câu lệnh cố
   định gửi đi cùng lúc — **không có JavaScript nào chạy được GIỮA các câu**.
   Nên mẫu "đọc các dòng xung đột → quyết định trong JS → ghi" là **không thể
   làm nguyên tử**, vì chính cái `await` khi đọc đã nhả isolate cho request
   khác chen vào. Thăm dò xác nhận: hai lượt đọc-rồi-ghi song song đều thấy
   bảng trống và **cả hai đều ghi** → 2 dòng chồng nhau. Đây đúng là cạm bẫy
   card cảnh báo.
4. **Vì vậy lần re-check phải được VIẾT BẰNG SQL NGAY TRONG câu ghi.**
   `INSERT ... SELECT ... WHERE NOT EXISTS (...)` để chính DB làm trọng tài,
   rồi đọc `meta.changes` (1 = thắng, 0 = thua). Thăm dò: hai câu INSERT có
   điều kiện chạy song song → `changes` là 1 và 0, bảng đúng 1 dòng.
5. **`last_insert_rowid()` nhìn thấy được ở câu sau trong cùng batch**, và
   `RETURNING` hoạt động trong batch (`results` rỗng khi điều kiện chặn). Nhờ
   đó nối `appointments` → `booking_items` không cần vòng round-trip qua JS.

Ngoài lề nhưng đáng ghi: `RAISE(ABORT, ...)` **không** dùng được ngoài trigger
("RAISE() may only be used within a trigger-program"), nên không thể dùng nó để
ép rollback giữa batch.

**Cách đã chọn:** cả HAI câu INSERT (`appointments` và `booking_items`) mang
**cùng một điều kiện** `WHERE NOT EXISTS (...)`. Bên thua cuộc vì thế **không
ghi gì cả** — không appointment, không item — nên không có dòng mồ côi để dọn
và không cần cố tình gây lỗi để ép rollback. Điều kiện dùng
`bi.start_at < ? AND bi.block_end_at > ?` (nửa mở, `<`/`>` chứ không phải
`<=`/`>=`), lấy `block_end_at` ở cả hai vế; `end_at` không xuất hiện ở đâu
trong vị từ này.

### Chữ ký `validateBooking()` — để T-07/T-08 gọi lại đúng

`src/worker/lib/validate-booking.ts`, hàm thuần, không import D1:

```ts
validateBooking(input: ValidateBookingInput): BookingValidationError | null

interface ValidateBookingInput {
  variant: Pick<ServiceVariant, 'duration_min' | 'buffer_after_min'>
  start_at: number            // epoch giây
  staff_id: number
  staffHasSkill: boolean      // caller tự tra staff_skills rồi truyền vào
  shifts: Pick<WorkShift, 'staff_id' | 'start_min' | 'end_min'>[]
  shiftWindows: Interval[]    // ca đã neo thành epoch qua minutesToEpoch()
  timeOff: TimeOffInterval[]
  busyItems: BusyItem[]       // status IN ('booked','in_service')
  now: number
  isWalkIn?: boolean          // mặc định false
}

type BookingErrorCode = 'VALIDATION' | 'STAFF_LACKS_SKILL' | 'OUTSIDE_SHIFT' | 'SLOT_TAKEN'
interface BookingValidationError { code: BookingErrorCode; message: string }
```

Trả `null` khi hợp lệ, hoặc luật ĐẦU TIÊN bị vi phạm. Thứ tự kiểm tra cố ý:
lưới/quá khứ → skill → ca → nghỉ phép → trùng lịch, để thông báo nêu đúng vấn
đề nền tảng nhất thay vì một hệ quả phát sinh.

**`isWalkIn = true` bỏ qua ĐÚNG HAI luật:** lưới 15 phút và "không ở quá khứ".
Mọi luật còn lại (skill, nằm gọn trong ca, nghỉ phép, chồng lịch) **giữ
nguyên** — walk-in vẫn double-book được y như đặt online. T-08 chỉ cần truyền
`isWalkIn: true`, không phải chép lại luật. Có 7 test khoá hợp đồng này, gồm 4
test khẳng định walk-in VẪN bị chặn bởi skill / ca / nghỉ phép / bận.

Hai hàm phụ cùng file, dùng chung để không ai tự tính lại:
`blockEndAt(start_at, variant)` = `start + (duration + buffer) * 60`;
`endAt(start_at, variant)` = `start + duration * 60` (chỉ để hiển thị).

### Ghi chú kiến trúc
- `validateBooking` ở tầng route là **tư vấn**, chỉ để trả mã lỗi chính xác
  (`STAFF_LACKS_SKILL`, `OUTSIDE_SHIFT`) thay vì `SLOT_TAKEN` chung chung. Mọi
  thứ nó thấy đều có thể đã cũ khi câu INSERT chạy. **Điều kiện SQL mới là
  chân lý.**
- Auto-assign gọi lại `computeAvailability()` + `pickStaff()` của T-03, không
  viết lại. `pickStaff` tất định (ít phút nhất → `staff_id` nhỏ hơn) và
  `staff_ids` đã tăng dần sẵn từ `computeAvailability`.
- Tra `customers` theo phone nằm NGOÀI batch có điều kiện: dòng customer không
  phải tài nguyên khan hiếm, thua race ở đó không mất mát gì, còn gộp vào batch
  sẽ khiến batch phụ thuộc hai giá trị `last_insert_rowid()` khác nhau.

### Mutation test (15 đột biến, 15 bị giết)

Đã tự phá code rồi xác nhận test đỏ. Vòng đầu **3 đột biến sống sót**, đã bổ
sung test rồi chạy lại — hiện tất cả đều bị giết:

| # | Đột biến | Kết quả |
|---|---|---|
| M1 | Bỏ hẳn re-check trong transaction (INSERT vô điều kiện) | giết |
| M2 | Điều kiện SQL dùng `end_at` thay `block_end_at` | giết |
| M3 | `blockEndAt` bỏ mất buffer | giết |
| M4 | Nửa mở thành đóng (`<=`/`>=`) — chặn nhầm ca kề nhau | giết |
| M5 | Auto-assign mất tính tất định | giết |
| M6 | `isWalkIn` bỏ qua cả kiểm tra skill | giết |
| M7 | Cờ `isWalkIn` bị lờ đi | giết |
| M8 | Bỏ luật "không đặt trong quá khứ" | giết |
| M9 | Bỏ luật lưới 15 phút | giết |
| M10 | "Nằm gọn trong ca" nới thành "chỉ cần giao nhau" | giết |
| M11 | Bỏ điều kiện `time_off` khỏi câu SQL | giết |
| M12 | Bỏ kiểm tra `meta.changes` (chấp nhận dòng mồ côi) | giết |
| M13 | `GET` bỏ lọc theo phone | giết |
| M14 | Hỏng tái sử dụng customer | giết |
| M15 | Validator lờ `busyItems` | giết |

**Ba đột biến từng sống sót và bài học rút ra** (đáng đọc, vì nó chỉ ra một lỗ
hổng thật trong cách viết test song song):

M1, M2, M11 ban đầu đều lọt. Nguyên nhân chung: **test song song đi qua tầng
route, nên chúng chạm `validateBooking` TRƯỚC khi chạm SQL.** Nếu request A kịp
ghi xong trước khi request B validate, thì chính validate (chứ không phải điều
kiện SQL) là cái chặn B — và lỗi trong SQL không lộ ra. A có kịp hay không phụ
thuộc timing của isolate, tức là **không tất định**: cùng một test, chạy riêng
thì đỏ, chạy cả file thì xanh. Một test như vậy tệ hơn là không có, vì nó tạo
cảm giác an toàn giả.

Cách sửa: **kiểm tra lớp bảo vệ cuối cùng thẳng ở tầng DB**, gọi
`insertBookingAtomically()` trực tiếp, bỏ qua route. Ở đó không cần chạy song
song chút nào — chỉ cần seed sẵn một item rồi xem hàm ghi có tự chặn không. 6
test mới trong `describe('insertBookingAtomically — điều kiện chống chồng
trong câu INSERT')` làm việc đó, và chúng giết M1/M2/M11 một cách **tất định**.

Các test song song qua route (`Promise.all`, 2 và 5 request) vẫn giữ nguyên —
chúng khẳng định hành vi end-to-end mà card yêu cầu — nhưng chúng **không còn
là chốt chặn duy nhất** cho điều kiện SQL nữa.

### Định nghĩa "xong" của card
Bắn 2 `POST /api/bookings` cùng lúc bằng `Promise.all` vào đúng một slot với
đúng một KTV rảnh: **đúng một 201, một 409 `SLOT_TAKEN`**, và truy vấn DB sau
đó thấy **đúng một** `booking_item` (đã khẳng định cả `booking_items` lẫn
`appointments` đều đúng 1 dòng — không có appointment mồ côi). Có thêm biến thể
5 request song song → đúng 1 cái 201, 4 cái 409.
