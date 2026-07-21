---
id: T-13
title: UI admin — khách vãng lai + hàng chờ xếp lại
status: todo
model: sonnet
effort: high
depends_on: ["T-12", "T-08"]
touches:
  - src/app/routes/admin/walkin/
  - src/app/routes/admin/reassign/
  - tests/e2e/admin-walkin-reassign.spec.ts
prd_refs: ["§7", "§8"]
owner: null
started_at: null
finished_at: null
---

# T-13 · UI admin — khách vãng lai + hàng chờ xếp lại

## Mục tiêu
Lễ tân tạo được một lượt phục vụ cho khách vãng lai trong vài giây (dịch vụ →
gói → KTV rảnh ngay → tên hoặc "Khách lẻ" → bắt đầu), và xử lý được hết hàng
chờ những khách bị mất KTV vì nghỉ đột xuất — gọi điện, chuyển người khác, hoặc
huỷ.

## Ngữ cảnh cần biết
Walk-in là appointment thật, không phải ghi chú (PRD §7):
> 30–50% of spa traffic arrives without an appointment. Walk-ins are real
> appointments (`source='walk_in'`), never `time_off`.

Luồng đã chốt (PRD §7):
> 1. Pick variant → system shows technicians free right now
> 2. Pick technician
> 3. Customer identity: existing phone, or name+phone, or "Khách lẻ" (anonymous)
> 4. Create appointment, `status='in_service'`, `start_at = now`

`start_at` của walk-in **miễn lưới 15 phút** — khách đến giờ nào thì bắt đầu
giờ đó, không làm tròn.

Hàng chờ xếp lại (PRD §8) tồn tại vì một KTV nghỉ đột xuất không được phép làm
khách "biến mất" — mỗi khách trong hàng chờ cần: gọi điện, chuyển KTV, hoặc
huỷ (kèm xin lỗi). Hàng chờ chỉ rỗng khi mọi item được xử lý bằng hành động của
con người, không tự động.

**Hai phát hiện quan trọng từ prototype** (`prototype/index.html`, hàm
`openReassign()` dòng 950–983):

1. **Sheet chuyển KTV phải nêu rõ lý do từng người bị loại, không chỉ làm mờ
   nút.** Trích prototype (dòng 973): mỗi ứng viên có biến `why` giải thích cụ
   thể — "Không có kỹ năng [tên kỹ năng]" / "Bận khung giờ này" / "Đủ kỹ năng ·
   đang rảnh". Lễ tân đang xử lý một tình huống gấp (khách đang chờ gọi lại) —
   nếu chỉ thấy nút xám mà không biết vì sao, họ không thể quyết định có nên
   thử gọi thêm KTV khác không, hay chấp nhận huỷ luôn. Lý do loại phải lấy từ
   `GET /api/admin/bookings/:id/reassign-candidates` (T-07 để lại, mỗi ứng
   viên có `{ staff, eligible, reason }`), không tự suy đoán ở frontend.
2. **Trường hợp không ai nhận được khung giờ đó là có thật, không phải edge
   case hiếm.** Prototype xử lý riêng (dòng 962–967): khi không còn ứng viên
   nào đủ điều kiện, hiện một `Notice` cảnh báo riêng biệt, nêu rõ "Không có ai
   nhận được khung giờ này. Gọi khách để đổi sang giờ khác, hoặc huỷ và xin
   lỗi khách." kèm số điện thoại khách dạng `tel:` bấm gọi ngay được. Đừng để
   giao diện chỉ còn 4 nút xám im lặng — lễ tân phải được dẫn dắt sang hành
   động kế tiếp cụ thể (gọi khách), không phải tự đoán.

## Phạm vi
**Trong:**
- Sheet "Khách vãng lai" (nút FAB cố định, mở từ mọi màn admin): chọn dịch vụ
  → chọn gói → danh sách KTV rảnh ngay bây giờ → tên/SĐT (không bắt buộc) hoặc
  để trống thành "Khách lẻ" → nút "Bắt đầu phục vụ"
  (gọi `GET /api/admin/available-now?variant_id`, `POST /api/admin/walk-ins`)
- Màn "Hàng chờ xếp lại": danh sách khách mồ côi, mỗi khách có nút gọi điện
  (`tel:`), nút chuyển KTV, nút huỷ
  (gọi `GET /api/admin/reassign-queue`)
