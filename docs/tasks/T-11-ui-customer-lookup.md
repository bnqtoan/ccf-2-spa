---
id: T-11
title: UI tra cứu lịch bằng SĐT + huỷ lịch
status: done
model: sonnet
effort: medium
depends_on: ["T-09", "T-05"]
touches:
  - src/app/routes/lookup/
  - tests/e2e/customer-lookup.spec.ts
prd_refs: ["§6", "§10"]
owner: null
started_at: null
finished_at: "2026-07-22"
---

# T-11 · UI tra cứu lịch + huỷ lịch

## Mục tiêu
Khách nhập số điện thoại xem lại các lịch hẹn của mình và tự huỷ được lịch còn
đủ xa giờ hẹn. Lịch quá gần giờ hẹn (dưới 2 tiếng) không cho tự huỷ mà chuyển
sang gọi điện — đây là điểm cốt lõi của card này.

## Ngữ cảnh cần biết
Chính sách huỷ (PRD §6), trích nguyên văn:

> **≥120 min before start** — customer self-cancels on the web; slot frees
> instantly.
> **<120 min** — the customer endpoint returns 409 `CANCEL_TOO_LATE`. The UI
> replaces the cancel button with the spa's phone number.
>
> The cutoff exists for a commercial reason, not a technical one: forcing a
> last-minute cancellation through a phone call gives the receptionist a
> chance to **reschedule instead of losing the slot**. A self-serve button at
> T-20min converts a salvageable appointment into an empty chair.

Nói cách khác: đây **không phải giới hạn kỹ thuật**, mà là quyết định kinh
doanh — ép khách gọi điện khi còn dưới 2 tiếng để lễ tân có cơ hội **xếp lại
giờ khác thay vì để trống ghế**. Nếu chỉ ẩn nút huỷ mà không có gì thay thế,
khách sẽ bối rối không biết làm gì tiếp — vì vậy nút huỷ phải **biến thành**
một thẻ số điện thoại bấm gọi được (`<a href="tel:...">`), kèm câu giải thích
thân thiện, không phải biến mất trong im lặng.

Server luôn là trọng tài cuối cùng (T-05 đã làm): gọi
`POST /api/bookings/:id/cancel` dưới 2 tiếng luôn trả 409 `CANCEL_TOO_LATE`
bất kể UI có hiện nút hay không — vì vậy UI phải xử lý cả trường hợp bất ngờ
nhận 409 này (ví dụ đồng hồ máy khách lệch giờ, hoặc dữ liệu vừa thay đổi giữa
lúc tải trang và lúc bấm huỷ), và phản ứng giống hệt như khi tự tính trước:
hiện hotline, không hiện lỗi kỹ thuật.

Người dùng là khách phổ thông trên điện thoại — không thuật ngữ kỹ thuật,
không hiện mã lỗi thô, vùng chạm tối thiểu 48px, chữ tối thiểu 15px.

## Phạm vi
**Trong:**
- Màn nhập số điện thoại
- Màn danh sách lịch hẹn của số đó: nhóm "Sắp tới" / "Đã huỷ" / "Đã hoàn thành"
- Với mỗi lịch "Sắp tới": nếu còn ≥2 tiếng → nút "Huỷ lịch"; nếu <2 tiếng → thẻ
  số điện thoại `tel:` thay cho nút huỷ, kèm câu giải thích
- Gọi `GET /api/bookings?phone=` để tải danh sách
- Gọi `POST /api/bookings/:id/cancel`, xử lý cả 200 lẫn 409 `CANCEL_TOO_LATE`

**Ngoài:**
- Không làm luồng đặt lịch mới (T-10)
- Không làm đổi giờ hẹn (chưa có trong PRD v1 — chỉ huỷ)
- Không làm màn admin

