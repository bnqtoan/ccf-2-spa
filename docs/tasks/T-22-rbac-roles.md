---
id: T-22
title: RBAC 3 vai trò (owner/receptionist/technician) — filter-by-role
status: todo            # todo | in_progress | review | done | blocked
model: opus             # sai-thì-im-lặng (technician thấy/sửa dữ liệu người khác)
effort: high
depends_on: [T-19]      # mở rộng session payload + guard của T-19
touches:
  - migrations/          # 0004: bảng users + staff.user_id
  - src/worker/lib/auth.ts
  - src/worker/routes/auth.ts
  - src/worker/routes/index.ts
  - src/worker/routes/admin-schedule.ts
  - src/worker/routes/admin-status.ts
  - src/worker/routes/admin-timeoff.ts
  - src/worker/routes/admin-overview.ts
  - src/worker/routes/admin-crud.ts
  - src/worker/db/seed.ts
  - src/app/                # login, nav theo role, guard
  - tests/
prd_refs: ["§2"]        # PRD §2 loại RBAC khỏi v1 — task này ĐƯA RBAC vào; cập nhật PRD
owner: null
started_at: null
finished_at: null
---

# T-22 · RBAC 3 vai trò — filter-by-role

## Mục tiêu
App hiện auth một-cổng-chung (T-19): ai đăng nhập cũng thấy MỌI thứ — lễ tân thấy
doanh thu/lương, mọi người sửa được lịch của mọi KTV. Task này thêm **phân quyền
theo vai trò**: một hệ auth duy nhất, `role` quyết định thấy/làm được gì.

Ba vai trò:
- **owner** (chủ spa): toàn quyền — dashboard tiền/lương, thiết lập, mọi vận hành, quản lý user.
- **receptionist** (lễ tân): mọi vận hành (đặt/huỷ/walk-in/reassign/báo nghỉ, đổi status)
  NHƯNG **không** thấy doanh thu/lương, **không** sửa giá/dịch vụ.
- **technician** (KTV): **chỉ dữ liệu của chính mình** — lịch mình, tự báo nghỉ,
  đổi status booking CỦA MÌNH; không thấy lịch KTV khác/tiền toàn spa/thiết lập.

## Ngữ cảnh cần biết (quyết định product owner đã chốt)
- **MỘT hệ auth, MỘT bảng `users`.** KHÔNG hai hệ auth, KHÔNG nhét password vào
  `staff`. `staff` giữ nguyên bản chất "người cung cấp dịch vụ".
- Authorization = **lọc theo role**, không phải chặn cả cụm. Ba hình dạng:
  - role-gate cả route (owner-only): doanh thu, lương, thiết lập giá.
  - row-filter (technician chỉ thấy của mình): schedule, báo nghỉ.
  - ownership-check (technician chỉ sửa của mình): đổi status booking.
- **Seed 1 owner gốc** (mật khẩu lần đầu từ secret ADMIN_PASSWORD), owner tự thêm
  user sau qua UI.
- Lễ tân **làm mọi vận hành** (có giá hiện khi đặt) — chỉ ẨN báo cáo tiền + khoá sửa giá.
- KTV **được** tự đổi status booking của mình (row-level).

## Phạm vi
**Trong:**
- Migration 0004: bảng `users(id, username UNIQUE, password_hash, role CHECK IN
  ('owner','receptionist','technician'), staff_id REFERENCES staff(id) nullable,
  active DEFAULT 1)`. `staff_id` set CHỈ cho technician (trỏ tới dòng staff của họ).
- Mở rộng session payload T-19: thêm `userId, role, staffId` (ký HMAC như cũ →
  client không giả được role). Guard verify → `c.set('user', {userId,role,staffId})`.
- `requireRole(...roles)` middleware → 403 FORBIDDEN nếu role không thuộc danh sách.
- Login: đổi từ mật-khẩu-chung sang `username + password` tra bảng users (hash so
  khớp constant-time). Trả role trong session + GET /api/auth/session trả role.
- Áp quyền:
  - **owner-only** (requireRole('owner')): admin-overview (doanh thu/lương),
    admin-crud sửa/thêm/xoá services+variants+skills (bảng giá), quản lý users.
  - **owner+receptionist**: timeline, walk-in, reassign, báo nghỉ, đổi status, CRUD staff/shifts.
  - **technician row-filter**: GET schedule → chỉ booking của mình; báo nghỉ → chỉ
    cho staff_id của mình; đổi status → ownership-check (booking.staff_id === user.staffId
    else 403).
- Quản lý user: owner thêm/sửa/vô hiệu user + gán role + (với technician) link staff_id.
  API + UI trong Thiết lập.
- SPA: nav hiện theo role (ẩn mục không có quyền — defense-in-depth, server mới là gate thật);
  trang login username+password; guard route theo role.
- Seed: 1 owner (username 'owner', password = ADMIN_PASSWORD lần đầu).

**Ngoài:**
- KHÔNG multi-tenant (vẫn 1 spa). KHÔNG đổi mật khẩu qua email/OTP (owner đặt lại tay).
- KHÔNG audit-log ai-làm-gì (task riêng nếu cần).
- KHÔNG đụng luồng KHÁCH (public) và webhook payment.

## Đầu vào đã có
- `src/worker/lib/auth.ts`: `SessionPayload` (hiện chỉ `exp`), `issueSessionToken`,
  `verifySessionToken`, HMAC helpers — MỞ RỘNG, đừng viết lại.
- `src/worker/routes/auth.ts`: `adminAuthGuard` (verify, hiện CHƯA `c.set('user')`
  — phải thêm), route login/logout/session.
- `admin-schedule.ts:88-101`: query đã JOIN staff; chèn `AND bi.staff_id = ?` khi
  role=technician (giữ nguyên kỹ thuật tránh giới hạn 100 param).
