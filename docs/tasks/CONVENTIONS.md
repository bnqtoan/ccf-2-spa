# Quy ước kỹ thuật — ccf-2-spa

Mọi task card tham chiếu file này. Agent **không được tự chế lại** những quy ước
dưới đây. Nếu thấy quy ước sai, dừng lại và báo, đừng tự đổi.

Nguồn sự thật về nghiệp vụ: `docs/PRD.md`.

## 1. Thời gian

- DB lưu **UTC epoch seconds (INTEGER)**. Không lưu chuỗi ISO, không lưu local time.
- Timezone của spa là hằng số app-level: `SPA_TZ = 'Asia/Ho_Chi_Minh'`.
- Quy đổi timezone **chỉ xảy ra ở biên API** (parse request / format response).
  Không bao giờ trong SQL.
- `work_shifts.start_min/end_min` là **phút tính từ nửa đêm giờ địa phương**
  (0–1440), không phải epoch.

## 2. Chiếm chỗ kỹ thuật viên — quy tắc lõi

```
block_end_at = start_at + variant.duration_min + variant.buffer_after_min
```

- Mọi kiểm tra rảnh/bận dùng khoảng nửa mở `[start_at, block_end_at)`.
- **Không truy vấn nào được dùng `end_at` để kiểm tra rảnh/bận.** `end_at` chỉ
  để hiển thị cho khách.
- Hai khoảng `[a1,b1)` và `[a2,b2)` chồng nhau khi `a1 < b2 && a2 < b1`.
  Kề nhau (`b1 == a2`) là **không** chồng — hợp lệ.

## 3. Trạng thái

`booked → in_service → done`; `cancelled` và `no_show` là lối ra terminal từ `booked`.

- Availability chỉ đếm `status IN ('booked','in_service')`.
- **Không xoá dòng.** Huỷ = `status='cancelled'` + stamp `cancelled_at`.
- `no_show` là dữ liệu tín nhiệm/báo cáo, **không phải cơ chế thu hồi slot**.
  Không xây recovery logic lên transition này.
- Chuyển trạng thái sai (huỷ cái đã huỷ...) → `INVALID_TRANSITION`.

## 4. Schema

- **Không thêm cột `room_id` hay `branch_id`.** PRD §1 đã quyết định: cột null
  không ai đọc là nợ chết. Đường migration cho v2 nằm ở PRD §12.
- `appointments` / `booking_items` tách đôi kể cả khi v1 chỉ tạo appointment
  một item.
- `customers.phone` **nullable** — khách lẻ vãng lai chỉ có tên.

## 5. API

- Lỗi trả `{ error: { code, message } }`.
- Mã lỗi hợp lệ (PRD §9): `SLOT_TAKEN`, `CANCEL_TOO_LATE`, `STAFF_LACKS_SKILL`,
  `OUTSIDE_SHIFT`, `ZONE_CONFLICT`, `INVALID_TRANSITION`, `NOT_FOUND`,
  `VALIDATION`. Không tự nghĩ mã mới; cần mã mới thì báo.
- HTTP: 201 tạo mới, 409 xung đột (`SLOT_TAKEN`, `CANCEL_TOO_LATE`),
  422 `VALIDATION`, 404 `NOT_FOUND`.

## 6. Validation (PRD §11)

- `start_at` phải rơi đúng lưới 15 phút — **trừ `source='walk_in'`**.
- KTV được gán phải có skill của service.
- Toàn bộ `[start_at, block_end_at)` phải nằm gọn trong một ca làm việc.
- Không chồng `time_off` hay item `booked`/`in_service` khác của KTV đó.
- Trong một appointment, các item chồng giờ phải khác `body_zone`.
- Không đặt trong quá khứ (walk-in bắt đầu ở `now`, không tính là quá khứ).
- Khách huỷ dưới `CANCEL_CUTOFF_MIN = 120` phút → `CANCEL_TOO_LATE`. Admin miễn.

## 7. Cấu trúc thư mục

```
src/worker/        Hono app, routes, D1 queries
src/worker/lib/    logic thuần (availability, validation) — không import D1
src/app/           React SPA (Vite)
migrations/        D1 SQL migrations, đánh số tăng dần
tests/api/         Vitest chạy trong workerd + D1 thật
tests/e2e/         Playwright
```

Logic nghiệp vụ đặt trong `src/worker/lib/` dưới dạng **hàm thuần nhận dữ liệu
đã load sẵn**, không tự query. Như vậy test được không cần DB, và tầng route chỉ
lo load + gọi.

## 8. Test

- `tests/api/` dùng `@cloudflare/vitest-pool-workers` — D1 thật trong workerd,
  không mock.
- Mỗi test tự seed dữ liệu nó cần, không phụ thuộc thứ tự chạy.
- Test khẳng định **hành vi nghiệp vụ**, không khẳng định dòng code.
  Tên test viết như câu tiếng Việt mô tả tình huống.

## 9. Quy tắc cho agent

- Card là nguồn sự thật cho phạm vi. Không mở rộng.
- Chỉ đụng file khai báo trong `touches`. Cần thêm file → báo trước.
- Không tự đặt `status: done` — cao nhất là `review`.
- Test đỏ mà không sửa được → đặt `status: blocked`, ghi rõ lý do, dừng lại.
  Không xoá test, không nới assertion cho xanh.