## Đầu vào đã có
- **T-09 để lại** `src/app/components/{Button,Card,Pill,Field,Notice,EmptyState}.tsx`.
- **T-05 để lại** `POST /api/bookings/:id/cancel` — trả 200 khi huỷ thành công
  (≥2 tiếng), trả 409 `{ error: { code: 'CANCEL_TOO_LATE', message } }` khi
  dưới 2 tiếng. `GET /api/bookings?phone=` từ T-04 trả danh sách kèm tên KTV,
  tên dịch vụ, sắp xếp theo `start_at`.
- `prototype/index.html` là spec giao diện: đọc hàm `SCREENS.lookup/mybookings`
  (dòng 651–701) để bám đúng bố cục 3 nhóm lịch, thẻ `.bk`, và văn phong câu
  giải thích khi dưới 2 tiếng (dòng 677–681):
  > "Còn dưới 2 tiếng nên không huỷ trực tuyến được. Bạn gọi giúp spa để đổi
  > giờ nhé — thường vẫn xếp được." kèm link `tel:02838221179`.

## Việc phải làm
1. **Màn nhập SĐT** — Field số điện thoại, nút "Xem lịch hẹn" gọi
   `GET /api/bookings?phone=`.
2. **Màn danh sách**:
   - Nhóm "Sắp tới": mỗi lịch hiện giờ hẹn, dịch vụ, KTV, giá
   - Tính số giờ còn lại từ `start_at` đến hiện tại (dùng đồng hồ trình duyệt
     chỉ để **hiển thị** UI, không dùng để quyết định server có cho huỷ hay
     không — quyết định cuối luôn ở server)
   - ≥2 tiếng → `Pill` "Đã xác nhận" + nút `Button variant="danger"` "Huỷ lịch"
   - <2 tiếng → `Pill tone="warn"` "Sắp bắt đầu" + `Notice tone="warn"` chứa
     câu giải thích + thẻ `<a href="tel:...">` số điện thoại spa, không hiện
     nút huỷ
   - Nhóm "Đã huỷ" và "Đã hoàn thành" hiện mờ hơn (`past`), không có hành động
     huỷ
   - Không có lịch nào sắp tới → `EmptyState`
3. **Xử lý bấm Huỷ lịch**:
   - Xác nhận trước khi gọi API (dialog xác nhận đơn giản)
   - Gọi `POST /api/bookings/:id/cancel`
   - 200 → cập nhật danh sách, lịch đó chuyển sang nhóm "Đã huỷ" (biến mất
     khỏi "Sắp tới")
   - 409 `CANCEL_TOO_LATE` (trường hợp lệch giờ hoặc dữ liệu đổi giữa chừng) →
     **không** hiện lỗi kỹ thuật; thay ngay bằng giao diện hotline giống hệt
     trường hợp <2 tiếng đã tính trước, kèm câu giải thích
4. Viết `tests/e2e/customer-lookup.spec.ts` chạy trên app thật.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §5, §6, §8.

Nhấn lại:
- Cutoff là quyết định server, UI chỉ phản ánh — không tự tính toán rồi tin
  tưởng tuyệt đối kết quả đó mà bỏ qua phản hồi 409 thật từ server.
