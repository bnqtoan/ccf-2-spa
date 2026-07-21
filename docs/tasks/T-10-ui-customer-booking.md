---
id: T-10
title: UI khách đặt lịch — dịch vụ → gói → giờ → xác nhận
status: todo
model: sonnet
effort: high
depends_on: ["T-09", "T-04"]
touches:
  - src/app/routes/booking/
  - src/app/api/client.ts
  - tests/e2e/customer-booking.spec.ts
prd_refs: ["§10", "§4"]
owner: null
started_at: null
finished_at: null
---

# T-10 · UI khách đặt lịch

## Mục tiêu
Khách tự đặt được một lịch hẹn thật từ điện thoại: chọn dịch vụ → chọn gói →
chọn ngày giờ → (tuỳ chọn) chọn KTV → nhập tên/SĐT → xác nhận → thấy màn thành
công. Đây là luồng doanh thu chính của toàn hệ thống.

## Ngữ cảnh cần biết
Người dùng màn hình này là **khách phổ thông, không rành công nghệ, chủ yếu
dùng điện thoại**. Không thuật ngữ kỹ thuật, không hiện mã lỗi thô (không bao
giờ hiện `SLOT_TAKEN` hay `422` lên màn hình khách). Vùng chạm tối thiểu 48px,
chữ tối thiểu 15px — dùng component T-09 để không phải tự nghĩ lại việc này.

Luồng đã chốt (PRD §10):
> Customer: service list → variant → date picker → slot grid (times, with
> optional "choose technician") → name + phone → confirm.

Auto-assign mặc định (PRD §4): khách không bắt buộc chọn KTV, có lựa chọn "Để
spa sắp xếp" luôn đứng đầu danh sách kỹ thuật viên của một khung giờ.

Race condition thật, không phải giả thuyết (PRD §5):
> Kết quả availability mà client cầm chỉ là tham khảo... Hai khách tranh slot
> cuối → một người 201, một người 409, UI làm mới danh sách.

Khi `POST /api/bookings` trả 409 `SLOT_TAKEN`, nghĩa là **có người khác vừa
đặt mất chỗ đó trong lúc khách đang gõ tên/SĐT** — chuyện bình thường, không
phải lỗi hệ thống. UI phải: làm mới lại danh sách slot (gọi lại
`GET /api/availability`), quay khách về bước chọn giờ, và báo bằng câu tiếng
Việt nhẹ nhàng kiểu "Giờ này vừa có người đặt mất rồi, bạn chọn giờ khác giúp
mình nhé" — không hiện "SLOT_TAKEN", không hiện mã lỗi, không hiện "Error 409".

## Phạm vi
**Trong:**
- Màn danh sách dịch vụ (gọi `GET /api/services`, đã kèm variants lồng sẵn)
- Màn chọn gói (variant) của dịch vụ đã chọn
- Màn chọn ngày (cuộn ngang) + chọn giờ (lưới slot theo buổi sáng/chiều/tối,
  gọi `GET /api/availability?variant_id&date`)
- Chọn KTV cụ thể trong slot đã chọn (gọi lại `GET /api/availability` kèm
  `staff_id` nếu cần lọc, hoặc lọc phía client từ `staff_ids[]` slot đã trả —
  chọn cách nào đơn giản hơn với API thật đã có)
- Màn xác nhận: tóm tắt dịch vụ/gói/giờ/KTV/tổng tiền, form tên + SĐT, nút xác
  nhận gọi `POST /api/bookings`
- Xử lý 409 `SLOT_TAKEN` — làm mới slot, quay lại bước chọn giờ, thông báo thân
  thiện
- Màn thành công sau 201

**Ngoài:**
- Không làm tra cứu/huỷ lịch (T-11)
- Không làm màn admin nào
- Không thêm bước thanh toán online (PRD: thanh toán tại spa)
- Không làm chọn nhiều dịch vụ trong một lần đặt (combo là v2, PRD §1)

## Đầu vào đã có
- **T-09 để lại** `src/app/components/{Button,Card,Pill,Field,Notice,EmptyState}.tsx`
  và `src/app/styles/tokens.css` — dùng lại toàn bộ, không tự vẽ nút/thẻ mới.
- **T-04 để lại** các endpoint đã chạy thật: `GET /api/services`,
  `POST /api/bookings` (trả 201 `{ appointment, item, staff }` hoặc 409
  `{ error: { code: 'SLOT_TAKEN', message } }`). Endpoint `GET /api/availability`
  do T-03 định nghĩa dạng trả về (PRD §4): `[{ start_at, staff_ids[] }]`.
