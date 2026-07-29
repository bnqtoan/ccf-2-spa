---
id: T-27
title: R6 — Thông báo Telegram nội bộ (báo lễ tân)
status: todo
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
- [ ] typecheck · npm test · e2e --workers=1 xanh
- [ ] status review + "Đã làm gì"

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
(agent điền khi xong)
