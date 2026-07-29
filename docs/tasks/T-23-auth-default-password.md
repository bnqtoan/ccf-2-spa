---
id: T-23
title: Bỏ ADMIN_PASSWORD — seed default password + bắt đổi lần đầu
status: todo
model: sonnet
effort: medium
depends_on: [T-22]
touches:
  - migrations/          # 0005: cột must_change_password + seed hash owner cố định
  - src/worker/lib/auth.ts
  - src/worker/routes/auth.ts
  - src/worker/db/seed.ts
  - src/app/              # màn đổi mật khẩu lần đầu
  - vitest.config.ts
  - .dev.vars.example
  - wrangler.jsonc
  - worker-configuration.d.ts
  - docs/DEPLOY.md
  - tests/
prd_refs: ["§2"]
owner: null
started_at: null
finished_at: null
---

# T-23 · Bỏ ADMIN_PASSWORD — default password + bắt đổi lần đầu

## Mục tiêu
`ADMIN_PASSWORD` (env, tàn dư T-19) giờ chỉ dùng seed owner gốc — gây hiểu lầm
(user tưởng login so với nó) và là secret thừa. BỎ HẲN nó. Thay bằng: seed owner
với **default password cố định `admin123`** (hash sẵn trong migration), và **bắt
đổi mật khẩu lần đầu** để default không tồn tại lâu trên production.

## Ngữ cảnh cần biết (product owner đã chốt)
- Login THẬT đã tra bảng `users` + verifyPassword (DB hash) từ T-22 — KHÔNG đụng.
- `ADMIN_PASSWORD` phải BỎ SẠCH: env binding, code đọc, seed đọc, vitest.config
  binding, .dev.vars.example, wrangler.jsonc, worker-configuration.d.ts, DEPLOY.md.
- Owner gốc: username `owner`, default password `admin123`, cờ `must_change_password=1`.
- Đăng nhập với must_change_password=1 → BẮT đổi mật khẩu trước khi vào admin.

## Phạm vi
**Trong:**
- Migration 0005: `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL
  DEFAULT 0`. Seed owner: hash PBKDF2 của `admin123` (tính sẵn, nhét literal vào
  migration HOẶC seed.ts sinh) + must_change_password=1.
- BỎ ADMIN_PASSWORD: khỏi wrangler.jsonc, worker-configuration.d.ts Env,
  vitest.config bindings, .dev.vars.example. Seed.ts KHÔNG đọc ADMIN_PASSWORD nữa
  — dùng default 'admin123' cố định.
- Login response mang `must_change_password`; nếu =1, SPA CHUYỂN sang màn "đổi mật
  khẩu" (không cho vào admin tới khi đổi). API POST /api/auth/change-password
  (đang đăng nhập, đổi password của CHÍNH mình → set must_change_password=0).
- Test hardcode 'dev-admin-password'/'test-admin-pw' → đổi sang 'admin123' cho khớp.
- DEPLOY.md: bỏ bước `wrangler secret put ADMIN_PASSWORD`; ghi rõ owner/admin123 +
  bắt đổi lần đầu.

**Ngoài:**
- KHÔNG đụng RBAC/row-filter (T-22 giữ nguyên). KHÔNG multi-tenant.
- KHÔNG quên-mật-khẩu qua email (owner khác reset qua UI quản lý user — đã có T-22).

## Đầu vào đã có
- `SEED_USERS` (seed.ts:31), `hashPassword`/`verifyPassword` (lib/auth.ts:224,235).
- `users` table (0004). Login route auth.ts (tra users). SESSION_SECRET giữ nguyên.
- 14 chỗ dùng ADMIN_PASSWORD (grep) — bỏ hết.

## Việc phải làm
1. Migration 0005: cột must_change_password + đảm bảo owner seed có nó=1.
2. seed.ts: bỏ readDevVar('ADMIN_PASSWORD'); dùng const DEFAULT_PW='admin123'.
   owner must_change_password=1; reception/ktv (seed dev) =0.
3. Login: trả must_change_password. change-password endpoint.
4. SPA: sau login nếu must_change → màn đổi mật khẩu, chặn vào admin.
5. Bỏ ADMIN_PASSWORD khỏi mọi config/env/test.
6. DEPLOY.md cập nhật.

## Quy ước bắt buộc (CONVENTIONS)
- §5: mã lỗi cũ. §7: route 1 dòng. §8: test D1 thật. §9: không nới assertion.
- Migration 0005 additive trên 0004.

## Checklist đầu ra
- [ ] typecheck xanh · npm test xanh · e2e --workers=1 xanh
- [ ] grep ADMIN_PASSWORD trên src/ + config = RỖNG (chỉ còn trong card cũ/docs lịch sử OK)
- [ ] status review + "Đã làm gì"

## Test phải viết
- `login owner/admin123 lần đầu → must_change_password=1 trong response`
- `chưa đổi mật khẩu → gọi /api/admin/* vẫn 401/redirect đổi mật khẩu` (nếu chọn chặn cứng)
- `change-password đổi thành công → must_change_password=0, login lại bằng mk mới OK`
- `change-password mật khẩu cũ sai → 401`
- `không còn ADMIN_PASSWORD: login KHÔNG phụ thuộc env đó (bỏ binding vẫn login được)`

## Định nghĩa "xong"
Không còn `ADMIN_PASSWORD` ở bất kỳ đâu (env/code/config/test); owner đăng nhập
`owner/admin123` lần đầu bị bắt đổi mật khẩu; sau đổi, login bằng mật khẩu mới.

## Cạm bẫy đã biết
- Bỏ ADMIN_PASSWORD khỏi vitest.config + .dev.vars → nhiều test auth/rbac hardcode
  giá trị đó sẽ đỏ. Đổi hết sang 'admin123'. KIỂM auth.setup.ts, rbac.spec.ts,
  admin-auth.spec.ts, _authCookie.ts, auth.test.ts.
- Hash PBKDF2 của 'admin123' phải tính đúng thuật toán hashPassword() hiện có
  (format `pbkdf2$...`). Đừng nhét hash sai format → verify luôn fail.
- .dev.vars đang có ADMIN_PASSWORD → bỏ, và cập nhật .dev.vars.example đồng bộ.

## Đã làm gì
(agent điền khi xong)