- Sheet "Chuyển kỹ thuật viên": danh sách ứng viên kèm lý do loại rõ ràng cho
  từng người không đủ điều kiện; trường hợp không ai nhận được có thông báo
  riêng kèm số điện thoại khách
  (gọi `GET /api/admin/bookings/:id/reassign-candidates`,
  `POST /api/admin/bookings/:id/reassign`)
- Huỷ một item trong hàng chờ (`POST /api/admin/bookings/:id/cancel`)

**Ngoài:**
- Không làm timeline chính (T-12 đã làm) — chỉ tích hợp banner/nút điều hướng
  sang màn này
- Không làm sheet "Báo nghỉ đột xuất" tạo time-off (đã thuộc phạm vi T-12 nếu
  cần, hoặc để CRUD chung — không tự mở rộng phạm vi card này nếu chưa rõ,
  báo lại nếu thiếu)
- Không gửi SMS/tự động gọi điện — nút gọi chỉ mở ứng dụng điện thoại của lễ
  tân, không tích hợp tổng đài

## Đầu vào đã có
- **T-12 để lại** timeline admin đã render được, banner hàng chờ đã có nút
  điều hướng "Xử lý ngay" — T-13 hoàn thiện đích đến của nút đó.
- **T-08 để lại** các endpoint walk-in:
  `GET /api/admin/available-now?variant_id` (KTV rảnh ngay bây giờ),
  `POST /api/admin/walk-ins` (tạo appointment `status='in_service'`,
  `start_at=now`, miễn lưới 15 phút).
- **T-07 để lại** (đã dùng ở T-12, dùng tiếp ở đây):
  `GET /api/admin/reassign-queue`,
  `GET /api/admin/bookings/:id/reassign-candidates` (trả
  `{ staff, eligible, reason }` cho từng KTV — `reason` giải thích cụ thể lý do
  không đủ điều kiện: thiếu skill / ngoài ca / bận giờ đó / đang nghỉ phép),
  `POST /api/admin/bookings/:id/reassign`.
- **T-09 để lại** `Sheet`, `Button`, `Field`, `Notice`, `Avatar` (dùng cho danh
  sách KTV kiểu `.staffpick` trong prototype).
- `prototype/index.html` là spec giao diện: đọc hàm `drawWalkIn()` (dòng
  856–911), `openReassign()`/`doReassign()` (dòng 950–988), `queueView()`
  (dòng 794–821). Bám đúng bố cục sheet, thứ tự bước, và văn phong tiếng Việt.

## Việc phải làm
1. **FAB "+ Khách vãng lai"** hiện trên mọi màn admin, mở Sheet walk-in.
2. **Sheet walk-in**:
   - Select dịch vụ → select gói → gọi `GET /api/admin/available-now` lấy KTV
     rảnh ngay; không ai rảnh → `Notice` cảnh báo, không có nút tiếp tục ẩn đi
   - Danh sách KTV dùng style `.staffpick`/`Avatar`, người đầu tiên có thể gắn
     nhãn gợi ý (ít việc nhất) theo cùng luật load-balancing của auto-assign
   - Field tên (tuỳ chọn) + SĐT (tuỳ chọn) — để trống cả hai thì lưu là
     "Khách lẻ" đúng theo PRD §7
   - Nút "Bắt đầu phục vụ" khoá tới khi đã chọn KTV; gọi
     `POST /api/admin/walk-ins`, đóng sheet, quay về/làm mới timeline, block
     mới hiện ngay
3. **Màn hàng chờ xếp lại**: gọi `GET /api/admin/reassign-queue`, render mỗi
   item kiểu `.qitem` (giờ, tên khách, dịch vụ, SĐT), 3 hành động:
   - Nút gọi điện: `<a href="tel:...">` mở thẳng app gọi điện của máy
   - Nút "Chuyển kỹ thuật viên": mở Sheet chuyển KTV cho item đó
   - Nút "Huỷ lịch": xác nhận rồi gọi `POST /api/admin/bookings/:id/cancel`,
     item rời hàng chờ ngay
   - Hàng chờ rỗng → `EmptyState` "Không còn lịch nào cần xếp lại"
