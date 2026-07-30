---
id: T-34
title: Seed E2E qua binding in-process (bỏ spawn wrangler mỗi lần) → nhanh + hết contention
status: todo
model: opus
effort: high
depends_on: []
touches:
  - tests/e2e/_seed.ts
  - tests/e2e/global-setup.ts
  - tests/e2e/admin-timeline.spec.ts
  - tests/e2e/admin-walkin-reassign.spec.ts
  - tests/e2e/customer-lookup.spec.ts
  - tests/e2e/customer-reschedule.spec.ts
  - tests/e2e/flows/cancel-too-late-hotline.spec.ts
  - playwright.config.ts
prd_refs: []
owner: null
started_at: null
finished_at: null
---

# T-34 · Seed E2E qua binding in-process (bỏ spawn wrangler mỗi lần)

## Mục tiêu
Làm E2E **nhanh** và **hết contention** bằng cách bỏ hẳn kiểu seed
`execFileSync('npx wrangler d1 execute ...')` — mỗi lần gọi tốn ~1.2s cold-boot
Node+wrangler+miniflare — thay bằng MỘT helper seed ghi thẳng vào D1 local
in-process (không spawn subprocess). Đây là fix ROOT CAUSE của cả hai vấn đề T-33
đụng phải: chậm VÀ flaky đều do quá nhiều tiến trình wrangler tranh một file SQLite.

## Ngữ cảnh cần biết — QUAN HỆ VỚI T-33 (đọc kỹ)
T-33 (đã tạm dừng) sửa contention bằng cách **serialize** các spec spawn wrangler
(`chromium-d1-seed` workers:1 + dependency). Đúng về correctness nhưng đánh đổi tốc
độ, và còn sót ECONNRESET transient dưới burst → T-33 bắt đầu trượt sang retries/
giảm workers = **vá triệu chứng**. T-34 xoá gốc: không còn tiến trình wrangler tranh
nhau thì KHÔNG cần serialize, KHÔNG cần retries.

**DoD của T-34 CHÍNH LÀ mục tiêu của T-33:** sau T-34, E2E full suite phải xanh tất
định **MÀ KHÔNG cần** workaround serialize/retry của T-33 (hoặc cần ít hơn hẳn). Tức
T-34 thay thế T-33 — nếu T-34 đạt, T-33 khép lại (superseded), không merge workaround.

Đo được (baseline hiện tại, xác minh bằng tay):
- 1 lần `wrangler d1 execute` cold = **~1.2s**. Có **29 call-site** seed rải trên 6
  file, nhiều cái chạy **mỗi test** → 100+ cold-boot/lần chạy ≈ 2+ phút chỉ để spawn.
- Không có helper seed chung; kiểu seed bị copy-paste 6 chỗ (chỉ có `_authHelpers.ts`).

Cơ chế ghi rẻ đã xác nhận có sẵn (KHÔNG cần thêm dep):
- `wrangler@4.112` export **`getPlatformProxy()`** → trả binding D1 in-process
  (`env.DB`) dùng ĐÚNG API D1 như app. Đây là hướng ưu tiên: cùng interface, không
  subprocess, không dep mới, không đọc thẳng file sqlite (tránh lệ thuộc đường dẫn
  `.wrangler/state/...`).
- (Dự phòng nếu getPlatformProxy vướng: file sqlite local tồn tại tại
  `.wrangler/state/v3/d1/.../*.sqlite` — nhưng ưu tiên binding, đừng đọc thẳng file
  trừ khi buộc.)

## Phạm vi
**Trong:**
- Tạo `tests/e2e/_seed.ts`: helper seed dùng `getPlatformProxy` (một handle mở một
  lần, tái dùng) — cung cấp các hàm seed hiện có đang copy-paste (booking item,
  time_off, customer booking, staff/variant fixture...). API tương đương cái cũ để
  đổi gọn.
- Chuyển 6 file (`global-setup.ts` + 5 spec) từ `execFileSync(wrangler)` sang
  `_seed.ts`. Xoá hết spawn wrangler trong đường seed.
- `playwright.config.ts`: một khi contention hết, **gỡ bỏ workaround** — bỏ
  serialize `chromium-d1-seed`/gộp lại vào chạy song song nếu an toàn; KHÔNG thêm
  retries để giấu flake. Giữ `chromium-shared-queue` NẾU nó còn cần cho race LOGIC
  (hàng chờ reassign toàn cục) — race logic khác race tài nguyên, T-34 chỉ xoá race
  tài nguyên. Cân nhắc kỹ: nếu shared-queue chỉ tồn tại vì contention thì gỡ; nếu vì
  logic global-state thì GIỮ. Nêu rõ lý do.
- Giữ `global-setup` wipe+seed sạch trước mỗi lần chạy (chuyển nó sang binding luôn).

