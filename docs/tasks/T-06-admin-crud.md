---
id: T-06
title: CRUD admin cho skills/staff/services/variants/shifts
status: todo
model: codex
effort: medium
depends_on: ["T-02"]
touches:
  - src/worker/routes/admin-crud.ts
  - src/worker/db/crud.ts
  - src/worker/index.ts
  - tests/api/admin-crud.test.ts
prd_refs: ["§9", "§3.2"]
owner: null
started_at: null
finished_at: null
---

# T-06 · CRUD admin cho skills/staff/services/variants/shifts

## Mục tiêu
Cho lễ tân/quản lý tạo, sửa, liệt kê skills, staff (kèm gán skill), services,
service variants, và work shifts qua API — đây là dữ liệu nền mà mọi booking
online, walk-in, và availability đều phụ thuộc vào.

## Ngữ cảnh cần biết
Schema đã chốt (PRD §3.2):

```sql
skills           (id, name)
staff            (id, name, phone, active)
staff_skills     (staff_id, skill_id)             -- PK (staff_id, skill_id)

services         (id, name, skill_id, body_zone, active)
service_variants (id, service_id, name, duration_min, buffer_after_min,
                  price, active)

work_shifts      (id, staff_id, weekday, start_min, end_min)
                 -- weekday 0..6; minutes from midnight; repeats weekly
```

**Không xoá cứng bản ghi có lịch sử.** `staff`, `services`, `service_variants`
đều có cột `active` — vô hiệu hoá nghĩa là set `active=0`, không phải `DELETE`.
Lý do: một staff/service/variant đã từng gắn với booking cũ; xoá cứng làm gãy
mọi truy vấn lịch sử join ngược vào bảng đó. `skills` và `work_shifts` không
có cột `active` trong schema hiện tại — `skills` bị chặn xoá cứng nếu đang
được service dùng (xem dưới); `work_shifts` xoá cứng được vì nó chỉ là một ca
lặp lại hàng tuần, không mang lịch sử riêng (booking đã ghi nhận giờ cụ thể
vào `booking_items`, không phụ thuộc ngược vào dòng `work_shifts` gốc).

**Xoá một skill đang được `services.skill_id` tham chiếu phải bị chặn** — trả
lỗi rõ ràng thay vì để ràng buộc khoá ngoại ném lỗi SQL thô, hoặc tệ hơn, để
lọt qua rồi availability engine (T-03) gặp `skill_id` mồ côi và xử sự khó
đoán (service tồn tại nhưng skill biến mất → không ai match được → mọi slot
của service đó biến mất âm thầm, không ai báo lỗi).

Đây là task **lặp lại nhiều, đặc tả rõ theo REST** — 5 resource cùng một hình
dạng CRUD, hợp giao cho việc triển khai theo đặc tả chặt thay vì cần phán đoán
nghiệp vụ mới.

## Phạm vi
**Trong:**
- `GET/POST /api/admin/skills`, `PATCH /api/admin/skills/:id`,
  `DELETE /api/admin/skills/:id` (chặn nếu đang được dùng)
- `GET/POST /api/admin/staff`, `PATCH /api/admin/staff/:id` (gồm cả
  vô hiệu hoá qua `active=false`)
- `POST /api/admin/staff/:id/skills` — gán một skill cho staff
- `DELETE /api/admin/staff/:id/skills/:skillId` — bỏ gán
- `GET/POST /api/admin/services`, `PATCH /api/admin/services/:id`
- `GET/POST /api/admin/variants`, `PATCH /api/admin/variants/:id` (variant
  thuộc về một `service_id`)
- `GET/POST /api/admin/shifts`, `PATCH /api/admin/shifts/:id`,
  `DELETE /api/admin/shifts/:id`
- Validation: `duration_min <= 0` → 422; `start_min >= end_min` → 422

**Ngoài:**
- Không làm CRUD `time-off` (task khác, thuộc luồng reassign)
- Không làm UI
- Không làm xoá cứng bất kỳ bảng nào có `active` — chỉ toggle
- Không đổi schema/migration — dùng nguyên bảng T-02 để lại

## Đầu vào đã có
- T-02 để lại: migration đủ 5 bảng trên + `src/worker/db/types.ts` có type
  từng bảng, index cần thiết đã tạo sẵn.
- `src/worker/routes/` và `src/worker/index.ts` — nơi các route khác (T-03,
  T-04) đã đăng ký theo cùng khuôn `app.get/post(...)`; theo đúng khuôn đó khi
  thêm route mới, đừng đổi cấu trúc chung.

