---
id: T-05
title: Huỷ lịch + chuyển trạng thái booking (cutoff 2h)
status: todo
model: sonnet
effort: medium
depends_on: ["T-04"]
touches:
  - src/worker/lib/status.ts
  - src/worker/routes/cancel.ts
  - src/worker/routes/admin-status.ts
  - src/worker/index.ts
  - tests/api/cancel-status.test.ts
prd_refs: ["§6", "§3.3", "§11"]
owner: null
started_at: null
finished_at: null
---

# T-05 · Huỷ lịch + chuyển trạng thái booking

## Mục tiêu
Cho khách tự huỷ lịch của mình khi còn đủ xa giờ hẹn, cho lễ tân huỷ hoặc
chuyển trạng thái bất kỳ lúc nào, và đảm bảo slot huỷ **rảnh lại ngay lập tức**
cho người khác đặt.

## Ngữ cảnh cần biết
Cutoff (PRD §6): `CANCEL_CUTOFF_MIN = 120`, hằng số app-level.

- **≥120 phút trước giờ hẹn** — khách tự huỷ trên web, slot rảnh ngay.
- **<120 phút** — endpoint của khách trả 409 `CANCEL_TOO_LATE`. UI thay nút huỷ
  bằng số điện thoại spa.
- **Admin huỷ bất kỳ lúc nào, không cutoff.** Lễ tân được tin tưởng.

Cutoff tồn tại vì lý do **thương mại, không phải kỹ thuật**: ép khách gọi điện
khi còn dưới 2 tiếng cho lễ tân cơ hội **đổi lịch thay vì mất trắng slot**. Một
nút tự huỷ ở phút T-20 biến một cuộc hẹn còn cứu được thành một cái ghế trống.
**Phải chặn ở server** — ẩn nút trên UI không phải là chính sách, chỉ là gợi ý
thẩm mỹ; ai gọi thẳng API vẫn phải bị 409 nếu trong cutoff.

So sánh cutoff dùng **thời điểm hiện tại của server** (`Date.now()` phía
worker), không bao giờ tin thời gian client gửi lên — client có thể chỉnh giờ
máy để né cutoff.

Trạng thái (PRD §3.3): `booked → in_service → done`, với `cancelled` và
`no_show` là lối ra terminal **chỉ từ `booked`**. Bảng tổng hợp:

| Status | Chiếm chỗ KTV? | Ý nghĩa |
|---|---|---|
| `booked` | có | Đã đặt, chưa bắt đầu |
| `in_service` | có | Khách đang được phục vụ |
| `cancelled` | không | Huỷ bởi khách hoặc lễ tân |
| `no_show` | không | Khách không đến |
| `done` | không | Hoàn tất |

Không xoá dòng bao giờ — huỷ = set `status='cancelled'` + stamp
`cancelled_at`. Chuyển trạng thái sai (huỷ cái đã huỷ, done→in_service...) trả
`INVALID_TRANSITION`.

`no_show` là **dữ liệu tín nhiệm số điện thoại / báo cáo, không phải cơ chế
thu hồi slot**. Lễ tân đánh dấu no_show 15–20 phút sau giờ hẹn — lúc đó slot đã
cháy, không ai rebook được nữa. Đừng xây logic "mở lại slot" khi chuyển sang
no_show; nó không tồn tại và không nên tồn tại.

## Phạm vi
**Trong:**
- `POST /api/bookings/:id/cancel` — khách tự huỷ, có cutoff 2h
- `POST /api/admin/bookings/:id/status` — admin chuyển `in_service | done |
  no_show`, tuân theo bảng chuyển trạng thái ở trên
- `POST /api/admin/bookings/:id/cancel` — admin huỷ, miễn cutoff
- Validate transition hợp lệ theo `booked → in_service → done` +
  `cancelled`/`no_show` chỉ từ `booked`

**Ngoài:**
- Không làm reassign queue (T-07)
- Không làm walk-in (T-08)
- Không làm UI — chỉ API
- Không làm huỷ hàng loạt / huỷ theo appointment nhiều item (v1 chỉ có 1 item)

## Đầu vào đã có
- **T-04 để lại** route `POST /api/bookings`, bảng `appointments` +
  `booking_items` đã có dữ liệu thật để test dựa vào, và cấu trúc
  `src/worker/routes/*.ts` + `src/worker/index.ts` để đăng ký route mới.
- `src/worker/lib/` là nơi đặt logic thuần không import D1 (CONVENTIONS §7) —
  hàm kiểm tra transition và cutoff thuộc `status.ts`, nhận dữ liệu đã load
  sẵn (status hiện tại, `start_at`, `now`, có phải admin hay không), không tự
  query.
- T-03 để lại `computeAvailability()` — dùng để test rằng huỷ xong slot có lại
  ngay (availability luôn tính live từ `booking_items`, PRD §5).

