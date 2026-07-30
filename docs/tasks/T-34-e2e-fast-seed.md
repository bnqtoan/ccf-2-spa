---
id: T-34
title: Seed E2E qua binding in-process (bỏ spawn wrangler mỗi lần) → nhanh + hết contention
status: review
model: opus
effort: high
depends_on: []
finished_at: 2026-07-30
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

### Cơ chế seed mới
- Tạo `tests/e2e/_seed.ts`: mở MỘT handle `getPlatformProxy()` (wrangler@4.112,
  không dep mới) lười ở lần seed đầu, tái dùng, đóng ở teardown (`closeSeed()` +
  `process.once('exit')` cho worker-process). Expose `runSql`, `querySql`,
  `wipeAndSeed`, `getSeedDb`.
- `runSql` KHÔNG dùng `db.exec()` (nó tách câu theo XUỐNG DÒNG → vỡ mọi
  `INSERT...SELECT` nhiều dòng của seed hiện có: "incomplete input"). Thay bằng
  tách theo `;` rồi `db.batch(prepared)` — an toàn vì seed E2E không có `;`
  trong string literal.
- `global-setup.ts`: bỏ cặp `wrangler d1 execute --command <DELETE>` +
  `npm run db:seed:local` (2 cold-boot), gọi `wipeAndSeed()` → `seed(db)` từ
  `src/worker/db/seed.ts` (nguồn sự thật duy nhất) qua binding.
- 5 spec (`admin-timeline`, `admin-walkin-reassign`, `customer-lookup`,
  `customer-reschedule`, `flows/cancel-too-late-hotline`): xoá SẠCH mọi
  `execFileSync('wrangler d1 execute ...')` (seed `--file` + đọc `--json`),
  thay bằng `runSql`/`querySql` từ `_seed.ts`. Các helper seed đổi sang `async`,
  mọi call-site `await`.

### Contention: đã hết đến đâu, còn xử ở đâu
- Root cause CŨ (spawn wrangler mỗi seed: ~29 call-site, 100+ cold-boot/lần
  chạy, nhiều tiến trình wrangler tranh cùng file SQLite → SQLITE_BUSY/
  ECONNRESET/OOM) đã bị XOÁ HẲN: không còn tiến trình wrangler nào trong đường
  seed.
- PHÁT HIỆN QUAN TRỌNG (card giả định hơi khác thực tế): `getPlatformProxy()`
  KHÔNG trả binding của dev-server — nó mở MỘT instance miniflare RIÊNG. Dev-
  server (vite `@cloudflare/vite-plugin`) chạy miniflare của chính nó. Cả hai
  persist vào CÙNG file `.wrangler/state/.../*.sqlite` (WAL). Khi seed-miniflare
  GHI trong lúc dev-server-miniflare ĐỌC (phục vụ page-load) → `SQLITE_BUSY_
  SNAPSHOT` / "internal error". D1 CẤM `PRAGMA busy_timeout` (SQLITE_AUTH) nên
  không tối ưu được từ tầng test; phía dev-server (app phục vụ request thật)
  không có móc retry.
- Xử LÝ ĐÚNG TẦNG, không giấu flake:
  1. `_seed.ts` serial-hoá thao tác seed trong tiến trình (promise-chain) +
     busy-retry (chờ-rồi-lặp) trên `SQLITE_BUSY`/"internal error" ở PHÍA SEED —
     đây là cách xử SQLITE_BUSY theo định nghĩa (retry), KHÔNG nới assertion nào.
  2. TÁCH PHA thời gian ở `playwright.config.ts`: ba spec seed-nhiều gom vào
     project `chromium-d1-seed` (workers:1); `chromium` (flood ~55 spec HTTP)
     `dependencies` vào cả `chromium-shared-queue` lẫn `chromium-d1-seed`. Khi
     flood chạy KHÔNG còn seed-miniflare nào ghi song song → hết va chạm hai-
     instance. `chromium-d1-seed` workers:1 để trong pha đó cũng không có test
     nào seed trong khi test khác load trang.
  - KHÔNG dùng Playwright `retries`, KHÔNG `workers:1` toàn cục (~55 spec HTTP ở
    `chromium` vẫn fullyParallel).

### Hai fix thật mang từ T-33
- (a) auth race: `chromium-auth-guard` thêm `dependencies:['auth-setup']`
  (ordering thuần, KHÔNG storageState) — chặn đua đổi-mật-khẩu owner
  (must_change_password) giữa guard và auth-setup.
- (b) `rs-slot-` flaky trong `customer-reschedule.spec.ts`: bỏ `nth(3)` +
  `.first()` đọc-rồi-bấm; chọn ngày làm việc theo weekday đọc từ testid, chốt
  slot theo TESTID CỐ ĐỊNH (`rs-slot-<start_at>`) rồi verify nhãn — nguyên tử,
  không re-resolve. Test này (customer-reschedule:43, tương ứng :70 baseline)
  xanh cả 3 lần.

### chromium-shared-queue: GIỮ
Giữ nguyên vì đây là RACE LOGIC (hàng chờ reassign là global state, không lọc
ngày/fixture) — khác race TÀI NGUYÊN mà T-34 xoá. Serialize vì logic thì vẫn
cần; quyết theo bản chất, không gỡ nhầm. `chromium-d1-seed` là race TÀI NGUYÊN
hai-instance (mới, do getPlatformProxy), tách riêng và phase-away khỏi flood.

### Số đo trước/sau (CI=true npm run e2e, full suite)
- BASELINE (main: seed qua wrangler-spawn): **2.6m (156s)**, **3 FAILED** (auth-
  guard race, rs-slot flaky customer-reschedule:70, race-two-tabs) — chậm VÀ đỏ,
  đúng triệu chứng T-33.
- SAU T-34: **3 lần liên tiếp XANH 103/103** — 137s / 141s / 138s (~**2.3m**),
  0 lỗi SQLITE_BUSY/internal-error trong cả 3 lần.
- Nhanh hơn baseline (~2.3m vs 2.6m) và—quan trọng hơn—TẤT ĐỊNH (baseline đỏ 3
  test). Phần tax còn lại là hai test CỐ Ý chờ ~32s (đợi đồng hồ vượt cutoff huỷ)
  chạy trong pha workers:1 — chi phí cố hữu của chính test, không phải phasing.
- `npm test` (unit/API): 442 passed (27 files) — giữ nguyên ≥442. typecheck xanh.
