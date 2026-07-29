---
id: T-27
title: R6 — Thông báo Telegram nội bộ (báo lễ tân)
status: review
model: sonnet
effort: medium
depends_on: []
touches:
  - src/worker/lib/          # notify adapter (Telegram)
  - src/worker/routes/       # hook vào booking/time-off (gọi notify sau khi ghi)
  - wrangler.jsonc
  - worker-configuration.d.ts
  - .dev.vars.example
  - docs/DEPLOY.md
  - tests/
prd_refs: []
owner: null
started_at: null
finished_at: null
---

# T-27 · R6 — Thông báo Telegram nội bộ

## Mục tiêu
App chưa có kênh thông báo nào. Thêm Telegram bot báo **NỘI BỘ (lễ tân/admin)** khi
có sự kiện cần biết ngay: booking mới, KTV nghỉ (kèm lịch mồ côi), có lịch cần xếp
lại. Giảm việc lễ tân phải ngồi refresh timeline.

## Ngữ cảnh cần biết (product owner đã chốt)
- CHỈ gửi nội bộ (bot → admin/lễ tân), KHÔNG gửi khách (khách VN ít Telegram — kênh
  tới khách + rating để card sau).
- Gửi TỨC THÌ khi sự kiện xảy ra (không cần cron): sau khi GHI DB thành công →
  fire notification. Fire-and-forget: notify FAIL KHÔNG được làm hỏng nghiệp vụ
  (booking vẫn thành công dù Telegram lỗi).

## Phạm vi
**Trong:**
- `lib/notify.ts` (hoặc lib/telegram.ts): gửi message qua Telegram Bot API
  (`sendMessage`, bot token + chat_id từ env). Adapter thuần, test được (inject
  fetch/mock). Trả kết quả nhưng KHÔNG throw ra ngoài luồng nghiệp vụ.
- Hook 3 sự kiện (gọi notify SAU khi ghi DB thành công, không chặn response):
  - Booking mới (online + walk-in): "Đặt lịch mới: [khách] [dịch vụ] [giờ] [KTV]".
  - KTV nghỉ (POST time-off có affected_items): "KTV [tên] nghỉ [khoảng], N lịch
    cần xếp lại".
  - (Tuỳ chọn) lịch mồ côi mới vào hàng chờ.
- Secret: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (env, wrangler secret). Chưa cấu
  hình → notify NO-OP (không lỗi, chỉ bỏ qua) — app chạy bình thường.
- DEPLOY.md: hướng dẫn tạo bot + lấy token/chat_id + set secret.

**Ngoài:**
- KHÔNG gửi khách (nhắc hẹn/rating — card sau, cần chốt kênh).
- KHÔNG cron/scheduled (chỉ event-driven tức thì). KHÔNG lưu lịch sử gửi (schema).
- KHÔNG retry phức tạp (fire-and-forget; Telegram lỗi thì thôi, không chặn nghiệp vụ).

## Đầu vào đã có
- Hook points: bookings.ts (online), admin-walkin.ts (walk-in), admin-timeoff.ts
  (time-off + affected_items).
- Pattern adapter + env-optional (payment: fail-closed khi thiếu secret) — tái dùng ý.
- `c.executionCtx.waitUntil()` (Workers) để fire notify không chặn response.

## Việc phải làm
1. lib/notify: gửi Telegram, no-op khi thiếu token/chat_id, không throw.
2. Hook 3 sự kiện qua waitUntil (không chặn response, notify fail không hỏng nghiệp vụ).
3. Env + secret + .dev.vars.example + DEPLOY.md.

## Quy ước bắt buộc (CONVENTIONS)
- §7 route. §8 test D1 thật. §9 không nới assertion.
- Notify KHÔNG BAO GIỜ làm fail nghiệp vụ (booking/time-off vẫn thành công dù notify lỗi).
- Secret KHÔNG hardcode; .dev.vars test giá trị giả.

## Checklist đầu ra
- [x] typecheck · npm test · e2e --workers=1 xanh
- [x] status review + "Đã làm gì"

## Test phải viết
- `notify gửi đúng nội dung khi booking mới (mock fetch, assert body message)`
- `thiếu TELEGRAM_BOT_TOKEN → notify NO-OP, KHÔNG throw, booking vẫn 201`
- `Telegram API trả lỗi 500 → booking VẪN thành công (notify fail không chặn nghiệp vụ)`
- `time-off có affected_items → message nêu số lịch cần xếp lại`
- `route khách/webhook KHÔNG bị notify chặn`

