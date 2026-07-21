---
id: T-08
title: Walk-in — available-now + quick booking
status: todo
model: sonnet
effort: medium
depends_on: ["T-04"]
touches:
  - src/worker/routes/admin-walkin.ts
  - src/worker/routes/index.ts
  - tests/api/walkin.test.ts
prd_refs: ["§7", "§11"]
owner: null
started_at: null
finished_at: null
---

# T-08 · Walk-in — available-now + quick booking

## Mục tiêu
Cho lễ tân nhận khách vãng lai tại quầy: tra ai đang rảnh **ngay bây giờ**,
chọn KTV, tạo appointment lập tức — chiếm chỗ KTV đó ngay để khách online
không thể đặt trùng giờ vài giây sau.

## Ngữ cảnh cần biết
30–50% lưu lượng của một spa là khách vãng lai (PRD §7). Walk-in **là
appointment thật** — `source='walk_in'`, **tuyệt đối không mô hình hoá bằng
`time_off`**. Mô hình hoá bằng time_off nghe có vẻ tiện (chỉ cần "chặn KTV
bận") nhưng sẽ xoá sạch doanh thu, lịch sử dịch vụ, và thông tin khách — đúng
loại dữ liệu mà cả cái spa vận hành dựa trên. Nếu về sau ai hỏi "tháng này bao
nhiêu khách vãng lai, doanh thu bao nhiêu", câu trả lời phải nằm trong
`appointments WHERE source='walk_in'`, không phải một dòng `time_off` vô danh.

**`start_at` của walk-in được miễn quy tắc lưới 15 phút** (PRD §11: "trừ
`source='walk_in'`"). Khách đến lúc nào là lúc đó — 14:07, 14:23, bất kỳ phút
nào. Áp lưới 15 phút vào đây sẽ chặn *mọi* walk-in thật, vì khách hiếm khi đến
đúng phút chẵn. Lưới 15 phút tồn tại để giữ lịch *có thể đặt trước* gọn gàng;
walk-in không phải lịch đặt trước — nó đã xảy ra rồi.

Quy trình lễ tân (PRD §7):
1. Chọn variant → hệ thống hiện KTV rảnh *ngay bây giờ*
2. Chọn KTV
3. Định danh khách: số điện thoại có sẵn, hoặc tên+số mới, hoặc "Khách lẻ"
   (ẩn danh — customer row với `phone = NULL`)
4. Tạo appointment, `status='in_service'`, `start_at = now`

KTV bị đánh dấu bận **ngay lập tức** để khách online không giành được cùng
khung giờ ngay sau đó.

## Phạm vi
**Trong:**
- `GET /api/admin/available-now?variant_id` — ai rảnh ngay bây giờ (không
  phải rảnh trong cả ngày, chỉ tại thời điểm `now`)
- `POST /api/admin/walk-ins` — tạo appointment
  `source='walk_in'`, `status='in_service'`, `start_at=now`, `staff_id` do lễ
  tân chọn
- Khách ẩn danh → tạo/dùng customer với `phone = NULL`, tên "Khách lẻ" (hoặc
  tên lễ tân nhập nếu có)
- Validate: KTV có skill của service, KTV không đang bận tại `now` (re-check
  trong transaction giống T-04, không lười bỏ qua chỉ vì đã có
  `available-now`)

**Ngoài:**
- Không dùng `time_off` cho bất kỳ mục đích nào ở đây
- Không làm reassign queue (T-07)
- Không làm UI Quick Booking — chỉ API
- Không làm hàng đợi chờ (waitlist) khi không ai rảnh — PRD §13: v1 turn away,
  trả lỗi là đủ

## Đầu vào đã có
- **T-04 để lại** đường ghi transaction + re-check trong
  `src/worker/lib/validate-booking.ts` và `src/worker/db/bookings.ts`.
  Hàm validate của T-04 **đã có sẵn tham số `isWalkIn: boolean`** (mặc định
  `false`); gọi lại chính hàm đó với `isWalkIn: true`. Cờ này bỏ qua đúng hai
  luật — lưới 15 phút và "không ở quá khứ" — mọi luật khác (skill, ca làm,
  chồng giờ) vẫn áp dụng đầy đủ.
- T-03 để lại `computeAvailability()` — dùng làm nền cho
  `available-now`, thu hẹp về đúng thời điểm `now` thay vì quét cả ngày.
- Bảng `customers` đã có `phone` nullable (PRD §3.2, CONVENTIONS §4) — dùng
  đúng cột này cho khách ẩn danh, không tạo cột mới.

## Việc phải làm
1. **`routes/admin-walkin.ts`**:
   - `GET /api/admin/available-now?variant_id`:
     - Load variant → skill, `block = duration_min + buffer_after_min`
     - Candidates = active staff có skill đó
     - Loại KTV không có ca tại thời điểm `now` hôm nay (ngoài shift)
     - Loại KTV có `time_off` hoặc `booking_item` (`booked`/`in_service`)
       chồng `[now, now+block)`
     - Trả danh sách staff còn lại
   - `POST /api/admin/walk-ins` — body
     `{ variant_id, staff_id, customer?: {name?, phone?} }`:
     - Không có `customer.phone` → tạo customer `phone=NULL`, tên mặc định
       "Khách lẻ" nếu `customer.name` cũng trống
     - Có `phone` → tìm hoặc tạo customer như T-04 đã làm cho booking online
     - Mở transaction: re-check KTV còn rảnh tại `now` (skill + shift +
       time_off + overlap booking khác) → không rảnh: 409 `SLOT_TAKEN`
     - Insert `appointment` (`source='walk_in'`), insert `booking_item`
       (`status='in_service'`, `start_at=now`, `end_at=now+duration`,
       `block_end_at=now+duration+buffer`)
     - Trả 201 `{ appointment, item, staff, customer }`
   - Cả hai endpoint **không áp dụng kiểm tra lưới 15 phút** cho `start_at`.
2. Đăng ký cả hai route bằng cách thêm một dòng vào `registerRoutes()` trong `src/worker/routes/index.ts` (CONVENTIONS §7 — không sửa `src/worker/index.ts`).

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §1, §2, §3, §4, §5, §6 (đọc kỹ ngoại lệ walk-in
trong §6: "trừ `source='walk_in'`"), §7, §8.

Nhấn lại:
- `block_end_at` dùng cho kiểm tra rảnh/bận; ghi cả `end_at` lẫn
  `block_end_at` như T-04 đã làm.
- Không xoá dòng bao giờ.
- `customers.phone` nullable — đây chính là task dùng đến nó.
- Mã lỗi chỉ lấy trong danh sách đã chốt: `SLOT_TAKEN`, `STAFF_LACKS_SKILL`,
  `VALIDATION`, `NOT_FOUND`. Cần mã mới → dừng, báo.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test -- tests/api/walkin.test.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/api/walkin.test.ts`
- `tạo walk-in với start_at lệch lưới 15 phút vẫn thành công (case quan trọng
  nhất — không bị chặn bởi quy tắc lưới)`
- `walk-in tạo ra appointment có source='walk_in' và status='in_service'`
- `booking_item của walk-in có start_at đúng bằng thời điểm now lúc tạo`
- `sau khi tạo walk-in, KTV đó không còn xuất hiện trong available-now nữa`
- `walk-in chiếm chỗ KTV ngay nên khách online không đặt được cùng khung giờ
  đó qua POST /api/bookings (trả 409 SLOT_TAKEN)`
- `khách ẩn danh không truyền tên/phone tạo customer với phone NULL và tên
  mặc định Khách lẻ`
- `khách vãng lai truyền số điện thoại đã có thì tái sử dụng customer cũ`
- `available-now loại KTV đang bận bởi booking khác tại thời điểm hiện tại`
- `available-now loại KTV không có skill của variant được hỏi`
- `available-now loại KTV inactive`
- `available-now loại KTV ngoài ca làm việc tại thời điểm now`
- `tạo walk-in vào đúng KTV mà available-now vừa báo bận trả 409 SLOT_TAKEN`
- `variant_id không tồn tại ở available-now trả 404 NOT_FOUND`

## Định nghĩa "xong"
Gọi `GET /api/admin/available-now?variant_id=<một variant>` tại một thời
điểm lệch lưới 15 phút (ví dụ đang là phút 23), thấy ít nhất một KTV rảnh; gọi
tiếp `POST /api/admin/walk-ins` chọn đúng KTV đó, nhận 201 với
`booking_item.start_at` đúng bằng thời điểm gọi (không bị làm tròn về lưới
15 phút); gọi lại `available-now` ngay sau đó và KTV vừa nhận walk-in không
còn xuất hiện.

## Cạm bẫy đã biết
- **Quy tắc lưới 15 phút sẽ chặn mọi walk-in nếu quên truyền cờ miễn trừ.**
  T-04 đã để sẵn tham số `isWalkIn` trong `src/worker/lib/validate-booking.ts`
  — **gọi lại hàm đó với `isWalkIn: true`**, đừng viết bản validate thứ hai.
  Nếu chữ ký hàm không có tham số này, nghĩa là T-04 chưa làm đúng card của
  nó: dừng lại, đặt `status: blocked`, báo — **không** tự copy-paste một bản
  luật song song, vì hai bản sẽ trôi khỏi nhau và không ai biết bản nào đúng.
- **Đừng dùng `time_off` để chặn chỗ cho walk-in** dưới bất kỳ hình thức nào,
  kể cả "tạm thời" — nó xoá sạch doanh thu/lịch sử/khách hàng mà spa cần theo
  dõi, và không có đường quay lại rẻ.
- Quên re-check trong transaction vì "đã có `available-now` rồi" là lặp lại
  đúng lỗi kinh điển của T-04 — giữa lúc lễ tân xem `available-now` và lúc
  bấm xác nhận, một walk-in khác hoặc một booking online có thể đã chiếm KTV
  đó.

## Đã làm gì
(agent điền khi xong)
