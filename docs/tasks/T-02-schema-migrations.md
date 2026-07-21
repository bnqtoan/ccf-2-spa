---
id: T-02
title: Schema D1 + migrations + seed data
status: done
model: sonnet
effort: medium
depends_on: ["T-01"]
touches:
  - migrations/
  - src/worker/db/types.ts
  - src/worker/db/seed.ts
  - tests/api/schema.test.ts
  - package.json
prd_refs: ["§3.2", "§3.3", "§3.4"]
owner: null
started_at: null
finished_at: "2026-07-21"
---

# T-02 · Schema D1 + migrations + seed data

## Mục tiêu
Tạo toàn bộ bảng theo PRD §3.2 kèm index phục vụ truy vấn availability, và một
bộ seed đủ phong phú để mọi task sau test được tình huống thật (KTV nhiều skill,
service nhiều variant, ca làm việc, booking sẵn có).

## Ngữ cảnh cần biết
Schema đã chốt trong PRD §3.2. Hai điểm dễ làm sai:

1. **`booking_items` có cả `end_at` lẫn `block_end_at`.** Không phải dư thừa:
   `end_at` để hiển thị cho khách, `block_end_at` (= end + buffer) để kiểm tra
   rảnh/bận. Tách hai cột là thứ ngăn buffer bị quên trong join.
2. **Không thêm `room_id` / `branch_id`.** PRD §1 quyết định rõ: cột null không
   ai đọc là nợ chết. Đường migration v2 ở PRD §12.

`customers.phone` nullable — khách lẻ vãng lai chỉ có tên.

## Phạm vi
**Trong:**
- Migration SQL tạo 10 bảng: `skills`, `staff`, `staff_skills`, `services`,
  `service_variants`, `work_shifts`, `time_off`, `customers`, `appointments`,
  `booking_items`
- Index cho truy vấn nóng (xem "Việc phải làm")
- CHECK constraint cho `status`, `source`, `body_zone`
- TypeScript types khớp schema (`src/worker/db/types.ts`)
- Seed script + dữ liệu mẫu
- Test khẳng định schema và constraint hoạt động

**Ngoài:**
- Không viết query nghiệp vụ (T-03+ làm)
- Không viết route API
- Không tạo ORM/query builder — dùng D1 prepared statements trực tiếp

## Đầu vào đã có
- T-01 để lại: `wrangler.jsonc` có binding `DB`, vitest chạy được với D1 thật
- `docs/PRD.md` §3.2 (schema), §3.3 (status), §3.4 (body_zone)

## Việc phải làm
1. `migrations/0001_init.sql` — tạo bảng đúng PRD §3.2. Dùng
   `INTEGER PRIMARY KEY AUTOINCREMENT` cho id; timestamp là `INTEGER` (epoch giây).
2. CHECK constraints:
   - `appointments.status`, `booking_items.status` ∈
     `('booked','in_service','done','cancelled','no_show')`
   - `appointments.source` ∈ `('online','walk_in','admin')`
   - `services.body_zone` ∈ `('hair','hands','feet','face','body')`
   - `work_shifts.weekday` BETWEEN 0 AND 6
   - `work_shifts.start_min < end_min`
3. Foreign keys với `ON DELETE RESTRICT` (không xoá dữ liệu có lịch sử).
4. Index — đây là các truy vấn nóng của availability engine:
   - `booking_items(staff_id, start_at)` — quét lịch bận của một KTV
   - `booking_items(appointment_id)`
   - `time_off(staff_id, start_at)`
   - `work_shifts(staff_id, weekday)`
   - `staff_skills(skill_id)` — tìm KTV theo skill
   - `customers(phone)` — tra cứu của khách
   - `appointments(start_at)` — day view của admin
5. `src/worker/db/types.ts` — interface cho từng bảng + union type cho status /
   source / body_zone.
6. `src/worker/db/seed.ts` — seed dữ liệu, gọi được từ test và từ CLI:
   - 4 skill: Massage, Tóc, Móng, Da mặt
   - 5 KTV, skill chồng chéo (ít nhất 1 người 2 skill, 1 người chỉ 1 skill)
   - 4 service × 2 variant, buffer khác nhau (5/10/15 phút)
   - Ca làm việc 09:00–19:00 cho các ngày trong tuần
   - Vài booking sẵn để test overlap
7. Script npm `db:migrate:local` và `db:seed:local`.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §1 (thời gian), §3 (trạng thái), §4 (schema).

Nhấn lại: `work_shifts.start_min/end_min` là **phút từ nửa đêm giờ địa phương**
(0–1440), khác hoàn toàn với epoch seconds ở các bảng khác. Đặt tên cột đã phân
biệt rồi (`_min` vs `_at`) — giữ nguyên quy ước đó.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test -- tests/api/schema.test.ts` xanh
- [ ] `npm run db:migrate:local` chạy sạch trên DB rỗng
- [ ] `npm run db:seed:local` chạy được, chạy 2 lần không vỡ
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/api/schema.test.ts`
- `migration tạo đủ 10 bảng`
- `chèn booking_items với status lạ bị CHECK constraint chặn`
- `chèn appointments với source lạ bị chặn`
- `chèn services với body_zone lạ bị chặn`
- `chèn work_shifts với weekday = 7 bị chặn`
- `chèn work_shifts với start_min >= end_min bị chặn`
- `customers.phone chấp nhận NULL (khách lẻ)`
- `không xoá được staff đang có booking_items (FK RESTRICT)`
- `seed chạy xong có đủ 4 skill, 5 KTV, 8 variant`
- `mỗi service trỏ tới skill có thật`