4. **Sheet chuyển KTV**:
   - Gọi `GET /api/admin/bookings/:id/reassign-candidates`
   - Ứng viên đủ điều kiện (`eligible: true`) → nút bấm được, chuyển thẳng
   - Ứng viên không đủ điều kiện (`eligible: false`) → nút mờ/disabled **kèm
     dòng `reason` hiển thị rõ ràng bên dưới tên**, không chỉ làm mờ im lặng
   - Không còn ai đủ điều kiện → `Notice` cảnh báo riêng, nêu rõ tình huống,
     kèm thẻ số điện thoại khách dạng `tel:` để gọi ngay
   - Chuyển thành công → gọi `POST /api/admin/bookings/:id/reassign`, đóng
     sheet, item rời khỏi hàng chờ ngay lập tức

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §5, §6, §8.

Nhấn lại:
- Lý do loại ứng viên phải lấy nguyên văn từ API (`reason`), không tự diễn giải
  lại hay rút gọn mất thông tin.
- Không hiện mã lỗi thô cho lễ tân cũng cần hạn chế tối đa — dù lễ tân rành
  nghiệp vụ hơn khách, thông báo vẫn nên là câu tiếng Việt rõ ràng thay vì mã
  lỗi API trần trụi.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm run e2e -- tests/e2e/admin-walkin-reassign.spec.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/e2e/admin-walkin-reassign.spec.ts`
- `tạo khách vãng lai xong thì block mới hiện ngay trên timeline`
- `tạo khách vãng lai không nhập tên và SĐT thì hiện là "Khách lẻ"`
- `chọn dịch vụ mà không ai rảnh ngay bây giờ thì hiện thông báo không có ai rảnh, không có nút tiếp tục`
- `nút Bắt đầu phục vụ bị khoá khi chưa chọn KTV`
- `sheet chuyển KTV hiện đúng lý do loại của từng KTV không đủ điều kiện`
- `KTV thiếu kỹ năng trong sheet chuyển KTV hiện đúng lý do thiếu kỹ năng, không phải lý do chung chung`
- `KTV đang bận giờ đó trong sheet chuyển KTV hiện đúng lý do đang bận`
- `khi không còn ai đủ điều kiện, hiện thông báo riêng kèm số điện thoại khách dạng tel: bấm gọi được`
- `chuyển KTV thành công thì item rời khỏi hàng chờ xếp lại ngay lập tức`
- `huỷ một item trong hàng chờ thì item đó biến mất khỏi hàng chờ`
- `hàng chờ rỗng hiện trạng thái "không còn lịch nào cần xếp lại"`

## Định nghĩa "xong"
Seed một time-off đè lên một booking thật, mở màn hàng chờ, chuyển booking đó
sang một KTV đủ skill và đang rảnh, thấy item biến mất khỏi hàng chờ ngay —
kiểm chứng bằng `npm run e2e -- tests/e2e/admin-walkin-reassign.spec.ts`.

## Cạm bẫy đã biết
- **Làm mờ nút mà không hiện lý do là lỗi UX prototype đã cố tình sửa** — đừng
  quay lại cách làm cũ (chỉ `disabled` không kèm `reason`). Test phải khẳng
  định chữ lý do thật sự xuất hiện trên màn hình, không chỉ khẳng định nút bị
  khoá.
- **Trường hợp "không ai nhận được" bị bỏ sót vì hiếm khi xảy ra khi test tay**
  nhưng lại là tình huống thật khi một KTV có kỹ năng hiếm nghỉ đột xuất — phải
  seed dữ liệu cố ý tạo ra tình huống này để test, không bỏ qua vì "ít gặp".
- Đừng tự tính lại `eligible`/`reason` ở frontend dựa trên dữ liệu KTV và giờ
  làm — luôn dùng nguyên kết quả từ
  `GET /api/admin/bookings/:id/reassign-candidates`, vì T-07 đã đặt logic này
  ở backend để tránh hai bản sự thật trôi khỏi nhau.
- Walk-in không theo lưới 15 phút — nếu component chọn giờ tái sử dụng từ T-10
  có validate lưới 15 phút, đảm bảo sheet walk-in không vô tình áp lại rule đó.

## Đã làm gì
(agent điền khi xong)
</content>
