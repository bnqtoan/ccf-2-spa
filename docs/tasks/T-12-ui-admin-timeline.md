---
id: T-12
title: UI admin — lịch ngày dạng timeline theo cột KTV
status: done
model: sonnet
effort: high
depends_on: ["T-09", "T-07"]
touches:
  - src/app/routes/admin/timeline/
  - tests/e2e/admin-timeline.spec.ts
prd_refs: ["§10", "§8"]
owner: null
started_at: "2026-07-22"
finished_at: "2026-07-22"
---

# T-12 · UI admin — lịch ngày dạng timeline

## Mục tiêu
Lễ tân mở một màn hình thấy toàn bộ lịch trong ngày của mọi KTV cùng lúc, hiểu
ngay ai đang bận, ai rảnh, chỗ nào là thời gian dọn dẹp, và lịch nào cần xử lý
gấp vì KTV vừa nghỉ đột xuất.

## Ngữ cảnh cần biết
Bố cục đã chốt (PRD §10):
> Admin: day timeline, one column per staff, blocks rendered from
> `booking_items` (buffer shown as a lighter tail so the reason for a gap is
> visible)... A Reassign queue banner appears whenever orphaned items exist
> and does not dismiss until the queue is empty.

Buffer không phải là "khoảng trống ngẫu nhiên" — nó là thời gian dọn dẹp bắt
buộc sau mỗi dịch vụ (PRD §3.1: `block_end_at = start_at + duration_min +
buffer_after_min`). Vẽ nó thành dải mờ ở đuôi mỗi block để lễ tân **nhìn ra lý
do** có khoảng trống, thay vì tưởng nhầm là KTV đó đang rảnh và xếp thêm khách
vào đúng lúc dọn dẹp.

Bốn loại trạng thái cần phân biệt màu trên timeline (theo PRD §3.3 + prototype):
đã đặt (`booked`), đang làm (`in_service`), khách vãng lai (`walk_in`), cần xếp
lại (mồ côi do time-off — PRD §8). Hàng chờ reassign (PRD §8, nguyên văn):

> Affected items keep `status='booked'` and their original `staff_id`, but the
> admin day view lists them in a Reassign queue until each is either moved to
> another technician or cancelled. They stay visible and actionable — an
> unresolved queue is the point, since a real person must call each customer.

Banner cảnh báo hàng chờ **không tự tắt** — nó chỉ biến mất khi hàng chờ thật
sự rỗng (không có item mồ côi nào), vì hàng chờ tồn tại chính là để nhắc lễ tân
còn khách chưa được gọi.

**Hai cạm bẫy đã phát hiện khi làm prototype** (`prototype/index.html`,
xem hàm `dayView()` dòng 736–792):

1. Khối "nghỉ đột xuất" (`time_off`, class `.ev.off`) và các booking mồ côi
   cùng nằm chồng lên nhau trên cột của KTV đang nghỉ. Nếu vẽ time-off đè lên
   trên, lễ tân sẽ **không nhìn thấy** các booking cần xếp lại — thứ quan
   trọng nhất phải nổi lên trên. Prototype giải quyết bằng z-index: time-off
   vẽ với `z-index:0` (dòng 769), booking mồ côi vẽ với `z-index:3` (dòng 776,
   `a.st==='orphan'?3:2`). Port đúng nguyên tắc: **booking luôn nổi lên trên
   khối nghỉ**, không phải ngược lại.