## Định nghĩa "xong"
Chạy migration trên DB rỗng rồi seed, sau đó truy vấn được: "các KTV có skill
Massage đang có ca làm thứ Hai" bằng một câu SQL join qua `staff_skills` và
`work_shifts` — trả về đúng số người mà seed đã tạo.

## Cạm bẫy đã biết
- D1 **không bật foreign key enforcement mặc định trong mọi ngữ cảnh**. Viết một
  test khẳng định FK thật sự chặn; nếu không chặn, ghi rõ vào "Đã làm gì" thay vì
  im lặng bỏ qua — task sau cần biết ràng buộc nào là thật.
- Đừng gộp `end_at` và `block_end_at` thành một cột "cho gọn". Đó chính là lỗi
  PRD §3.1 viết ra để phòng.
- Seed phải idempotent hoặc tự xoá sạch trước khi chèn; test chạy nhiều lần mà
  seed cộng dồn sẽ làm test khác đỏ theo cách rất khó truy.
- `AUTOINCREMENT` trong SQLite yêu cầu `INTEGER PRIMARY KEY` chính xác, không
  phải `INT`.

## Đã làm gì

**PHÁT HIỆN QUAN TRỌNG — FK CÓ ENFORCE THẬT (khác giả định mặc định của card):**
Trong ngữ cảnh test hiện tại (`@cloudflare/vitest-pool-workers` 0.18.6, D1 local
qua Miniflare), `PRAGMA foreign_keys` **đã bật sẵn**. Verify bằng test thật:
insert `staff` → `booking_items` rồi `DELETE FROM staff WHERE id = ?` ném lỗi
`FOREIGN KEY constraint failed (SQLITE_CONSTRAINT_TRIGGER)` — không bị bỏ qua
âm thầm. `ON DELETE RESTRICT` khai báo trong schema là ràng buộc **runtime
thật**, không chỉ là tài liệu ý định, ít nhất trong D1 local/test. Hành vi trên
D1 remote/production chưa được xác nhận riêng ở task này — T-03+ nên tự chặn
xoá staff ở tầng ứng dụng (soft delete qua `active = 0`) thay vì dựa hoàn toàn
vào DB backstop, phòng khi remote khác local.

**Gotcha quan trọng khác — `vitest-pool-workers` không tự áp migration:**
`wrangler.jsonc`'s `migrations_dir` chỉ được đọc bởi CLI `wrangler d1
migrations`, KHÔNG được `cloudflareTest()` tự áp cho D1 binding trong test.
`tests/api/schema.test.ts` phải tự nạp `migrations/0001_init.sql` (qua Vite
`?raw` import + một hàm tách statement tối giản dựa trên `;` và `--` comment,
viết tay — không import package `wrangler` vào trong worker test vì nó crash
runtime workerd) và chạy trong `beforeAll`. Đã verify thực nghiệm: D1 storage
được **share giữa các `it()` trong cùng một file test** (không phải isolate
từng test), nên `beforeAll` chạy migration một lần là đủ; mỗi test vẫn tự
seed/cleanup dữ liệu riêng theo CONVENTIONS §8.

**CLI seed (`db:seed:local`) không có D1 binding ngoài Worker:** giải quyết
bằng cách `seed.ts` export `buildSeedStatements()` (list SQL + params, dùng
subquery theo tên tự nhiên thay vì id cứng — an toàn khi bảng bị xoá sạch rồi
insert lại nhiều lần) làm nguồn sự thật duy nhất; `seed(db)` (dùng trong test)
chạy statement đó qua binding D1 thật, còn CLI (`node
--experimental-strip-types src/worker/db/seed.ts`, chạy được nhờ Node 22 hỗ
trợ strip-types và file không có runtime import nào ngoài ambient type) inline
cùng dữ liệu đó thành SQL literal rồi gọi `wrangler d1 execute DB --local
--file=`. Đã verify: migrate sạch trên DB rỗng (18 lệnh), seed chạy 2 lần liên
tiếp không đổi số dòng (4 skill / 5 KTV / 8 variant / 2 booking_items), và câu
query "KTV có skill Massage đang có ca thứ Hai" trả đúng 2 người (Lan, Huong)
đúng như seed tạo.

Migration `0001_init.sql` tạo đủ 10 bảng + 8 index theo PRD §3.2, CHECK
constraint cho status/source/body_zone/weekday/start_min<end_min, FK toàn bộ
dùng `ON DELETE RESTRICT`. `end_at` và `block_end_at` giữ tách biệt trong
`booking_items` như PRD §3.1 yêu cầu — không gộp.

`npm run typecheck`, `npm test` (14 test: 2 smoke + 12 schema), `npm run
db:migrate:local`, `npm run db:seed:local` (chạy 2 lần) đều xanh. `npm run
e2e` cũng xanh (13 test, không liên quan phạm vi task này — không đụng gì
ngoài `touches`).
