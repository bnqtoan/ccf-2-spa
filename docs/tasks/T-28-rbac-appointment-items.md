---
id: T-28
title: Fix RBAC gap — gate POST /appointments/:id/items (owner+receptionist)
status: todo
model: sonnet
effort: low
depends_on: [T-22]
touches:
  - src/worker/routes/index.ts
  - tests/
prd_refs: ["§2"]
owner: null
started_at: null
finished_at: null
---

# T-28 · Fix RBAC gap — gate POST /appointments/:id/items

## Mục tiêu
T-22 (RBAC) gate các cụm route nhưng BỎ SÓT `POST /api/admin/appointments/:id/items`
(thêm item combo vào appointment). Route này chỉ qua `adminAuthGuard` (đăng nhập)
mà KHÔNG có `requireRoleMw` → **technician gọi thẳng API thêm item cho appointment
của KTV khác được** (dù UI ẩn nút). Đây là lỗ hổng RBAC thật, cùng họ silent-side-
effect T-22 đã cẩn thận với route khác. Phát hiện khi làm T-25.

## Ngữ cảnh cần biết
- Thao tác này thuộc VẬN HÀNH → owner + receptionist làm được, technician KHÔNG
  (technician chỉ dữ liệu của mình; thêm item cho appointment bất kỳ là vượt quyền).
- Gate ở registerRoutes (CONVENTIONS §7 "một chỗ") như các route owner-only đã làm,
  nhưng đây là owner+receptionist (không phải owner-only).

## Phạm vi
**Trong:**
- `routes/index.ts`: thêm `app.use('/api/admin/appointments/*', requireRoleMw('owner',
  'receptionist'))` (hoặc match đúng path POST items) TRƯỚC route tương ứng. Kiểm
  requireRoleMw đã hỗ trợ nhiều role (T-22 có requireRoleMw('owner') — xác nhận nó
  nhận ...roles variadic; nếu chưa, mở rộng trong lib/auth.ts — nhưng ưu tiên đã có).
- Test: technician gọi POST /appointments/:id/items → 403; owner+receptionist → OK.

**Ngoài:**
- KHÔNG đụng logic appointment-items (chỉ thêm gate). KHÔNG đổi RBAC route khác.

## Đầu vào đã có
- `requireRoleMw` (routes/auth.ts hoặc lib/auth.ts) — T-22. Kiểm signature variadic.
- Pattern gate ở registerRoutes (T-22: app.use('/api/admin/overview', requireRoleMw('owner'))).

## Việc phải làm
1. Gate route appointment-items cho owner+receptionist ở registerRoutes (1 dòng).
2. Test 403-technician + 200-owner/reception.

## Quy ước bắt buộc
- §5 FORBIDDEN 403. §7 gate 1 dòng registerRoutes. §8/§9.

## Checklist đầu ra
- [ ] typecheck · npm test · e2e --workers=1 xanh
- [ ] status review + "Đã làm gì"

## Test phải viết
- `technician POST /api/admin/appointments/:id/items → 403 FORBIDDEN`
- `receptionist POST → 200/201 (được phép)`
- `owner POST → 200/201`

## Định nghĩa "xong"
Technician KHÔNG gọi được `POST /appointments/:id/items` qua API (403); owner +
receptionist vẫn được. Bịt lỗ hổng technician-lạm-quyền qua API trực tiếp.

## Cạm bẫy đã biết
- Đây là SERVER gate (UI ẩn nút KHÔNG đủ — T-25 chỉ ẩn UI). Phải test qua API trực tiếp.
- Kiểm requireRoleMw nhận nhiều role; nếu chỉ nhận 1, mở rộng cẩn thận (T-22 test còn xanh).

## Đã làm gì
(agent điền khi xong)