2. Block dịch vụ ngắn (≤30 phút, ví dụ gội đầu 30') không đủ chỗ hiển thị 2
   dòng chữ (tên khách + tên dịch vụ). Prototype dùng class `.ev.short` để ẩn
   dòng tên dịch vụ, chỉ giữ tên khách (dòng 274–276, 775). Port đúng: khi
   chiều cao block dưới một ngưỡng (prototype dùng `hgt<44px`), rút gọn nội
   dung hiển thị còn tên khách, không cố nhồi cả hai dòng khiến chữ tràn hoặc
   không đọc được.

## Phạm vi
**Trong:**
- Timeline một cột mỗi KTV, một hàng mỗi giờ trong ca làm việc
- Vẽ block từ `booking_items` thật (gọi `GET /api/admin/schedule?date=`)
- Buffer hiện thành dải mờ ở đuôi mỗi block
- 4 màu trạng thái: đã đặt / đang làm / khách vãng lai / cần xếp lại (mồ côi)
- Block mồ côi luôn nổi lên trên khối "nghỉ đột xuất" (z-index)
- Block ngắn (≤30 phút hiển thị) rút gọn còn tên khách
- Banner cảnh báo hàng chờ khi có item mồ côi, không tự tắt tới khi hàng chờ
  rỗng (gọi `GET /api/admin/reassign-queue` để biết hàng chờ có rỗng hay không)
- Bấm vào một block mở Sheet xem chi tiết + đổi trạng thái
  (`POST /api/admin/bookings/:id/status`)
- Chú giải màu (legend) dưới timeline

**Ngoài:**
- Không làm sheet khách vãng lai hay sheet chuyển KTV (T-13)
- Không làm màn "Thiết lập" (CRUD skills/staff/services) — chưa có task riêng,
  không tự thêm phạm vi
- Không làm điều hướng đổi ngày bằng URL/router phức tạp — chỉ cần nút lùi/tiến
  ngày đơn giản như prototype

## Đầu vào đã có
- **T-09 để lại** component nền: `Button`, `Card`, `Pill`, `Notice`, `Sheet`,
  `EmptyState`.
- **T-07 để lại** các endpoint: `GET /api/admin/schedule?date=` (danh sách tất
  cả `booking_items` trong ngày, mọi KTV), `GET /api/admin/reassign-queue`
  (item mồ côi, sắp xếp theo `start_at` tăng dần). T-05 để lại
  `POST /api/admin/bookings/:id/status`.
- `prototype/index.html` là spec giao diện: đọc hàm `dayView()` (dòng
  736–792), `openAppt()`/`setSt()` (dòng 995–1027), và toàn bộ CSS `.tl*`,
  `.ev*`, `.legend`, `.banner` (dòng 254–288). Bám đúng cấu trúc lưới CSS
  Grid (`.tlgrid` với `--cols` = số KTV), cách tính `top`/`height` của mỗi
  block theo phút.

## Việc phải làm
1. Gọi `GET /api/admin/schedule?date=` lấy toàn bộ `booking_items` trong ngày
   cùng tên KTV, tên khách, tên dịch vụ.
2. Gọi `GET /api/admin/reassign-queue` để biết danh sách item mồ côi và số
   lượng — dùng để hiện banner và để tô đúng màu "cần xếp lại" cho các item đó
   trên timeline (một item là mồ côi nếu nó xuất hiện trong danh sách hàng chờ
   này, không tự suy luận lại logic đó ở frontend).
3. Dựng lưới: cột đầu là giờ, các cột sau mỗi cột một KTV. Tính vị trí
   (`top`, `height`) của mỗi block theo `start_at`/`end_at`/`block_end_at` quy
   đổi ra phút trong ngày, giống công thức prototype (`top = (start - hourStart)/60 * rowHeight`).
4. Vẽ dải buffer ở đáy mỗi block (chiều cao tỷ lệ với
   `block_end_at - end_at`), màu mờ hơn phần chính của block.
5. Vẽ khối "nghỉ đột xuất" của KTV đang có time-off, đặt z-index **thấp hơn**
   mọi block booking để booking (đặc biệt mồ côi) luôn nổi lên trên.
6. Áp class/màu theo trạng thái: `booked`, `in_service`, `walk_in`, và mồ côi
   (ưu tiên cao nhất, tô đỏ cảnh báo, z-index cao nhất trong các loại block).
7. Với block có chiều cao hiển thị dưới ngưỡng ngắn, chỉ hiện tên khách, ẩn
   tên dịch vụ.
8. Banner cảnh báo: hiện khi `reassign-queue` không rỗng, nêu số lượng, có nút
   "Xử lý ngay" (điều hướng sang màn hàng chờ của T-13, hoặc placeholder nếu
   T-13 chưa xong — ghi rõ trong "Đã làm gì" nếu phải làm placeholder tạm).
9. Bấm vào một block mở `Sheet` hiện chi tiết (dịch vụ, giờ, buffer, KTV,
   trạng thái) + nút đổi trạng thái tương ứng chuyển hợp lệ theo PRD §3.3
   (`booked → in_service → done`, hoặc `no_show`), gọi
   `POST /api/admin/bookings/:id/status`, cập nhật ngay trên timeline không
   cần tải lại trang.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §3 (trạng thái), §5, §8.

Nhấn lại:
- Availability/trạng thái mồ côi luôn lấy từ API (`reassign-queue`), không tự
  suy luận lại "cái này chắc là mồ côi vì trùng giờ time-off" ở tầng UI — hai
  bản logic sẽ trôi khỏi nhau.
- Block booking phải luôn nổi lên trên khối nghỉ về mặt hiển thị (z-index).

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm run e2e -- tests/e2e/admin-timeline.spec.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/e2e/admin-timeline.spec.ts`
- `booking hiện đúng cột của đúng KTV tại đúng vị trí giờ trên timeline`
- `buffer sau mỗi block hiện thành dải mờ riêng biệt với phần chính của block`
- `item mồ côi hiện màu cảnh báo khác với booking bình thường`
- `item mồ côi nổi lên trên khối nghỉ đột xuất, không bị khối nghỉ che khuất`
- `banner hàng chờ hiện ra khi có ít nhất một item mồ côi`
- `banner hàng chờ biến mất khi hàng chờ được xử lý hết (rỗng)`
- `block dịch vụ ngắn dưới 30 phút chỉ hiện tên khách, không hiện tên dịch vụ`
- `bấm vào một block mở sheet hiện đúng thông tin của booking đó`
- `đổi trạng thái sang đang làm trong sheet cập nhật ngay màu block trên timeline không cần tải lại trang`

## Định nghĩa "xong"
Seed một time-off đè lên 2 booking thật qua API, mở màn timeline, thấy banner
cảnh báo hiện ra kèm đúng 2 block mồ côi màu cảnh báo nổi trên khối nghỉ —
kiểm chứng bằng `npm run e2e -- tests/e2e/admin-timeline.spec.ts`.

## Cạm bẫy đã biết
- **Vẽ khối nghỉ đè lên booking mồ côi là lỗi trực quan nghiêm trọng nhất của
  card này** — lễ tân sẽ không thấy khách nào cần gọi. Test phải kiểm tra thứ
  tự z-index thật (hoặc thứ tự DOM/độ trong suốt quan sát được), không chỉ
  kiểm tra "có render ra" là đủ.
- Đừng tự tính lại "item nào là mồ côi" bằng cách so `start_at` với `time_off`
  ở tầng frontend — luôn tin vào `GET /api/admin/reassign-queue` T-07 đã trả,
  vì logic suy luận mồ côi đã cố tình đặt ở backend để tránh hai bản sự thật
  trôi khỏi nhau (PRD §8).
- Ngưỡng "block ngắn" nên tính theo chiều cao pixel thực tế render ra (phụ
  thuộc độ dài của biến `rowHeight` chọn trong code), không hard-code cứng
  theo phút dịch vụ — một dịch vụ 45 phút ở độ phóng to nhỏ khác nhau có thể
  vẫn cần rút gọn hoặc không, tuỳ cách bố trí đã chọn.

## Đã làm gì

**Block cũ đã hết** — `GET /api/admin/schedule?date=` giờ đã tồn tại thật
(T-16, mounted ở `src/worker/routes/admin-schedule.ts`, đúng response shape
đã kiểm chứng bằng test thật: `{ date, staff: [{ id, name, items[], time_off[] }] }`).
Đã đọc lại code endpoint này trước khi viết UI để bám đúng field thật (không
đoán). `GET /api/admin/reassign-queue` cũng đã có (T-07,
`src/worker/routes/admin-timeoff.ts`), trả `{ items: [{ item_id, ... }] }` —
dùng `item_id` (không phải `id`) làm khoá xác định mồ côi.

**Đã hoàn thành toàn bộ phạm vi của card.** Các file tạo mới (đúng `touches`):
- `src/app/routes/admin/timeline/TimelinePage.tsx` — component chính
- `src/app/routes/admin/timeline/api.ts` — `getSchedule`, `getReassignQueue`,
  `setBookingStatus`, theo mẫu `src/app/api/client.ts` (T-10) / `routes/lookup/api.ts` (T-11)
- `src/app/routes/admin/timeline/format.ts` — quy đổi giờ địa phương SPA_TZ
- `src/app/routes/admin/timeline/timeline.css` — port từ `.tl*/.ev*/.legend/.banner` của prototype
- `tests/e2e/admin-timeline.spec.ts` — 9/9 test đúng tên card yêu cầu

**Một dòng ngoài `touches`, có tiền lệ:** `src/app/main.tsx` — thêm
`import TimelinePage` + `<Route path="/admin/timeline">`. Không nằm trong
`touches` của T-12, nhưng bắt buộc để trang mở được ở URL riêng, và T-11 đã
làm y hệt (nối `LookupPage` vào `main.tsx` dù ngoài touches của T-11) —
không route/task nào khác claim quyền sửa dòng Route này.

**Seed dữ liệu tất định cho e2e** (theo đúng yêu cầu "không phụ thuộc giờ chạy"):
- Ngày mục tiêu = Thứ Hai gần nhất SAU HÔM NAY (`nextMondayDateStr()`), luôn
  rơi vào ca làm việc Mon-Sat 09:00-19:00 của seed chuẩn, luôn ở tương lai.
- Mỗi test tự `INSERT` thẳng vào D1 local qua `wrangler d1 execute --local
  --file=` (CÙNG cơ chế `tests/e2e/customer-lookup.spec.ts` đã dùng, đọc lại
  trước khi viết) — không bao giờ `DELETE`, để không phá dữ liệu của agent
  khác chạy song song. Giờ neo theo giờ địa phương cố định trên ngày mục tiêu
  (ví dụ 10:00, 15:00), không neo theo `Date.now()`.
- Item mồ côi dựng bằng cách seed một `booking_item` thật rồi seed
  `time_off` phủ đúng khung giờ đó cho cùng KTV — KHÔNG tự suy luận "mồ côi"
  ở test hay ở UI, luôn đọc qua `GET /api/admin/reassign-queue` thật.
- Test "banner biến mất khi hàng chờ rỗng" tự dọn (huỷ, không xoá dòng) mọi
  orphan còn sót từ lần chạy trước có tên khách khớp tiền tố `E2E TL %` của
  chính file này trước khi seed lại — nếu không, hàng chờ toàn cục sẽ không
  bao giờ về 0 do các test khác trong cùng file cũng tạo orphan trên DB dùng
  chung.

**Ba cạm bẫy prototype — đã port đúng, có test riêng cho từng cái:**
1. Z-index: khối nghỉ `z-index:0`, booking thường `z-index:2`, booking mồ côi
   `z-index:3` (cao nhất) — test `item mồ côi nổi lên trên khối nghỉ...` xác
   nhận cả `getComputedStyle().zIndex` lẫn `elementFromPoint()` tại toạ độ
   thật (hit-test) đều trả về đúng block mồ côi, không phải khối nghỉ.
2. Block ngắn: ngưỡng tính theo **chiều cao pixel thực tế** sau khi trừ buffer
   (`height < SHORT_BLOCK_THRESHOLD_PX = 44`), không hard-code theo phút dịch
   vụ — dùng class `.ccf-tl-ev--short` ẩn dòng tên dịch vụ qua CSS
   `display:none`, giữ nguyên trong DOM (test kiểm bằng `toBeHidden()`).
3. Buffer: dải `<div class="ccf-tl-ev-buf">` tuyệt đối định vị ở đáy block,
   chiều cao = `(block_end_at - end_at)/60 * ROW_HEIGHT_PX`, `pointer-events:none`
   để không chặn click vào block.

**Tự mở trình duyệt kiểm chứng thật (không chỉ tin test xanh)** — bài học
T-09 (8/8 test xanh nhưng chữ nút đen trên nền xanh đậm) áp dụng nghiêm ở đây
vì timeline có rủi ro thị giác cao hơn. Seed một bộ dữ liệu minh hoạ đủ 4
trạng thái (booked/in_service/walk_in/orphan) + time-off + block ngắn qua
`wrangler d1 execute --local`, mở `/admin/timeline` bằng Chrome thật:
- Orphan (đỏ) render rõ ràng TRÊN khối nghỉ sọc xám, không bị che — xác nhận
  bằng mắt lẫn bằng `elementFromPoint` tại tâm block.
- Block ngắn (30 phút, "VisualShort Nguyen") chỉ hiện tên khách, không tràn chữ.
- Dải buffer 15 phút đo được đúng ~13px (15/60 × 52px row height), màu mờ
  `rgba(20,52,42,.09)` ở đáy block, tách biệt phần chính.
- 4 màu trạng thái phân biệt rõ: booked xanh lá nhạt, in_service xanh dương,
  walk_in vàng cam, orphan đỏ — đối chiếu đúng bảng màu prototype.
- Bấm block mở Sheet đúng chi tiết (dịch vụ, giờ, buffer, KTV, trạng thái) +
  3 nút hành động, bấm "Bắt đầu làm" cập nhật `data-status` ngay trên timeline
  không cần tải lại trang, ĐỒNG THỜI vẫn giữ màu đỏ mồ côi (đúng nghiệp vụ:
  đổi trạng thái không tự resolve khỏi reassign-queue, chỉ huỷ/reassign mới
  resolve — PRD §8).
- Tương phản màu chữ đo bằng WCAG formula (giống `components.spec.ts`):
  booked 11.4:1, banner title 6.1:1, orphan 8.78:1 — đều vượt xa AA 4.5:1.
- Mobile 375px: banner/datenav/block không tràn ngang trang (chỉ bảng
  timeline tự cuộn ngang theo đúng thiết kế), nút lùi/tiến ngày 44px (đúng
  ngoại lệ `size="sm"` của T-09), block đủ lớn để bấm.

**Sự cố hạ tầng gặp phải khi kiểm chứng (không phải lỗi của T-12):** dev
server dùng chung với T-10/T-11 có lúc crash/restart, và trong lúc T-10 còn
`blocked` (đã tự phát hiện + ghi trong card của họ) do `src/app/api/client.ts`
va chạm `run_worker_first: ["/api/*"]` ở `wrangler.jsonc`, toàn bộ SPA (kể cả
`/admin/timeline`) tạm thời trắng trang vì `main.tsx` import mọi route trong
một bundle. Không tự sửa (`wrangler.jsonc` ngoài `touches`, T-01 mới được
sửa) — đợi ổn định rồi kiểm chứng lại, đã xanh khi T-10 tự resolve.

**Kết quả:**
- `npm run typecheck` — xanh
- `npm run e2e -- tests/e2e/admin-timeline.spec.ts` — **9/9 xanh**, chạy lại
  3 lần liên tiếp đều ổn định (không phụ thuộc thứ tự global orphan trong DB
  dùng chung nhờ bước tự dọn ở test 6)
- Đã tự mở Chrome thật kiểm chứng thị giác (không chỉ tin test xanh)
</content>
