---
id: T-31
title: Timeline week view + chọn ngày + nút "Hôm nay"
status: review
model: sonnet
effort: medium
depends_on: ["T-12"]
touches:
  - src/app/routes/admin/timeline/TimelinePage.tsx
  - src/app/routes/admin/timeline/timeline.css
  - src/app/routes/admin/timeline/api.ts
  - src/worker/routes/admin-schedule.ts
  - tests/e2e/admin-timeline.spec.ts
  - tests/api/admin-schedule.test.ts
prd_refs: []
owner: null
started_at: null
finished_at: 2026-07-30
---

# T-31 · Timeline week view + chọn ngày + nút "Hôm nay"

## Mục tiêu
Lễ tân/chủ spa trả lời được "tuần sau còn chỗ trống chiều thứ Ba không?" ngay trên
timeline — bằng chế độ **tuần** + **chọn ngày** + nút **Hôm nay**, thay vì bấm mũi
tên ‹/› từng ngày và tự đếm.

## Ngữ cảnh cần biết
Audit code-blind kết luận **Missing perspective P1** (G4, KHÔNG auto-P3): timeline chỉ
có **một** view ngày, điều hướng chỉ mũi tên ±1 ngày, không week/month, không date
picker, và sau khi rời hôm nay **không có** nút quay lại hôm nay. Guide quy định:
horizon vận hành thật thiếu trên **primary workspace** thì không được tụt P3.

Mỗi lens phải gắn một named decision: week view = "còn chỗ trống ở đâu / xếp khách
vào lúc nào".

## Phạm vi
**Trong:**
- Chế độ **tuần**: 7 cột ngày; mỗi ngày cho thấy mức lấp/đầy đủ để nhìn ra chỗ trống.
- Nút "Hôm nay" đưa về ngày hiện tại một click.
- Date picker (input date) nhảy tới ngày bất kỳ.
- Chuyển qua lại day ↔ week giữ nguyên context.

**Ngoài:**
- Month view: chỉ làm nếu rẻ; nếu không, ghi rõ hoãn (week đã giải quyết quyết định
  chính). Không gò.
- KHÔNG thêm drag/tạo trong week view (giữ cho T-29/T-30 ở day view trước).
- KHÔNG làm dashboard số liệu ở đây (đó là G6/overview, card khác).

## Đầu vào đã có
- `admin-schedule` endpoint hiện nhận `?date=` (một ngày). Cần cho week: hoặc gọi 7
  lần, hoặc thêm range `?from=&to=`. Ưu tiên 1 endpoint range — thêm đúng 1 dòng vào
  `registerRoutes()` nếu là route mới; nếu mở rộng route cũ thì giữ tương thích
  `?date=`.
- `TimelinePage.tsx` day grid tái dùng cho từng cột ngày.

## Việc phải làm
1. Toggle Day / Week trên qbar.
2. Week: render 7 ngày; mỗi ngày đủ thông tin thấy chỗ trống (đơn giản: đếm block /
   ca, hoặc mini-grid). Chọn cách rẻ mà vẫn trả lời được câu hỏi lấp-đầy.
3. Nút "Hôm nay" + date input.
4. Data: gọi range hoặc lặp; đừng làm chậm rõ rệt.

## Quy ước bắt buộc
Copy mục liên quan `docs/tasks/CONVENTIONS.md`. Route mới chỉ thêm 1 dòng vào
`registerRoutes()`.

## Checklist đầu ra
- [ ] Typecheck xanh
- [ ] Test API `npm test` xanh
- [ ] Test E2E `npm run e2e` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] `status: review` + `finished_at`
- [ ] "Đã làm gì"

## Test phải viết
- E2E: toggle sang Week → thấy 7 ngày; ngày có lịch hiện khác ngày trống.
- E2E: bấm "Hôm nay" từ một ngày xa → về đúng hôm nay.
- E2E: date picker nhảy tới ngày cụ thể → grid đúng ngày đó.
- API: endpoint range trả đúng dữ liệu 7 ngày (nếu làm range).

## Định nghĩa "xong"
Từ timeline, xem được cả tuần và nhảy tới bất kỳ ngày nào trong ≤1 thao tác, và về
hôm nay bằng 1 nút.

## Cạm bẫy đã biết
- Đừng gọi 7 request tuần tự gây giật; batch hoặc range.
- Week view dễ phình thành "làm mọi thứ" — chỉ cần trả lời câu hỏi lấp-đầy, không cần
  đầy đủ tương tác như day.
- Giữ tương thích `?date=` nếu mở rộng endpoint cũ.

## Đã làm gì
- Backend: mở rộng `GET /api/admin/schedule` để nhận thêm `?from=&to=` (range
  tối đa 7 ngày, MỘT truy vấn items + MỘT truy vấn time_off cho cả range, bucket
  theo ngày trong bộ nhớ) — giữ nguyên `?date=` không đổi hành vi cho T-29/T-30/
  day view. Trả `{ from, to, days: [{date, staff}, ...] }`.
- Frontend: toggle "Ngày"/"Tuần" trên qbar, nút "Hôm nay", `<input type="date">`
  để nhảy ngày. Week view là 7 cột đọc-only (không drag/tạo — đúng "Ngoài" của
  card): mỗi cột hiện số lịch hẹn sống (booked/in_service), badge "Trống lịch"
  khi rỗng, badge số lịch + "Nghỉ" theo từng KTV, badge cảnh báo số lịch mồ côi;
  bấm một cột nhảy sang day view đúng ngày đó (giữ context).
- Rebase lên `main` sau khi T-29 + T-30 merge (cả hai cùng sửa `TimelinePage.tsx`
  + `api.ts`): auto-merge sạch 3/4 file, 1 conflict thủ công ở
  `tests/e2e/admin-timeline.spec.ts` (thứ tự nối hai khối test T-30 kéo-thả +
  T-31 week/hôm-nay) — giải quyết bằng cách giữ nguyên cả hai khối tuần tự,
  không xoá test nào của T-30.
- Test: 7 case API mới cho range (7 ngày liên tiếp, ngày bận vs ngày trống, quá
  7 ngày → 422, to trước from → 422, sai định dạng → 422, thiếu to → 422,
  booking vắt nửa đêm đầu range) + 4 case E2E (toggle→7 cột, ngày bận≠ngày
  trống trên week, Hôm nay về đúng ngày, date picker nhảy ngày).
- Xác nhận: `npm run typecheck` xanh; `npm test` 438/438 xanh (27 file, tăng từ
  431 baseline T-29+T-30 nhờ 7 test range mới); E2E `admin-timeline.spec.ts`
  23/23 xanh và cả `chromium-shared-queue` 36/36 xanh (CI=true, workers=1, port
  riêng — không đụng cross-worktree). Full `chromium` project (59 test, serial)
  57 passed / 1 failed đúng-y ca đã biết trước (`customer-reschedule.spec.ts:70`,
  `rs-slot-`) — tái hiện được cả khi chạy cô lập hoàn toàn, xác nhận đây là bug
  môi trường có sẵn trên `main`, không liên quan T-31.