**Ngoài:**
- KHÔNG thêm dependency mới (better-sqlite3 v.v.) — dùng getPlatformProxy.
- KHÔNG đổi schema/migration production.
- KHÔNG thêm endpoint seed-only vào worker production (giữ seed ở tầng test).
- KHÔNG nới/xoá assertion. KHÔNG dùng retries để đạt "xanh".

## Đầu vào đã có
- 6 file đang seed qua `execFileSync(wrangler d1 execute)` — xem chúng để biết đúng
  các bảng/cột mỗi hàm seed cần.
- `src/worker/db/seed.ts` (`npm run db:seed:local`) — logic seed gốc, tham chiếu.
- T-33 worktree (`.cc-worktrees/...agent-ab84c21a6d1f5b524`, uncommitted) chứa chẩn
  đoán + fix config — ĐỌC để hiểu contention + auth-race đã tìm ra, nhưng T-34 KHÔNG
  build tiếp trên workaround đó; T-34 xoá gốc rồi mới quyết giữ/bỏ từng phần config.
- T-33 cũng phát hiện 2 lỗi thật cần MANG SANG (đừng làm rơi): (a) auth-setup vs
  guard-project password-change race — cần giữ `dependencies:['auth-setup']` cho
  guard project; (b) `rs-slot-` flaky locator trong customer-reschedule (dùng
  `.first()` re-resolve) — sửa để chọn slot atomically theo testid. Cả hai nằm trong
  touches của T-34.

## Việc phải làm
1. `_seed.ts`: mở `getPlatformProxy` một lần, expose các hàm seed (tương đương cũ),
   đóng handle ở teardown.
2. Đổi `global-setup.ts` sang binding (wipe + seed).
3. Đổi 5 spec sang `_seed.ts`, xoá mọi `execFileSync(wrangler)` trong đường seed.
4. Mang 2 fix thật từ T-33: guard-project `dependencies:['auth-setup']`; sửa
   `rs-slot-` locator atomically.
5. Gỡ workaround serialize/retry trong `playwright.config.ts` khi đã hết contention;
   quyết giữ/bỏ `chromium-shared-queue` theo tiêu chí logic-vs-tài-nguyên (nêu lý do).
6. Đo lại tốc độ trước/sau, ghi con số.

## Quy ước bắt buộc
Copy mục liên quan `docs/tasks/CONVENTIONS.md` (§8 fixture tích luỹ → global wipe vẫn
cần). Giữ nguyên ý đồ "mỗi spec tự seed fixture, global-setup dọn".

## Checklist đầu ra
- [ ] Typecheck xanh
- [ ] `npm test` (unit/API) vẫn ≥442 xanh
- [ ] `CI=true npm run e2e` full suite xanh **3 lần liên tiếp** (dán output cả 3)
- [ ] **Không** dùng retries và **không** serialize toàn cục để đạt xanh
- [ ] Đo: thời gian full E2E trước (baseline T-33) vs sau — ghi rõ, phải nhanh hơn hẳn
- [ ] Không đụng file ngoài `touches`
- [ ] `status: review` + `finished_at`
- [ ] "Đã làm gì" — nêu cơ chế seed mới, contention đã hết ra sao, giữ/bỏ shared-queue vì sao

## Test phải viết
Không thêm test tính năng. Bằng chứng = **3 lần full-suite xanh liên tiếp KHÔNG
retries/serialize-toàn-cục** + **số đo tốc độ trước/sau**. `rs-slot-` phải xanh (chứng
minh fix locator). Nếu `_seed.ts` có logic đáng test riêng (vd hàm build fixture),
thêm assert nhỏ.

## Định nghĩa "xong" (== mục tiêu T-33)
`CI=true npm run e2e` xanh **tất định (3/3)** **mà không cần** workaround serialize/
retry — chứng minh root cause (spawn wrangler mỗi seed) đã bị xoá — VÀ full run nhanh
hơn baseline rõ rệt (ghi số). Đạt được thì T-33 khép lại là superseded.

## Cạm bẫy đã biết
- **Đừng dùng retries/giảm workers để "xanh"** — đó là vá triệu chứng T-33 suýt sa
  vào; card này tồn tại để xoá gốc.
- **getPlatformProxy handle phải mở một lần + đóng ở teardown** — mở/đóng mỗi seed lại
  thành cold-boot mới, mất hết lợi ích.
- **Đừng nhầm race LOGIC (hàng chờ reassign toàn cục, shared-queue) với race TÀI
  NGUYÊN (wrangler subprocess).** T-34 xoá cái sau; cái trước có thể vẫn cần
  serialize — quyết theo bản chất, nêu lý do, đừng gỡ nhầm.
- **Đừng làm rơi 2 fix thật của T-33** (auth-setup dependency; rs-slot- locator).

## Đã làm gì
(agent điền khi xong)
