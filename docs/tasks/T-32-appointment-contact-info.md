---
id: T-32
title: Hiện tên + SĐT khách + nút gọi trên sheet chi tiết lịch
status: todo
model: sonnet
effort: low
depends_on: ["T-12"]
touches:
  - src/app/routes/admin/TimelinePage.tsx
prd_refs: []
owner: null
started_at: null
finished_at: null
---

# T-32 · Hiện tên + SĐT khách + nút gọi trên sheet chi tiết lịch

## Mục tiêu
Lễ tân gọi được cho khách của một lịch **bình thường** ngay từ sheet chi tiết trên
timeline — hiện tên + SĐT + nút gọi (tel:) — không phải chờ tới lúc có sự cố nghỉ mới
thấy số.

## Ngữ cảnh cần biết
Audit code-blind (thao tác app thật) phát hiện: sheet chi tiết của một lịch bình
thường hiện KTV/dịch vụ/giờ/trạng thái **nhưng KHÔNG hiện số điện thoại khách** — dù
cùng lịch đó, khi rơi vào hàng chờ reassign thì lại hiện "0909111222" + nút "📞 Gọi
khách". Nghịch lý: muốn gọi khách của lịch thường thì không có số. Đây là gap
**Relationship opacity P2** (G5), fix rẻ, giá trị cao. (Đây là loại lỗi chỉ con-mắt
thao-tác-thật bắt được — đọc code khó thấy cái *vắng mặt* trên UI.)

## Phạm vi
**Trong:**
- Sheet chi tiết lịch (khi bấm block) hiện: tên khách, SĐT, nút gọi `tel:`.
- Dùng lại đúng cách reassign đang hiển thị (nhất quán label + nút gọi).

**Ngoài:**
- KHÔNG thêm PII khác ngoài tên+SĐT.
- KHÔNG đổi luồng reassign (nó đã đúng).
- Cân nhắc RBAC: technician xem lịch của mình — có nên thấy SĐT khách không? Mặc định
  cho thấy (họ phục vụ khách đó). Nếu policy khác, HỎI trước, đừng tự quyết.

## Đầu vào đã có
- `admin-schedule` / detail đã trả tên + SĐT ở luồng reassign — xác nhận field có sẵn
  trong payload sheet; nếu chưa có, kiểm endpoint trả về (có thể chỉ thiếu ở render,
  không thiếu ở data).
- Component nút gọi `tel:` đã dùng ở ReassignSheet — tái dùng.

## Việc phải làm
1. Kiểm payload sheet đã có phone chưa; nếu có → chỉ thêm render.
2. Render tên + SĐT + nút gọi trên sheet chi tiết.
3. Nhất quán với reassign.

## Quy ước bắt buộc
Copy mục liên quan `docs/tasks/CONVENTIONS.md`. Không mở rộng payload nếu đã đủ field.

## Checklist đầu ra
- [ ] Typecheck xanh
- [ ] Test API `npm test` xanh (nếu đụng endpoint)
- [ ] Test E2E `npm run e2e` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] `status: review` + `finished_at`
- [ ] "Đã làm gì"

## Test phải viết
- E2E: `reception` → timeline → bấm block có khách → sheet hiện tên + SĐT + nút gọi
  `tel:`.
- E2E: nút gọi có `href="tel:..."` đúng số.

## Định nghĩa "xong"
Từ sheet chi tiết của một lịch thường, lễ tân thấy được số khách và bấm gọi ngay.

## Cạm bẫy đã biết
- Có thể data đã có sẵn phone, chỉ thiếu render — đừng vội thêm query/endpoint.
- Đừng lộ PII vượt mức (chỉ tên+SĐT).

## Đã làm gì
(agent điền khi xong)
