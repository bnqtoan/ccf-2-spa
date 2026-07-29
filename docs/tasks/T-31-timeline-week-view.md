---
id: T-31
title: Timeline week view + chọn ngày + nút "Hôm nay"
status: todo
model: sonnet
effort: medium
depends_on: ["T-12"]
touches:
  - src/app/routes/admin/TimelinePage.tsx
  - src/app/routes/admin/timeline.css
  - src/worker/routes/index.ts
prd_refs: []
owner: null
started_at: null
finished_at: null
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
(agent điền khi xong)