## Việc phải làm
1. **`db/crud.ts`** — các hàm query thuần theo resource: `listSkills`,
   `createSkill`, `deleteSkillIfUnused`, `listStaff`, `createStaff`,
   `updateStaff`, `assignSkillToStaff`, `unassignSkillFromStaff`,
   `listServices`, `createService`, `updateService`, `listVariants`,
   `createVariant`, `updateVariant`, `listShifts`, `createShift`,
   `updateShift`, `deleteShift`. Hàm nào cần validate nghiệp vụ (vd "skill có
   đang dùng không") thì query kiểm tra trước, trả kết quả cho route quyết
   định mã lỗi — đừng ném exception SQL thô lên route.
2. **`routes/admin-crud.ts`** — đăng ký toàn bộ endpoint liệt kê ở "Phạm vi
   Trong". Mỗi endpoint:
   - Validate body tối thiểu (tên không rỗng, id tồn tại...) → 422
     `VALIDATION` nếu sai
   - `duration_min <= 0` (variant) → 422 `VALIDATION`
   - `start_min >= end_min` (shift) → 422 `VALIDATION`
   - id không tồn tại khi PATCH/DELETE → 404 `NOT_FOUND`
   - Xoá skill đang được service dùng → 409 (dùng mã có sẵn gần nhất về ý
     nghĩa; nếu không có mã phù hợp trong danh sách đã chốt, dừng lại và báo
     thay vì tự đặt mã mới)
   - Vô hiệu hoá (`PATCH .../staff/:id { active: false }`) chỉ set cột
     `active`, không đụng dòng khác
3. Đăng ký router trong `src/worker/index.ts`.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §3 (không xoá dòng có lịch sử — áp dụng tinh thần
tương tự cho staff/services/variants qua `active`), §4 (schema, không thêm
cột ngoài kế hoạch), §5 (API, mã lỗi), §7 (tách lib khỏi D1 khi có logic
thuần cần test không cần DB), §8 (test), §9 (không mở rộng phạm vi ngoài
`touches`).

Nhấn lại:
- Mã lỗi chỉ lấy trong danh sách PRD §9: `NOT_FOUND`, `VALIDATION`, hoặc mã
  đã có gần nghĩa nhất cho ràng buộc; **cần mã mới → dừng lại, báo trước khi
  tự chế**.
- Không tự thêm cột `room_id`/`branch_id` hay bất kỳ cột nào ngoài schema
  T-02 đã có.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test -- tests/api/admin-crud.test.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/api/admin-crud.test.ts`
- `tạo skill mới thành công và xuất hiện trong danh sách liệt kê`
- `tạo staff mới thành công với active mặc định true`
- `sửa tên staff qua PATCH cập nhật đúng bản ghi, không đụng bản ghi khác`
- `liệt kê service trả kèm đúng skill_id và body_zone đã lưu`
- `tạo variant mới gắn đúng vào service_id đã chỉ định`
- `sửa work_shift đổi đúng start_min/end_min của ca đó`
- `vô hiệu hoá staff (active=false) khiến KTV đó không còn xuất hiện trong kết
  quả availability của bất kỳ ngày nào`
- `xoá một skill không còn service nào dùng thành công`
- `xoá một skill đang được service tham chiếu bị chặn, trả lỗi rõ ràng thay vì
  lỗi SQL thô`
- `tạo variant với duration_min = 0 trả 422 VALIDATION`
- `tạo variant với duration_min âm trả 422 VALIDATION`
- `tạo shift với start_min >= end_min bị chặn, trả 422 VALIDATION`
- `gán một skill cho staff thành công, staff đó xuất hiện trong ứng viên
  availability cho service dùng skill đó`
- `bỏ gán skill khỏi staff thành công, staff đó không còn là ứng viên cho
  service dùng skill đó nữa`
- `sửa staff không tồn tại trả 404 NOT_FOUND`
- `tạo service thiếu tên trả 422 VALIDATION`
- `vô hiệu hoá service (active=false) không xoá variant của nó, chỉ ẩn khỏi
  danh sách active`

## Định nghĩa "xong"
Tạo một staff mới, gán một skill cho staff đó, tạo một work_shift cho staff
trong hôm nay, rồi gọi `GET /api/availability` cho một service dùng đúng skill
đó và thấy staff mới xuất hiện trong danh sách ứng viên — toàn bộ chỉ bằng các
endpoint CRUD vừa viết, không cần chèn dữ liệu tay vào DB.

## Cạm bẫy đã biết
- **Dễ làm lố sang xoá cứng** vì "PATCH active=false" có vẻ vòng vo hơn
  `DELETE`. Đừng — bản ghi có lịch sử (staff đã có booking, service đã có
  variant đã bán) không được xoá cứng, chỉ được ẩn.
- **Validate thiếu khiến dữ liệu rác lọt vào** rồi availability engine (T-03)
  hành xử kỳ lạ ở một chỗ hoàn toàn khác — ví dụ variant `duration_min=0` làm
  mọi slot có độ dài 0, hoặc shift `start_min >= end_min` tạo ra khoảng rảnh
  âm mà thuật toán trừ khoảng không lường trước. Test các case validation
  không phải để làm đẹp, mà để chặn lỗi im lặng ở tầng khác.
- Xoá skill đang dùng mà không chặn sẽ để lại service với `skill_id` mồ côi —
  lỗi này không ném exception ngay, nó âm thầm làm service đó biến mất khỏi
  mọi kết quả availability mà không ai báo.

## Đã làm gì
(agent điền khi xong)