- `admin-status.ts:26 loadItem`: hiện SELECT id,status — thêm `staff_id` để ownership-check.
- `admin-timeoff.ts`: POST /api/admin/time-off — technician chỉ tạo cho staff_id mình.
- `staff` table: technician-user link qua users.staff_id.
- T-19 secrets: ADMIN_PASSWORD (giờ = mật khẩu owner gốc), SESSION_SECRET.

## Việc phải làm
1. Migration 0004: bảng users + seed owner gốc trong seed.ts (username 'owner',
   hash của ADMIN_PASSWORD). Password hash: PBKDF2/SHA-256 qua crypto.subtle
   (Workers có sẵn) — KHÔNG bcrypt (không có trong Workers runtime).
2. Mở rộng SessionPayload + issue/verify: {userId, role, staffId?, exp}. Guard set
   `c.get('user')`.
3. `requireRole(...roles)` trong lib/auth.ts (thuần, test được).
4. Đổi login: username+password → tra users → hash khớp → issue session mang role.
5. Áp 3 hình dạng quyền lên các route (danh sách ở Phạm vi). Mỗi route owner-only
   thêm `requireRole('owner')`. Mỗi row-filter/ownership-check đọc `c.get('user')`.
6. API quản lý user (owner): GET/POST/PATCH /api/admin/users (+ gán role, link staff).
7. SPA: login username+password; nav lọc theo role; guard route.
8. Cập nhật PRD §2 (RBAC giờ CÓ trong sản phẩm).

## Quy ước bắt buộc
Từ CONVENTIONS.md:
- **§5 API:** mã lỗi hợp lệ — thêm `FORBIDDEN` (403) vào danh sách (UNAUTHORIZED 401
  đã có ở T-19). 401 = chưa đăng nhập; 403 = đăng nhập rồi nhưng không đủ quyền.
- **§7:** route đăng ký ĐÚNG MỘT dòng ở registerRoutes; guard/requireRole mount
  cùng chỗ, KHÔNG sửa src/worker/index.ts.
- **§8:** test API trong workerd + D1 thật; migrate+seed trước.
- **§9 + BOARD:** không nới/xoá assertion; agent không tự đặt `done`, cao nhất `review`.
- Logic auth/role thuần ở lib/auth.ts (không query DB) — route lo load user + gọi.

## Checklist đầu ra
- [ ] Typecheck `npm run typecheck` xanh
- [ ] Test API + unit xanh (gồm test RBAC mới)
- [ ] Test E2E xanh (--workers=1) — 3 role đăng nhập thấy đúng phạm vi
- [ ] Không đụng luồng khách + webhook payment
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at` + "Đã làm gì"

## Test phải viết (tên từng case — mỗi case một hành vi nghiệp vụ)
Unit (lib/auth.ts thuần):
- `requireRole cho qua khi role thuộc danh sách, chặn 403 khi không`
- `session payload mang role/staffId ký-verify đúng, sửa role trong token → verify fail`
- `hash mật khẩu: đúng khớp, sai không khớp, constant-time`
API (workerd + D1):
- `owner GET /api/admin/overview → 200; receptionist → 403; technician → 403`
- `receptionist sửa giá variant → 403; owner → 200`
- `technician GET /api/admin/schedule → CHỈ booking của staff_id mình (không thấy KTV khác)`
- `receptionist/owner GET schedule → thấy MỌI KTV`
- `technician đổi status booking CỦA MÌNH → 200`
- `technician đổi status booking CỦA KTV KHÁC → 403 (KHÔNG được đụng — silent side-effect nếu thiếu)`
- `technician tạo time-off cho chính mình → 200; cho KTV khác → 403`
- `owner tạo user mới role=receptionist → user login được, thấy đúng phạm vi`
- `login username+password: đúng → session mang role; sai password → 401; user inactive → 401`
- `route KHÁCH + webhook payment KHÔNG cần role, vẫn chạy (không bị RBAC đụng)`
E2E:
- `3 role đăng nhập: nav + trang thấy đúng phạm vi (technician không thấy nav thiết lập/dashboard)`
- `technician mở timeline chỉ thấy cột của mình`

## Định nghĩa "xong"
Ba vai trò đăng nhập vào cùng một hệ, mỗi vai trò chỉ thấy/làm được đúng phạm vi
của mình — technician KHÔNG cách nào đọc/sửa dữ liệu KTV khác (kiểm bằng test
ownership-check, không chỉ ẩn UI); khách + webhook payment không bị ảnh hưởng.

## Cạm bẫy đã biết
- **SILENT SIDE-EFFECT (nguy hiểm nhất):** quên ownership-check ở đổi-status/báo-nghỉ
  → technician A sửa được booking của B mà UI vẫn "trông đúng". PHẢI test case
  "đụng của người khác → 403" cho MỌI route technician chạm. Ẩn UI KHÔNG đủ — server là gate.
- **role trong session, KHÔNG trong query param/header:** client không được tự khai role.
  Chỉ tin role từ payload đã ký HMAC.
- **Không có bcrypt trong Workers:** dùng crypto.subtle PBKDF2. Đừng import lib Node.
- **owner-only trên admin-crud phải TÁCH:** CRUD staff/shifts = owner+receptionist OK,
  nhưng services/variants/skills (bảng giá) = owner-only. Đừng gate cả admin-crud một cục.
- **Đừng chặn nhầm webhook payment** (tự xác thực Apikey, KHÔNG qua RBAC admin).
- Migration 0004 phải additive (users là bảng mới; staff thêm cột? KHÔNG — link qua
  users.staff_id, staff KHÔNG đổi). Áp sạch trên 0003.

## Đã làm gì
(agent điền khi xong)
