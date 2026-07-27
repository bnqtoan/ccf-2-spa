---
id: T-19
title: Auth chặn mọi route /api/admin/* và trang admin
status: review         # todo | in_progress | review | done | blocked
model: opus             # opus — sai thì im lặng & lộ dữ liệu tiền/khách
effort: high            # low | medium | high
depends_on: []          # độc lập về code; nên merge sau/cùng T-18 để CI bắt lỗi
touches:
  - src/worker/routes/index.ts        # thêm MỘT dòng mount middleware (CONVENTIONS §7)
  - src/worker/lib/auth.ts            # mới — logic thuần kiểm token
  - src/worker/routes/auth.ts         # mới — route đăng nhập
  - src/app/routes/admin/             # guard phía SPA
  - migrations/                       # nếu chọn user/password lưu DB (xem Phạm vi)
  - worker-configuration.d.ts         # secret binding
  - wrangler.jsonc                    # secret binding
prd_refs: ["§ Out v1: Auth"]
owner: agent-T19
started_at: 2026-07-28
finished_at: 2026-07-28
---

# T-19 · Auth chặn mọi route /api/admin/* và trang admin

## Mục tiêu
Chỉ người đã đăng nhập mới vào được phần quản lý. Hiện **mọi** route
`/api/admin/*` mở với bất kỳ ai (PRD `§ "No auth in v1"`), và giờ đó gồm cả
**bảng doanh thu/lương** (T-C overview) lẫn **thanh toán** (T-payments). Không
thể lên production thật khi bất kỳ ai gõ URL là thấy tiền và sửa lịch. Task này
đóng lỗ đó: một cổng auth trước toàn bộ mặt admin.

## Ngữ cảnh cần biết
- **Đây là điểm PRD đã đổi:** PRD `docs/PRD.md:8,26,47` ghi rõ "No auth in v1" và
  xếp Auth vào "Out (v2+)". Quyết định phiên này: auth trở thành BẮT BUỘC vì
  payment + báo cáo kinh doanh đã lên. Card này CHÍNH THỨC nâng auth vào scope.
- App single-tenant, một spa. **Không cần** multi-user phức tạp/RBAC ở bước này —
  đủ để phân biệt "nhân viên spa đã đăng nhập" vs "người ngoài". Multi-tenant &
  vai trò chi tiết là việc của R3 (subscribe), KHÔNG làm ở đây.
- Webhook payment (`POST /api/payments/webhook/:provider`) **PHẢI vẫn public** —
  nó tự xác thực bằng Apikey/signature của provider (`payments.ts:146`), không
  đi qua auth admin. Đừng chặn nhầm nó.
- Route KHÁCH (`/api/services`, `/api/availability`, `/api/bookings*`,
  `/api/payments/create`) **phải vẫn public** — khách không đăng nhập.

## Phạm vi
**Trong:**
- Middleware auth đặt TRƯỚC các route `/api/admin/*` (chặn cả ~25 endpoint admin
  bằng một chỗ, không sửa từng route).
- Trang đăng nhập + guard cho các route SPA `/admin/*` (chưa đăng nhập → về login).
- Cơ chế: **quyết định giữa 2 lựa chọn tối giản** (PO chọn, ghi ở "Đã làm gì"):
  (a) mật khẩu chung/`ADMIN_TOKEN` qua secret (đơn giản nhất, 1 spa);
  (b) bảng `admin_users(username, password_hash)` + phiên có hạn.
  KHÔNG tự làm cả OAuth/SSO.

**Ngoài:**
- KHÔNG multi-tenant, KHÔNG RBAC/phân quyền chi tiết (thuộc R3).
- KHÔNG chặn route khách hay webhook payment.
- KHÔNG tự nghĩ mã lỗi mới ngoài danh sách CONVENTIONS §5 (nếu cần mã auth mới,
  báo trước — ví dụ `UNAUTHORIZED`/401 — không tự thêm bừa).

## Đầu vào đã có
- `src/worker/routes/index.ts` — điểm gom route duy nhất; middleware admin mount
  ở đây bằng ĐÚNG MỘT dòng (CONVENTIONS §7). Các route admin đều `/api/admin/*`.
- Pattern secret binding đã có sẵn từ payment: `wrangler.jsonc` +
  `worker-configuration.d.ts` (Env) — dùng lại cho `ADMIN_TOKEN`/JWT secret;
  `.dev.vars` cho local (đã gitignore).
- `src/app/routes/admin/` — các trang admin (timeline/reassign/setup/overview) +
  `AdminNav`. Guard SPA gắn ở tầng route.
- Nếu chọn lưu DB: `migrations/` đánh số tăng dần (mới nhất 0003) → thêm 0004.

## Việc phải làm
1. `src/worker/lib/auth.ts` — hàm thuần kiểm token/phiên (không query trực tiếp,
   theo CONVENTIONS §7 "logic ở lib, route lo load").
2. Middleware Hono chặn `/api/admin/*` → thiếu/hỏng token trả 401. Mount bằng
   một dòng trong `registerRoutes()`.
3. `src/worker/routes/auth.ts` — `POST /api/auth/login` (nhận mật khẩu/credential
   → trả token/set phiên), `POST /api/auth/logout` nếu dùng phiên.
4. SPA: trang login + guard `/admin/*` (chưa auth → redirect login), lưu token
   an toàn, gắn vào request admin qua `apiClient`.
5. Secret binding + ghi vào `docs/DEPLOY.md`: secret nào phải `wrangler secret put`.
6. Cập nhật PRD (`docs/PRD.md`) dòng "No auth in v1" → phản ánh auth đã có.

## Quy ước bắt buộc
Từ `CONVENTIONS.md`:
- **§5 API:** lỗi trả `{ error: { code, message } }`. Auth-fail cần mã +401 —
  nếu chưa có trong danh sách (`SLOT_TAKEN`/`VALIDATION`/`NOT_FOUND`/…), BÁO
  trước khi thêm `UNAUTHORIZED`, không tự chế lung tung.
- **§7 Cấu trúc:** logic thuần ở `src/worker/lib/`; `src/worker/index.ts` chỉ
  T-01 sửa; route mới đăng ký bằng một dòng ở `routes/index.ts`.
- **§9 + BOARD:** không nới test cho xanh; agent không tự đặt `done`, cao nhất
  `review`.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] Test API: gọi bất kỳ `/api/admin/*` không token → 401; có token → như cũ
- [ ] Test API: route khách + webhook payment KHÔNG bị chặn (vẫn 200/201)
- [ ] E2E: chưa login vào `/admin/timeline` → về trang login; login xong → vào được
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì" (nêu rõ chọn phương án (a) hay (b) và vì sao)

## Test phải viết
- `admin route không token trả 401` — mỗi nhóm admin (schedule/overview/time-off)
  ít nhất một case.
- `admin route token hợp lệ đi qua như cũ`.
- `route khách vẫn public` — `/api/services`, `/api/availability`,
  `/api/bookings`, `/api/payments/create` không cần token.
- `webhook payment vẫn public` — `POST /api/payments/webhook/sepay` không bị auth
  admin chặn (vẫn tự xác thực Apikey như cũ).
- `login sai mật khẩu → 401`, `login đúng → nhận token dùng được`.
- E2E: `guard SPA đẩy về login khi chưa auth`, `vào admin được sau khi login`.

## Định nghĩa "xong"
Gõ thẳng `/api/admin/schedule` hay mở `/admin/overview` khi chưa đăng nhập đều bị
chặn; khách vẫn đặt lịch + trả tiền bình thường; webhook payment vẫn chạy.

## Cạm bẫy đã biết
- **Chặn nhầm webhook payment** → SePay/PayPal không confirm được → khách trả
  tiền mà lịch không lên paid (lỗi im lặng mất khách). Webhook PHẢI ngoài auth admin.
- **Chặn nhầm route khách** → khách không đặt được. Chỉ `/api/admin/*` bị chặn.
- Lưu token phía SPA sai chỗ (XSS) — theo pattern an toàn, không nhét bừa vào
  localStorage nếu dùng session cookie được.
- Secret hardcode — CẤM. Dùng binding, user tự `wrangler secret put`.
- Sửa `src/worker/index.ts` để mount middleware — KHÔNG. Mount ở `routes/index.ts`.

## Đã làm gì

**Phương án: (a) — một MẬT KHẨU ADMIN chung + phiên cookie ký HMAC.** Vì sao (a)
không (b): app single-tenant, một spa, PRD §2 loại multi-user/RBAC khỏi v1. Không
cần bảng `admin_users` hay password_hash per-user — chỉ cần phân biệt "nhân viên
đã đăng nhập" vs "người ngoài". (b) đưa vào một bảng + migration + vòng đời user
mà không ai dùng ở bước này = nợ chết. (a) là production-complete cho slice này.

**Cơ chế:** `POST /api/auth/login` nhận `{password}`, so với secret `ADMIN_PASSWORD`
(so sánh thời-gian-hằng). Đúng → phát token = `base64url(payload).base64url(HMAC-
SHA256(payload, SESSION_SECRET))`, payload chứa `exp` (TTL 12h = một ca). Token đặt
vào cookie `ccf_admin_session` với `HttpOnly; Secure; SameSite=Lax; Path=/`. HttpOnly
→ JS/SPA không đọc được token (chống XSS, đúng cạm bẫy card). Middleware
`adminAuthGuard` mount **một dòng** `app.use('/api/admin/*', adminAuthGuard)` ở
`registerRoutes()` TRƯỚC mọi route admin — chặn cả 26 endpoint admin tại một chỗ.
Thiếu/sai chữ ký/hết hạn → 401 `UNAUTHORIZED`. Logic ký/kiểm thuần ở
`src/worker/lib/auth.ts` (không query DB, CONVENTIONS §7).

**Mã lỗi:** thêm `UNAUTHORIZED` + HTTP 401 vào CONVENTIONS §5 (đã duyệt; có tiền lệ
`payments.ts:150` cho webhook). API trả `{error:{code:'UNAUTHORIZED',message}}` với
message tiếng Việt tự nhiên, không lộ vì sao chữ ký fail.

**SPA:** `/login` (một ô mật khẩu; sai → "Mật khẩu không đúng", không lộ mã thô).
Guard `RequireAuth` bọc mọi route `/admin/*`: hỏi `GET /api/auth/session` → chưa
auth thì `Navigate` về `/login?next=<đích>`. `apiClient`/authClient gắn
`credentials:'same-origin'` (cookie same-origin tự đính vào mọi fetch `/api/*` nên
các fetch admin sẵn có KHÔNG phải sửa).

**Secret binding:** `ADMIN_PASSWORD` + `SESSION_SECRET` thêm vào `worker-
configuration.d.ts` (Env, optional → build được trước khi cấu hình, fail-closed khi
thiếu), ghi chú ở `wrangler.jsonc`, hướng dẫn `wrangler secret put` ở `docs/DEPLOY.md`
bước 4. Giá trị test local ở `.dev.vars` (gitignored). KHÔNG hardcode secret thật.

**PUBLIC giữ nguyên (đã kiểm no-code bằng curl + E2E):** webhook `POST /api/payments/
webhook/:provider` (tự xác thực Apikey, không nằm dưới `/api/admin/*`); route khách
`/api/services`, `/api/availability`, `/api/bookings*`, `/api/payments/create`,
`/api/combo/*`, `/api/bookings/:id/cancel`. Chỉ `/api/admin/*` bị chặn.

**Test (KHÔNG nới/xoá assertion nào):**
- `tests/unit/auth.test.ts` — lib thuần: checkPassword, issue/verify token, hết hạn,
  sai secret, sửa payload, fail-closed.
- `tests/api/auth.test.ts` — mỗi nhóm admin (schedule/reassign/overview/staff) không
  cookie → 401; chữ ký sai/hết hạn → 401; cookie hợp lệ → qua như cũ; route khách +
  webhook payment vẫn public; login sai→401/đúng→cookie dùng được; logout; session.
- `tests/e2e/admin-auth.spec.ts` — guard đẩy về /login khi chưa auth; sai mật khẩu;
  login đúng → vào /admin/timeline; logout → lại bị chặn.
- 8 file test admin cũ: thêm cookie phiên hợp lệ qua helper chung `tests/api/
  _authCookie.ts` (mỗi test admin HIỆN RÕ cần phiên; guard hỏng → case 401-khi-thiếu
  ở auth.test.ts đỏ đúng chỗ). E2E: `tests/e2e/auth.setup.ts` đăng nhập một lần +
  storageState, hai project admin dùng lại → 40 spec admin cũ xanh không phải sửa
  từng file.

**Kết quả:** typecheck xanh · API+unit 330/330 · E2E 81/81 (guard 5/5) · no-code curl
xác nhận chưa-login→401 UNAUTHORIZED, khách/webhook vẫn 200, cookie hợp lệ→admin 200.

**File đụng NGOÀI `touches` (đã báo + duyệt orchestrator):** `vitest.config.ts`
(2 binding test), `playwright.config.ts` + `tests/e2e/auth.setup.ts` (storageState
cho suite cũ), 8 file `tests/api/*` + `tests/api/_authCookie.ts` (cấp cookie cho test
admin cũ theo phương án A explicit), `docs/DEPLOY.md` (hướng dẫn secret put),
`.gitignore` (bỏ qua `tests/e2e/.auth/` chứa cookie phiên).