- `prototype/index.html` là **spec giao diện** cho luồng này — đọc hàm
  `SCREENS.home/variant/time/confirm/done` (dòng 519–649) để bám đúng bố cục,
  thứ tự bước, và văn phong tiếng Việt (ví dụ: "Bạn muốn làm gì hôm nay?",
  "Nghỉ X phút dọn dẹp sau đó", "Để spa sắp xếp — Chọn bạn đang rảnh và phù hợp
  nhất"). Copy giữ nguyên giọng văn, không viết lại.

## Việc phải làm
1. **`src/app/api/client.ts`** — hàm gọi API: `getServices()`,
   `getAvailability(variantId, date, staffId?)`, `createBooking(payload)`. Map
   response lỗi `{ error: { code, message } }` thành dạng UI dùng được (không
   để nguyên object lỗi hiện thẳng ra màn hình).
2. **Route danh sách dịch vụ** (`src/app/routes/booking/ServiceList.tsx` hoặc
   tương đương) — Card cho mỗi service, giá "từ X₫" lấy giá thấp nhất trong
   các variant.
3. **Route chọn gói** — Card cho mỗi variant, hiện thời lượng + "Nghỉ N phút
   dọn dẹp sau đó" + giá. Nút "Tiếp tục" khoá (`disabled`) tới khi chọn gói.
4. **Route chọn ngày + giờ**:
   - Dải ngày cuộn ngang (theo prototype: 14 ngày tới, "Hôm nay" cho ngày đầu)
   - Gọi `GET /api/availability` mỗi khi đổi ngày
   - Ngày kín lịch (mảng slot rỗng) hiện `EmptyState` — không phải lưới trống
     im lặng
   - Chọn slot xong mới hiện danh sách KTV của đúng slot đó, "Để spa sắp xếp"
     luôn ở đầu
   - Chọn một KTV cụ thể → chỉ còn slot của người đó được coi là hợp lệ cho
     bước xác nhận (nếu người dùng đổi KTV, cần phản ánh đúng trong state,
     không giữ slot cũ của người khác)
   - Nút "Tiếp tục" khoá tới khi có đủ ngày + giờ
5. **Route xác nhận** — summary card (dịch vụ, gói, ngày giờ, KTV, tổng tiền),
   Field cho tên và SĐT, Notice info nhắc "Thanh toán tại spa. Huỷ miễn phí đến
   trước giờ hẹn 2 tiếng." Nút xác nhận khoá tới khi tên > 1 ký tự và SĐT hợp
   lệ (≥9 chữ số sau khi bỏ ký tự không phải số).
6. **Xử lý submit**:
   - Gọi `POST /api/bookings`
   - 201 → chuyển màn thành công, hiện mã đặt lịch nếu API trả về
   - 409 `SLOT_TAKEN` → gọi lại `GET /api/availability`, đưa khách về bước
     chọn giờ với danh sách slot mới, hiện `Notice` tông ấm áp giải thích nhẹ
     nhàng, **không** hiện mã lỗi
   - Lỗi khác (422, 404, 5xx) → hiện thông báo chung chung dễ hiểu, không lộ
     chi tiết kỹ thuật, gợi ý khách thử lại hoặc gọi hotline
7. **Màn thành công** — theo prototype `done()` (dòng 630–649): dấu tích, lời
   chào, tóm tắt, nút "Về trang chủ".
8. Viết `tests/e2e/customer-booking.spec.ts` chạy trên app thật (Worker + D1
   thật theo hạ tầng T-01), không mock API.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §5 (API — mã lỗi cố định, không tự chế), §8 (test
khẳng định hành vi nghiệp vụ).

Nhấn lại:
- Không bao giờ hiện mã lỗi thô (`SLOT_TAKEN`, `VALIDATION`, mã HTTP) trực tiếp
  cho khách — luôn dịch sang câu tiếng Việt tự nhiên.
- Vùng chạm tối thiểu 48px, chữ tối thiểu 15px cho mọi nội dung khách đọc/bấm.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm run e2e -- tests/e2e/customer-booking.spec.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/e2e/customer-booking.spec.ts`
- `đi hết luồng chọn dịch vụ, gói, ngày, giờ, nhập tên SĐT và xác nhận thì tạo được lịch thật (201) và thấy màn thành công`
- `nút Tiếp tục ở màn chọn gói bị khoá khi chưa chọn gói nào`
- `nút Tiếp tục ở màn chọn giờ bị khoá khi chưa chọn đủ ngày và giờ`
- `nút Xác nhận đặt lịch bị khoá khi chưa nhập tên hoặc SĐT hợp lệ`
- `chọn một ngày đã kín lịch hiện trạng thái rỗng thân thiện, không phải lưới trống im lặng`
- `chọn một KTV cụ thể thì chỉ còn slot của người đó được dùng cho bước xác nhận`
- `chọn "Để spa sắp xếp" thì không cần chọn KTV cụ thể vẫn đặt được`
- `khi server trả 409 SLOT_TAKEN, danh sách slot được gọi lại và khách quay về bước chọn giờ`
- `khi gặp 409 SLOT_TAKEN, màn hình không hiện mã lỗi kỹ thuật mà hiện câu tiếng Việt dễ hiểu`
- `mọi nút chính trên các màn hình đều có vùng chạm cao tối thiểu 48px`

## Định nghĩa "xong"
Chạy `npm run e2e -- tests/e2e/customer-booking.spec.ts` trên app thật (Worker
+ D1 thật), đi hết luồng và thấy đúng một booking mới xuất hiện qua
`GET /api/bookings?phone=` với số điện thoại vừa nhập.

## Cạm bẫy đã biết
- Đừng dựa vào availability đã cache lúc mới vào màn chọn giờ để quyết định
  bước xác nhận có hợp lệ hay không — luôn để server là trọng tài (T-04 đã tự
  re-check trong transaction), UI chỉ cần **xử lý đúng** khi server nói không
  còn chỗ.
- Test "đi hết luồng tạo được lịch thật" phải gọi API thật kiểm tra dữ liệu đã
  ghi, không chỉ kiểm tra UI hiện chữ "thành công" — hiện chữ mà không có dữ
  liệu là bug im lặng dễ bỏ sót.
- Copy tiếng Việt khi báo 409 dễ bị viết theo giọng lập trình viên ("đã có
  xung đột", "vui lòng thử lại sau") — phải là câu khách bình thường nói được,
  theo đúng tinh thần văn phong prototype.

## Đã làm gì
(agent điền khi xong)
</content>