## Định nghĩa "xong"
Có booking mới / KTV nghỉ → Telegram nội bộ nhận tin ngay; nếu Telegram chưa cấu
hình hoặc lỗi, nghiệp vụ vẫn chạy bình thường (notify không bao giờ là điểm hỏng).

## Cạm bẫy đã biết
- **Notify KHÔNG được chặn/hỏng nghiệp vụ:** dùng waitUntil + try/catch nuốt lỗi.
  Test case "Telegram lỗi → booking vẫn OK" là bắt buộc.
- Đừng gửi 2 lần (booking online + item) — gửi 1 tin/1 sự kiện.
- chat_id/token là secret — .dev.vars gitignore, không commit giá trị thật.

## Đã làm gì
- `src/worker/lib/notify.ts` (mới): `sendTelegram(env, text, fetchImpl?)` — gọi
  Telegram Bot API `sendMessage`. NO-OP (`{ok:false, reason:'not_configured'}`,
  không gọi fetch) khi thiếu `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. Không bao
  giờ throw: HTTP non-2xx → `{ok:false, reason:'http_error'}`, fetch reject →
  `{ok:false, reason:'network_error'}`. `fetchImpl` injectable cho test (giống
  pattern `payments/*.ts`). Kèm `bookingMessage()` / `timeOffMessage()` build
  nội dung tiếng Việt.
- Hook 3 điểm, tất cả qua `c.executionCtx.waitUntil(...)` + `try/catch` nuốt
  lỗi bọc ngoài (2 lớp phòng thủ — bản thân `sendTelegram` cũng không throw):
  - `src/worker/routes/bookings.ts` — sau khi ghi booking online 201.
  - `src/worker/routes/admin-walkin.ts` — sau khi ghi walk-in 201.
  - `src/worker/routes/admin-timeoff.ts` — sau `POST /api/admin/time-off`,
    kèm số `affected_items` trong nội dung tin.
- `wrangler.jsonc`, `worker-configuration.d.ts`, `.dev.vars.example`,
  `docs/DEPLOY.md` — khai báo `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (secret,
  optional), hướng dẫn tạo bot qua @BotFather + lấy chat_id qua `getUpdates`.
- `tests/api/notify.test.ts` (mới, 17 test): unit thuần `sendTelegram` (nội
  dung đúng, no-op thiếu token/chat_id, HTTP 500 → ok:false, fetch reject →
  ok:false, không throw ở mọi case) + API thật qua `exports.default.fetch()`
  với `vi.stubGlobal('fetch', ...)` mock — xác nhận booking/walk-in/time-off
  vẫn 201/200 dù Telegram lỗi 500 hoặc thiếu secret, và nội dung tin gửi đúng
  (khách, dịch vụ, giờ, KTV / số lịch cần xếp lại).
- Kỹ thuật test: `env.TELEGRAM_*` (từ `cloudflare:workers`) là binding có thể
  set/xoá RUNTIME trong từng test để mô phỏng "đã cấu hình"/"chưa cấu hình" mà
  không cần sửa `vitest.config.ts` (nếu đặt cố định ở đó thì case "thiếu
  secret" không tái tạo được). `waitUntil` xác nhận có settle trước khi test
  đọc side-effect: `exports.default.fetch()` của `@cloudflare/vitest-pool-
  workers` chạy qua service-binding RPC, thực nghiệm cho thấy cần một
  `await new Promise(r => setTimeout(r, 20))` (helper `flush()`) sau response
  để chắc chắn promise trong `waitUntil` đã chạy xong trước khi assert.
- GATE 2: `npm run typecheck` sạch · `npm test` 395/395 pass (chạy 2 lần liên
  tiếp, ổn định) · `npx playwright test --workers=1` 86 passed / 1 skipped
  (skip có sẵn từ trước, không liên quan T-27) / 0 failed.
- Phát hiện phụ: D1 local của worktree chưa `db:migrate:local`/`db:seed:local`
  (bước setup orchestrator giao) — đã tự chạy trước khi e2e.
- Secrets cần set production: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (cả hai
  optional — thiếu thì notify NO-OP, app chạy bình thường). Hướng dẫn lấy giá
  trị ở `docs/DEPLOY.md` mục 4a.