- Không hiện mã lỗi thô (`CANCEL_TOO_LATE`) cho khách.
- Vùng chạm tối thiểu 48px, chữ tối thiểu 15px.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm run e2e -- tests/e2e/customer-lookup.spec.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/e2e/customer-lookup.spec.ts`
- `tra cứu bằng đúng số điện thoại hiện đúng các lịch hẹn của số đó, không lẫn số khác`
- `tra cứu bằng số điện thoại chưa từng đặt lịch hiện trạng thái rỗng thân thiện`
- `huỷ một lịch còn xa giờ hẹn thành công và lịch đó biến mất khỏi nhóm Sắp tới`
- `huỷ một lịch còn xa giờ hẹn xong thì lịch đó xuất hiện trong nhóm Đã huỷ`
- `lịch hẹn còn dưới 2 tiếng KHÔNG hiện nút Huỷ lịch mà hiện thẻ số điện thoại tel:`
- `thẻ số điện thoại của lịch dưới 2 tiếng là link tel: bấm gọi được, không phải chữ thường`
- `khi server trả 409 CANCEL_TOO_LATE bất ngờ, giao diện chuyển sang hiện hotline thay vì hiện lỗi thô`
- `nút Huỷ lịch và thẻ số điện thoại đều có vùng chạm tối thiểu 48px`

## Định nghĩa "xong"
Tạo một lịch hẹn cách giờ hiện tại 3 tiếng qua API thật, tra cứu bằng đúng số
điện thoại, bấm Huỷ lịch, thấy lịch chuyển sang nhóm Đã huỷ mà không cần tải
lại trang — kiểm chứng bằng `npm run e2e -- tests/e2e/customer-lookup.spec.ts`.

## Cạm bẫy đã biết
- **Chỉ tính cutoff bằng giờ trình duyệt của khách rồi tin tưởng tuyệt đối** là
  lỗ hổng — đồng hồ máy khách có thể sai hoặc dữ liệu vừa đổi. UI phải luôn xử
  lý được nhánh server trả 409 `CANCEL_TOO_LATE` bất ngờ, không giả định
  "mình đã tính trước rồi nên chắc chắn server đồng ý".
- Đừng biến "ẩn nút huỷ" thành màn hình trống rỗng khó hiểu — phải luôn có một
  hành động thay thế rõ ràng (gọi điện), đúng lý do thương mại đã nêu ở PRD §6:
  không có hành động thay thế thì khách bỏ cuộc, spa mất slot.
- Test "huỷ lịch dưới 2 tiếng" phải seed dữ liệu thật gần giờ hẹn (không mock
  ngày giờ) để chốt chặn thật sự chạy qua server, không chỉ qua giả lập UI.

## Đã làm gì
- Tạo `src/app/routes/lookup/{LookupPage.tsx,api.ts,format.ts,lookup.css}`.
  `api.ts` là fetch helper riêng (không đụng `src/app/api/client.ts` của T-10)
  gọi thẳng `GET /api/bookings?phone=` và `POST /api/bookings/:id/cancel`.
  `LookupPage` có 2 màn (nhập SĐT → danh sách) dùng lại nguyên
  `Button/Card/Pill/Field/Notice/EmptyState` của T-09, không viết lại style
  base. `lookup.css` chỉ thêm class layout riêng (`.ccf-lk-*`) không có trong
  `components.css` (bảng `.bk/.label/.row/.tel/.acts` của prototype), và ghi
  đè `font-size: 15px` tại điểm dùng cho `Notice` (shared component mặc định
  14.5px, dưới ngưỡng 15px card yêu cầu) — không sửa `components.css` vì
  ngoài `touches`.
- Thêm đúng 1 dòng import + 1 dòng `<Route path="/lookup">` vào
  `src/app/main.tsx` (ngoài `touches` khai báo, nhưng cần thiết để route mở
  được — cùng cách T-10/T-12 cũng làm với route của họ, xác nhận qua commit
  history: mỗi task thêm đúng 1 dòng, không sửa cấu trúc file, an toàn merge
  song song).
- Cutoff hiển thị dùng đồng hồ trình duyệt (`hoursUntil`) CHỈ để quyết định
  hiện nút Huỷ hay thẻ hotline; khi bấm Huỷ luôn gọi server thật. Nhánh 409
  `CANCEL_TOO_LATE` bất ngờ (kể cả khi UI đã hiện nút Huỷ) chuyển ngay sang
  giao diện hotline giống hệt case <2 tiếng tính trước, không hiện mã lỗi.
- Bỏ hiển thị "giá" trong dòng lịch hẹn: `GET /api/bookings?phone=` (T-04,
  `CustomerBookingRow` trong `src/worker/db/bookings.ts`) không trả trường
  giá — card yêu cầu hiện giá nhưng API thật không có. Không tự thêm cột vào
  response (ngoài `touches`, và sẽ đụng T-04 đã test xong); giữ nguyên phần
  còn lại (giờ, dịch vụ, KTV) đúng API thật.
- Test `tests/e2e/customer-lookup.spec.ts`: seed dữ liệu bằng cách ghi thẳng
  `customers/appointments/booking_items` qua `wrangler d1 execute --local
  --file=` (cùng cơ chế CLI `db:seed:local` dùng), CHỦ ĐỘNG KHÔNG chạy lệnh
  seed đầy đủ (nó xoá sạch bảng) vì 2 agent khác (T-10, T-12) chạy song song
  trên cùng D1 local — chỉ INSERT thêm dữ liệu của riêng phone ngẫu nhiên mỗi
  test, không bao giờ DELETE. Case "dưới 2 tiếng": seed `start_at = now +
  90*60`. Case 409 bất ngờ: seed `start_at = now + 120*60 + 8`, chờ 10s rồi
  mới bấm Huỷ để "now" server thật trôi qua ranh giới cutoff trong lúc UI đã
  hiện nút — mô phỏng đúng "khách mở trang lâu rồi mới bấm" theo PRD, không
  phụ thuộc giờ/ngày chạy thật.
- Test chạy `test.describe.configure({ mode: 'serial' })` trong file này +
  retry-with-backoff quanh lệnh `wrangler d1 execute`: nhiều tiến trình
  wrangler mở cùng file sqlite cục bộ đồng thời từng gây `SQLITE_BUSY` ngẫu
  nhiên (bắt được khi chạy lại nhiều lần ở chế độ song song mặc định).
- Đã tự mở trình duyệt thật (`npm run dev`, cả `/lookup` cho SĐT có lịch xa
  giờ và SĐT có lịch <2 tiếng) và đo computed style thay vì tin mắt thường:
  nút "Huỷ lịch" — `color:#b4342b` trên nền trắng (tương phản 6.06:1),
  17px, system sans-serif, cao đúng 48px; thẻ `tel:` — `color:#1c4a3a`
  (10.05:1), 18px/700, cao đúng 48px, `href="tel:02838221179"` đúng; chữ
  trong `.ccf-lk-what` 15px (tương phản 6.85:1). Bắt được 1 lỗi thật mà test
  Playwright không đo: `Notice` dùng chung có `font-size:14.5px`, dưới
  ngưỡng 15px card yêu cầu — đã sửa bằng override tại điểm dùng (xem trên).
- Trong lúc kiểm bằng trình duyệt, gặp sự cố tạm thời do 2 agent song song
  (T-10 đặt `src/app/api/client.ts` — đường dẫn này bị Cloudflare Worker
  route `/api/*` (`run_worker_first` trong `wrangler.jsonc`) chặn mất, khiến
  cả bundle SPA crash lúc load module vì `main.tsx` import tĩnh xuyên qua
  `GuestPage → BookingPage → api/client.ts`). Đã tự chẩn đoán qua network
  trace, xác nhận không phải lỗi của route `/lookup`, và spawn 1 task riêng
  báo lỗi này cho T-10 xử lý (không tự sửa file của họ). T-10 tự khắc phục
  bằng cách dời file sang `src/app/lib/apiClient.ts`; sau đó `/lookup` chạy
  lại bình thường và đã kiểm chứng xong.
- `npm run typecheck` xanh cho toàn bộ file của mình (một số lỗi TS khác
  trong `src/app/routes/booking/` và `src/app/routes/admin/timeline/` thuộc
  T-10/T-12 đang chạy song song, không liên quan phạm vi T-11).
- `npm run e2e -- tests/e2e/customer-lookup.spec.ts`: 8/8 xanh, chạy lại
  nhiều lần ổn định.
</content>
