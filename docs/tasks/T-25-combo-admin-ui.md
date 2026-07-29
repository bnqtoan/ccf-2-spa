---
id: T-25
title: G6 — UI lễ tân thêm dịch vụ vào appointment (combo admin)
status: review
model: sonnet
effort: medium
depends_on: [T-19, T-22]
touches:
  - src/app/routes/admin/timeline/
  - tests/
prd_refs: ["§1"]
owner: null
started_at: null
finished_at: null
---

# T-25 · G6 — UI lễ tân thêm dịch vụ vào appointment (combo admin)

## Mục tiêu
Backend `POST /api/admin/appointments/:id/items` ĐÃ CÓ (thêm item combo vào một
appointment, chặn trùng body_zone) nhưng **không có UI gọi** — audit G6 (invisible
capability). Khách đang làm dịch vụ muốn thêm dịch vụ nữa → lễ tân phải làm được
ngay trên timeline. Task này chỉ dựng UI cho backend đã sẵn.

## Ngữ cảnh cần biết
- Audit G6 (P2): "combo item admin backend + test có, UI dark". Chỉ mở UI, KHÔNG
  viết lại backend.
- Backend: `POST /api/admin/appointments/:id/items` body `{variant_id, staff_id,
  start_at}` — re-validate booking + chặn 2 item cùng body_zone chồng giờ. Trả item
  mới hoặc 409 (ZONE_CONFLICT/SLOT_TAKEN).
- RBAC (T-22): thao tác vận hành → owner + receptionist làm được, technician KHÔNG
  (đây là thêm cho appointment KTV khác — thuộc vận hành). Đã gated ở registerRoutes?
  Kiểm: nếu chưa, route này thuộc nhóm owner+receptionist (không phải technician).

## Phạm vi
**Trong:**
- Timeline: bấm một booking → sheet chi tiết (đã có, đổi trạng thái). Thêm nút
  "+ Thêm dịch vụ" trong sheet đó → mở form chọn: dịch vụ+gói, KTV, giờ bắt đầu →
  gọi `POST /api/admin/appointments/:id/items`.
- Chặn body_zone TRƯỚC hoặc báo rõ khi 409 (không lộ mã thô): "Dịch vụ này trùng
  vùng cơ thể với dịch vụ đang làm, chọn dịch vụ khác."
- Sau khi thêm → item mới hiện ngay trên timeline (reload schedule).

**Ngoài:**
- KHÔNG đụng backend (đã có + test). KHÔNG combo khách (T-26/R1a đã lo phía khách).
- KHÔNG sửa/xoá item đã thêm ở card này (chỉ thêm).

## Đầu vào đã có
- `POST /api/admin/appointments/:id/items` (admin-appointment-items.ts) — backend đủ.
- `TimelinePage.tsx` — sheet chi tiết booking (bấm block → sheet). Thêm nút ở đây.
- `GET /api/admin/services` (danh mục dịch vụ+variant), `/api/admin/available-now`
  hoặc availability — chọn KTV/giờ.
- Sheet đổi trạng thái hiện có làm mẫu affordance.

## Việc phải làm
1. Nút "+ Thêm dịch vụ" trong sheet booking của TimelinePage.
2. Form: chọn dịch vụ+gói → KTV → giờ → submit gọi API.
3. States: thành công (item hiện trên timeline), 409 zone-conflict (báo rõ), slot-taken.

## Quy ước bắt buộc (CONVENTIONS)
- §5 mã lỗi cũ (ZONE_CONFLICT/SLOT_TAKEN). §7 (không thêm route — dùng route sẵn).
- §8 test E2E. §9. Plain language — không lộ mã lỗi thô cho lễ tân.

## Checklist đầu ra
- [ ] typecheck · npm test · e2e --workers=1 xanh
- [ ] status review + "Đã làm gì"

## Test phải viết
- E2E: `lễ tân bấm booking → Thêm dịch vụ → chọn dịch vụ/KTV/giờ → item mới hiện trên timeline`
- E2E: `thêm dịch vụ trùng body_zone → báo thân thiện (không mã lỗi thô), không thêm`
- (nếu thêm API test) `thêm item hợp lệ → 201; trùng zone → 409 ZONE_CONFLICT`

## Định nghĩa "xong"
Lễ tân thêm được dịch vụ vào một appointment đang có ngay trên timeline; trùng vùng
cơ thể bị chặn với thông báo dễ hiểu; item mới hiện ngay.

## Cạm bẫy đã biết
- Backend đã có — ĐỪNG viết lại, chỉ gọi. Kiểm RBAC: technician không được thêm cho
  appointment người khác (nếu route chưa gated đúng, báo — nhưng KHÔNG sửa RBAC ở
  card này, chỉ ghi nhận).
- Body_zone conflict: báo rõ bằng tiếng Việt, không hiện ZONE_CONFLICT thô.
- Reload schedule sau khi thêm để item mới hiện (đừng chỉ đóng sheet).

## Đã làm gì
(agent điền khi xong)
