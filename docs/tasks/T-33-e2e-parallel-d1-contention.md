---
id: T-33
title: Sửa E2E đỏ/flaky do D1 local subprocess contention (không phải race logic)
status: todo
model: opus
effort: medium
depends_on: []
touches:
  - playwright.config.ts
  - tests/e2e/global-setup.ts
  - tests/e2e/customer-reschedule.spec.ts
prd_refs: []
owner: null
started_at: null
finished_at: null
---

# T-33 · Sửa E2E đỏ/flaky do D1 local subprocess contention

## Mục tiêu
Làm `npm run e2e` (full suite, đúng cách CI chạy) xanh **tất định** — không còn
SQLITE_BUSY / dev-server OOM (exit 137) / locator biến mất ngẫu nhiên. Điều kiện
"xong" là **quan sát được**: chạy full suite 3 lần liên tiếp đều xanh (trừ khi có
bug thật, phải nêu tên).

## Ngữ cảnh cần biết — ĐỌC KỸ, đừng file trùng việc đã làm
Đây KHÔNG phải "phát hiện mới E2E flaky". Nửa vấn đề ĐÃ được sửa; nửa còn lại chưa.
Phải phân biệt rõ, đừng đụng lại phần đã đúng:

1. **ĐÃ SỬA (giữ nguyên, đừng phá):** race **LOGIC global-state**. Project
   `chromium-shared-queue` (`fullyParallel:false, workers:1`) gom 4 spec đụng hàng
   chờ reassign (tài nguyên toàn cục suy từ giao time_off × booking_items toàn DB).
   Chạy song song thì file này dọn hàng chờ, file kia tạo orphan → "hàng chờ rỗng"
   sai. Quarantine này đúng. Cluster T-29..T-32 chạy trong project này nên luôn xanh.

2. **CHƯA SỬA (việc của card này):** race **TÀI NGUYÊN**. Project `chromium` mặc định
   vẫn `fullyParallel:true`. Nhiều spec seed bằng `wrangler d1 execute --local` —
   MỖI lần spawn một tiến trình mở THẲNG cùng một file SQLite local. Nhiều tiến trình
   ghi đồng thời → SQLITE_BUSY / FOREIGN KEY, và một rừng subprocess + dev server →
   OOM kill (exit 137). `customer-reschedule.spec.ts:70` (`rs-slot-` locator không
   hiện) nhiều khả năng là **TRIỆU CHỨNG**: file khác seed đồng thời làm hỏng
   availability nên lưới slot rỗng — KHÔNG phải bug logic của luồng reschedule. Card
   phải xác minh giả thuyết này trước khi "sửa" gì.

Bằng chứng: `customer-reschedule.spec.ts` đã tự `mode:'serial'` + comment thừa nhận
"chạy song song trong cùng file dễ SQLITE_BUSY" — tức tác giả biết race D1 subprocess
NHƯNG chỉ chặn được trong-file, không chặn được liên-file vì file vẫn nằm project
song song.

## Phạm vi
**Trong:**
- Chẩn đoán trước: xác nhận `rs-slot-` fail có phải do seed đồng thời của file khác
  (chạy riêng file đó cô lập → xanh? chạy full parallel → đỏ? → đúng giả thuyết).
- Bỏ contention D1-subprocess: chọn MỘT hướng, nêu lý do —
  (a) cho seed đi qua một serialize point (queue/lock quanh `wrangler d1 execute`),
  (b) hoặc seed qua HTTP/binding thay vì spawn `wrangler` mỗi lần,
  (c) hoặc giảm `workers` cho các spec có seed nặng,
  (d) hoặc dev-server + D1 dùng chế độ chịu được ghi đồng thею (WAL/retry-on-busy).
  Ưu tiên hướng giữ được song song ở spec KHÔNG seed nặng (đừng biến cả bộ thành
  serial — đó là quá tay, giết tốc độ).
- Nếu sau khi hết contention mà `rs-slot-` VẪN đỏ → đó mới là bug thật của reschedule,
  sửa nó (đúng test-id / đúng availability), nêu rõ.

**Ngoài:**
- KHÔNG đụng `chromium-shared-queue` quarantine (đã đúng).
- KHÔNG nới/xoá assertion cho xanh. KHÔNG biến toàn bộ suite thành `workers:1` như
  cách lười (che vấn đề, giết CI speed) — chỉ serialize đúng chỗ cần.
- KHÔNG đổi schema/migration production để chiều test.

## Đầu vào đã có
- `playwright.config.ts` — 4 project (auth-setup, auth-guard, shared-queue serial,
  chromium parallel), `webServer.reuseExistingServer:!CI`.
- `tests/e2e/global-setup.ts` — dọn D1 về seed sạch trước mỗi lần chạy.
- Cách seed hiện tại: nhiều spec gọi `wrangler d1 execute --local` inline.

## Việc phải làm
1. Reproduce + xác nhận root cause (contention, không phải logic) bằng chạy cô
   lập vs full-parallel. Ghi bằng chứng.
2. Áp một hướng khử contention (nêu lý do chọn).
3. Chạy full `npm run e2e` (CI=true) 3 lần → phải xanh cả 3, hoặc chỉ còn bug thật
   đã nêu tên.
4. Nếu `rs-slot-` là bug thật sau khi hết contention → sửa.

## Quy ước bắt buộc
Copy mục liên quan `docs/tasks/CONVENTIONS.md` (đặc biệt §8 về fixture/time_off tích
luỹ). Giữ global-setup dọn-seed-sạch.

## Checklist đầu ra
- [ ] Typecheck xanh
- [ ] `npm test` (unit/API) vẫn 442+ xanh
- [ ] `CI=true npm run e2e` full suite xanh **3 lần liên tiếp** (dán output cả 3)
- [ ] Không đụng file ngoài `touches`
- [ ] `status: review` + `finished_at`
- [ ] "Đã làm gì" — nêu rõ root cause xác minh được + hướng chọn + lý do

## Test phải viết
Không thêm test tính năng. "Test" ở đây = **3 lần full-suite xanh liên tiếp** là bằng
chứng tất định. Nếu thêm cơ chế serialize seed, thêm 1 nhận xét/assert nhỏ chứng minh
nó chặn được ghi đồng thời (nếu khả thi).

## Định nghĩa "xong"
`CI=true npm run e2e` xanh tất định (3/3 lần), quarantine shared-queue còn nguyên,
không spec nào bị nới assertion, và nếu `rs-slot-` từng đỏ thì đã rõ nó là
triệu-chứng-contention (biến mất khi hết contention) HAY bug thật (đã sửa).

## Cạm bẫy đã biết
- **Đừng "sửa" bằng cách serialize cả bộ** — che root cause, giết CI speed. Serialize
  đúng chỗ seed nặng thôi.
- **Đừng nhầm triệu chứng với bug.** `rs-slot-` đỏ có thể tự hết khi khử contention;
  xác minh trước khi sửa luồng reschedule.
- Nửa logic (shared-queue) đã đúng — đụng vào là gây regression đã-từng-trả-giá.

## Đã làm gì
(agent điền khi xong)