## Việc phải làm
1. **`lib/status.ts`** — hàm thuần:
   - `canTransition(from, to)` → đúng bảng `booked→in_service→done`,
     `cancelled`/`no_show` chỉ từ `booked`; sai → `false`
   - `canCustomerCancel(startAt, now)` → `now <= startAt - CANCEL_CUTOFF_MIN * 60`
     (đơn vị giây, epoch); hằng số `CANCEL_CUTOFF_MIN = 120` khai báo ở đây
2. **`routes/cancel.ts`** — `POST /api/bookings/:id/cancel`:
   - Load booking_item theo id; không có → 404 `NOT_FOUND`
   - Status hiện tại khác `booked` → 409 `INVALID_TRANSITION`
   - `canCustomerCancel(start_at, now_từ_server)` false → 409 `CANCEL_TOO_LATE`
   - Ngược lại: set `status='cancelled'`, stamp `cancelled_at`, trả 200
3. **`routes/admin-status.ts`** — gộp 2 endpoint admin:
   - `POST /api/admin/bookings/:id/status` với body `{ status }` ∈
     `in_service|done|no_show`; validate bằng `canTransition`; sai → 409
     `INVALID_TRANSITION`
   - `POST /api/admin/bookings/:id/cancel` — set `cancelled` bất kể `now`,
     nhưng vẫn phải đang ở `booked` (huỷ cái đã huỷ/đã done vẫn là
     `INVALID_TRANSITION`)
4. Đăng ký cả ba route trong `src/worker/index.ts`.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §1, §3, §5, §6, §7, §8.

Nhấn lại:
- Không xoá dòng bao giờ.
- Mã lỗi chỉ lấy trong danh sách đã chốt: `INVALID_TRANSITION`,
  `CANCEL_TOO_LATE`, `NOT_FOUND`, `VALIDATION`. Cần mã mới → dừng, báo.
- Logic transition/cutoff đặt trong `lib/`, nhận dữ liệu đã load, không tự
  query D1.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test -- tests/api/cancel-status.test.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/api/cancel-status.test.ts`
- `huỷ trước 2 tiếng thành công, status chuyển cancelled và có cancelled_at`
- `huỷ trước 2 tiếng xong, slot đó mở lại book được ngay (gọi lại availability
  thấy KTV rảnh)`
- `huỷ trong vòng 2 tiếng trả 409 CANCEL_TOO_LATE`
- `huỷ đúng ranh giới 120 phút chẵn vẫn được coi là hợp lệ (kề nhau không phải
  trong cutoff)`
- `admin huỷ trong vòng 2 tiếng vẫn thành công, không bị CANCEL_TOO_LATE`
- `huỷ một booking đã huỷ trả 409 INVALID_TRANSITION`
- `huỷ một booking đã done trả 409 INVALID_TRANSITION`
- `huỷ booking không tồn tại trả 404 NOT_FOUND`
- `admin chuyển booked sang in_service thành công`
- `admin chuyển in_service sang done thành công`
- `admin chuyển done sang in_service trả 409 INVALID_TRANSITION`
- `admin chuyển booked thẳng sang done (bỏ qua in_service) trả 409
  INVALID_TRANSITION`
- `admin đánh dấu no_show từ booked thành công và booking đó không xuất hiện
  lại trong availability (đã terminal, không phải vì slot được "mở lại")`
- `admin đánh dấu no_show một booking đang in_service trả 409
  INVALID_TRANSITION (no_show chỉ hợp lệ từ booked)`
- `chuyển status với giá trị không hợp lệ (vd "foo") trả 422 VALIDATION`

## Định nghĩa "xong"
Tạo một booking cách giờ hiện tại 3 tiếng, gọi `POST
/api/bookings/:id/cancel` thành công (200, status=cancelled), rồi gọi lại
`GET /api/availability` cho đúng KTV/khung giờ đó và thấy slot xuất hiện trở
lại ngay lập tức trong cùng một lượt test, không cần thao tác gì thêm.

## Cạm bẫy đã biết
- **Chỉ ẩn nút huỷ trên UI mà không chặn cutoff ở server là lỗ hổng thật.**
  Test phải gọi thẳng API, không qua UI, để chốt chặn này có tác dụng.
- **Quên rằng huỷ phải làm slot rảnh ngay** vì availability luôn tính live từ
  `booking_items` (PRD §5) — không có bảng lịch vật lý nào cần dọn thêm. Nếu
  slot không rảnh lại ngay sau khi huỷ, khả năng cao là route quên chuyển
  status hoặc còn nhánh nào đó vẫn đếm `cancelled` là bận.
- **So cutoff bằng thời gian client gửi lên là lỗi nghiêm trọng** — bỏ qua
  tham số `now` trong body/query nếu có, luôn dùng đồng hồ server
  (`Date.now()` phía worker).
- Đừng xây bất kỳ logic nào coi `no_show` là cơ hội mở lại slot — PRD nói
  thẳng đây là dữ liệu tín nhiệm, slot đã cháy từ trước khi lễ tân bấm nút.

## Đã làm gì
(agent điền khi xong)
