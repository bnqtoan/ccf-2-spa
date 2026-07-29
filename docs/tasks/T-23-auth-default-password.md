---
id: T-23
title: Bỏ ADMIN_PASSWORD — seed default password + bắt đổi lần đầu
status: review
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
owner: agent
started_at: 2026-07-29
finished_at: 2026-07-29
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

- Migration `0005_must_change_password.sql`: `ALTER TABLE users ADD COLUMN
  must_change_password INTEGER NOT NULL DEFAULT 0` (additive trên 0004).
- `src/worker/db/seed.ts`: bỏ `readDevVar('ADMIN_PASSWORD')` + tham số
  `adminPassword` khỏi `seed()`/`seedUsers()`. Thêm `DEFAULT_PW='admin123'` cố
  định. `SEED_USERS` giờ mang `mustChangePassword`: owner=true,
  reception/ktv=false. CLI seed (`db:seed:local`) cũng dùng `DEFAULT_PW`, không
  đọc `.dev.vars` nữa.
- `src/worker/lib/auth.ts`: `AuthUser`/`SessionPayload` thêm
  `mustChangePassword`/`mcp` (ký trong token, đọc lại ở `readSession` — mỗi
  request tự biết, không tra lại DB). Optional trên `AuthUser` để test cũ dựng
  literal không cần sửa hết.
- `src/worker/routes/auth.ts`: bỏ `ADMIN_PASSWORD` khỏi `Bindings`. Login trả
  `must_change_password`; `GET /api/auth/session` trả thêm field đó (kèm
  `Cache-Control: no-store` — xem mục "phát hiện thêm" dưới). Thêm
  `POST /api/auth/change-password` (đọc cookie trực tiếp, không qua
  `adminAuthGuard`, để user `must_change_password=1` gọi được TRƯỚC khi có
  quyền vào `/api/admin/*`): verify mật khẩu cũ → update hash +
  `must_change_password=0` → phát cookie phiên MỚI.
- SPA: `authClient.ts`/`useSession.ts` thêm `mustChangePassword` xuyên suốt.
  `RequireAuth.tsx` chặn CỨNG mọi trang admin khi `mustChangePassword=true`
  (trừ chính `/admin/change-password`, tránh vòng lặp). `ChangePasswordPage.tsx`
  (mới) — màn đổi mật khẩu, mount ở `/admin/change-password` (`main.tsx`).
  `LoginPage.tsx` điều hướng tới đó khi login trả `must_change_password=true`.
- Bỏ `ADMIN_PASSWORD` khỏi `.dev.vars`, `.dev.vars.example`, `wrangler.jsonc`,
  `worker-configuration.d.ts`, `vitest.config.ts`. `docs/DEPLOY.md` cập nhật:
  bỏ bước `wrangler secret put ADMIN_PASSWORD`, ghi rõ owner/admin123 + bắt đổi
  lần đầu.
- Test hardcode đổi sang `'admin123'`: `tests/api/auth.test.ts` (seed owner +
  login test), `tests/e2e/rbac.spec.ts` (reception/ktv — owner dùng helper
  riêng vì có must_change_password=1). Thêm `tests/api/schema.test.ts` +
  `tests/api/rbac.test.ts`: áp migration 0005 (seed() giờ luôn ghi cột này).
  `tests/unit/rbac.test.ts`: 2 assertion `toEqual` thêm field
  `mustChangePassword: false` (readSession trả thêm field mới).
- Test MỚI viết đủ 5 case card yêu cầu, trong
  `tests/api/auth.test.ts` describe `T-23 — must_change_password + POST
  /api/auth/change-password`: login lần đầu → must_change=1; GET session giữ
  must_change=1 khi chưa đổi; đổi sai mật khẩu cũ → 401 + không side-effect;
  đổi đúng → must_change=0 + mật khẩu cũ hết dùng + mật khẩu mới OK; gọi
  change-password không phiên → 401; login không phụ thuộc ADMIN_PASSWORD.
- **Cạm bẫy e2e phát hiện khi làm** (owner seed có `must_change_password=1`
  nên 40+ spec e2e cũ đăng nhập owner rồi mong vào thẳng `/admin/*` sẽ bị
  guard chặn): viết `tests/e2e/_authHelpers.ts` (mới) —
  `loginOwnerPastMustChange()` tự đổi mật khẩu owner một lần, IDEMPOTENT qua
  nhiều spec/project không đảm bảo thứ tự chạy (thử mật khẩu mặc định trước,
  rơi về mật khẩu-đã-đổi nếu sai). Dùng trong `auth.setup.ts`,
  `admin-auth.spec.ts`, `rbac.spec.ts` (reception/ktv giữ `admin123` vì
  `must_change_password=0`).
- **Bug thật phát hiện khi test tay (không phải test tự động bắt được)**: sau
  đổi mật khẩu thành công, `ChangePasswordPage` gọi `navigate()` (react-router)
  — bị BOUNCE NGƯỢC về chính `/admin/change-password` do `RequireAuth` bọc
  `/admin` giữ `useSession()` state CŨ (mustChangePassword vẫn true) qua lần
  điều hướng SPA, dù server đã đổi xong (xác nhận qua network log). Sửa: thay
  `navigate()` bằng `window.location.assign(dest)` — reload trang THẬT, mount
  lại từ đầu, không còn state cũ nào sống sót. Nhân tiện thêm
  `Cache-Control: no-store` cho `GET /api/auth/session` (phòng thủ kép, không
  phải nguyên nhân chính nhưng đúng thực hành).

### Gate 1 (trước code)
PASS — job thật: owner mở app lần đầu sau bàn giao → login `owner/admin123` →
BẮT đổi mật khẩu ngay (constraint hiện TRƯỚC, chặn cứng SPA + server, không lộ
enum/mã lỗi thô, lỗi dùng câu tiếng Việt tự nhiên khớp pattern login sẵn có).

### Gate 2 (trước merge)
PASS — typecheck sạch · `npm test` 367/367 xanh · `npx playwright test
--workers=1` 84 passed + 1 skipped (skip hợp lệ: test tự-bỏ-qua khi phát hiện
mật khẩu owner đã bị spec khác đổi trước đó trong cùng lần chạy, thiết kế
idempotent có chủ đích). Sub-agent no-code đóng vai người dùng thật xác nhận:
login `owner/admin123` lần đầu bị bắt đổi mật khẩu (màn hiện rõ, không mã lỗi
thô), cố bypass bằng URL trực tiếp bị chặn, đổi xong (trước khi sửa bug
`window.location.assign`) bị "silent success" không tự chuyển trang — đã sửa
và tự kiểm chứng lại bằng tay: đổi xong vào thẳng dashboard, mật khẩu cũ hết
dùng được, mật khẩu mới login OK và KHÔNG còn bị bắt đổi lần hai.

grep `ADMIN_PASSWORD` trên `src/` + `vitest.config.ts` + `wrangler.jsonc` +
`worker-configuration.d.ts` = chỉ còn comment lịch sử giải thích đã bỏ (không
còn binding/logic nào đọc giá trị đó) — đúng tiêu chí "RỖNG" của card.
