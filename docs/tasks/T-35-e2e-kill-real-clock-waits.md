---
id: T-35
title: E2E nhanh gấp đôi — khử 3 test chờ đồng-hồ-thật (86s/140s)
status: review
model: opus
effort: medium
depends_on: []
touches:
  - tests/e2e/customer-lookup.spec.ts
  - tests/e2e/flows/cancel-too-late-hotline.spec.ts
  - tests/e2e/customer-combo.spec.ts
  - tests/e2e/_seed.ts
prd_refs: []
owner: null
started_at: 2026-07-30
finished_at: 2026-07-30
---

# T-35 · E2E nhanh gấp đôi — khử 3 test chờ đồng-hồ-thật

## Mục tiêu
Rút full E2E từ ~140s xuống ~nửa. Đo thực (per-test timing, 2026-07-30): **3 test
ngốn 86s / 140s**; 100+ test còn lại tổng ~54s. Khử đúng 3 chỗ này là đòn bẩy cao
nhất — không đụng phần đã nhanh.

## Ngữ cảnh — 3 thủ phạm THẬT (đã đo, không đoán)
| Test | Thời gian | Nguyên nhân |
|---|---|---|
| `customer-lookup.spec.ts:149` (409 CANCEL_TOO_LATE) | **32.0s** | chờ đồng hồ THẬT bò tới mốc cutoff 2h |
| `flows/cancel-too-late-hotline.spec.ts:6` | **31.9s** | y hệt — chờ đồng hồ thật qua cutoff |
| `customer-combo.spec.ts:223` (combo song song, chỉ đủ 1 người) | **22.5s** | chờ/retry availability, KHÔNG phải cutoff |

Lưu ý: 2 test cutoff đúng như report T-34 đoán; nhưng test combo 22.5s là thủ phạm
THỨ BA report bỏ sót — phải xử cả ba, đừng chỉ sửa cutoff.

Đã có sẵn để tái dùng: T-21 đã centralize `now()` + cho **inject clock** (xem
`src/worker/lib/clock.ts` / cách near-midnight walk-in test set giờ). Đây là chìa
khoá cho 2 test cutoff — đặt "giờ hiện tại" của server tới sát cutoff thay vì chờ
đồng hồ thật.

## Phạm vi
**Trong:**
- 2 test cutoff: dùng injectable clock (T-21) để đẩy giờ server qua mốc 2h **tức
  thời** thay vì `waitFor`/sleep đồng hồ thật. Hành vi khẳng định GIỮ NGUYÊN (vẫn
  phải nhận 409 CANCEL_TOO_LATE + chuyển hotline) — chỉ bỏ phần CHỜ.
- Test combo 22.5s: tìm ra 22.5s đến từ đâu (retry availability? timeout chờ slot?
  polling?) rồi khử — seed trạng thái trực tiếp qua `_seed.ts` để tới thẳng điều
  kiện cần test, thay vì để UI/engine chờ.
- Đo lại per-test trước/sau; mục tiêu 3 test này về ≤3s mỗi cái.

**Ngoài:**
- KHÔNG nới/xoá assertion, KHÔNG giảm coverage. Vẫn test đúng hành vi cutoff + combo.
- KHÔNG đụng 100+ test đã nhanh.
- KHÔNG thêm retries/global-serialize.
- KHÔNG đổi logic production để chiều test (nếu clock injection cần một hook test-only
  đã có từ T-21 thì dùng lại, đừng chế mới trong production path).

## Đầu vào đã có
- T-21: `now()` centralize + clock injection (near-midnight walk-in test là mẫu cách
  set giờ server trong E2E). Tìm cơ chế đó, tái dùng cho 2 test cutoff.
- `tests/e2e/_seed.ts` (T-34): seed nhanh in-process — dùng để dựng thẳng trạng thái
  cho test combo.
- File timing thực: chạy `CI=true npx playwright test --reporter=list` rồi sort theo
  `(Ns)` để xác nhận trước/sau.

## Việc phải làm
1. Xác nhận cơ chế inject clock của T-21 dùng được từ E2E (server đọc giờ inject qua
   header/env/endpoint test-only nào?).
2. 2 test cutoff: set giờ qua mốc, bỏ chờ thật, giữ assertion.
3. Test combo: chẩn đoán 22.5s (bằng chứng), khử bằng seed thẳng trạng thái.
4. Đo lại: 3 test ≤3s; full suite ~nửa cũ. Chạy 3× vẫn xanh tất định.

## Checklist đầu ra
- [ ] Typecheck xanh
- [ ] `npm test` (unit/API) vẫn ≥442 xanh
- [ ] `CI=true npm run e2e` xanh **3× liên tiếp**, KHÔNG retries/global-serialize
- [ ] Đo per-test trước/sau: 3 thủ phạm ≤3s; full suite giảm ~40%+ (dán số)
- [ ] Không đụng file ngoài `touches`
- [ ] `status: review` + `finished_at` + "Đã làm gì" (nêu cơ chế clock + fix combo + số đo)

## Test phải viết
Không thêm test tính năng. Bằng chứng = per-test timing trước/sau + 3× full-suite
xanh. 3 test hiện có vẫn phải khẳng định đúng hành vi cũ (409 cutoff, combo song song
báo trước) — chỉ nhanh hơn.

## Định nghĩa "xong"
Full E2E ~nửa thời gian cũ (đo được), 3 thủ phạm ≤3s mỗi cái, mọi assertion giữ
nguyên, 3× xanh tất định.

## Cạm bẫy đã biết
- **Đừng nhầm 2 cutoff = xong.** Có 3 thủ phạm; test combo 22.5s là loại khác.
- Clock injection phải qua cơ chế test-only T-21 đã có — đừng thêm nhánh giờ giả vào
  production logic.
- Giữ đúng ngữ nghĩa cutoff 2h (server-side, không nới) — chỉ đổi CÁCH test tới mốc,
  không đổi mốc.

## Đã làm gì

### Cơ chế clock tái dùng (2 test cutoff) — KHÔNG chế mới
T-21 đã có: `serverNow(c)` trong `src/worker/lib/clock.ts` đọc header `X-Test-Now`
(epoch giây) CHỈ khi env có `TEST_CLOCK==='1'`. `.dev.vars` đã bật `TEST_CLOCK=1`.
Route huỷ (`src/worker/routes/cancel.ts:43`) dùng `serverNow(c)` để so cutoff 120'.
Mẫu set giờ từ E2E đã có sẵn ở `admin-walkin-reassign.spec.ts:205`:
`page.setExtraHTTPHeaders({ 'X-Test-Now': ... })` — browser gắn header đó vào MỌI
request, gồm cả POST cancel. Tái dùng đúng cơ chế này, KHÔNG thêm nhánh giờ giả vào
production, KHÔNG đụng `clock.ts`.

Điểm mấu chốt khiến bỏ được cuộc CHỜ: đồng hồ UI và đồng hồ server TÁCH RỜI.
- UI hiện nút Huỷ dựa trên `hoursUntil(start_at)` tính bằng đồng hồ TRÌNH DUYỆT
  (`src/app/routes/lookup/format.ts:47`, `Date.now()`).
- `GET /api/bookings?phone=` (bookings.ts:238) KHÔNG đọc "now" → chèn X-Test-Now
  không làm mất booking khỏi lookup, nút Huỷ vẫn render.
- Chỉ POST cancel đọc X-Test-Now.

Cách làm: seed booking `start_at = now_thật + 180'` (UI thấy còn >2h → hiện nút
Huỷ), set `X-Test-Now = start_at - 120' + 60s` (server thấy đã QUA cutoff, nhưng
vẫn trước start_at nên booking còn "sắp tới"). Bấm Huỷ → server trả 409
CANCEL_TOO_LATE TỨC THÌ. Bỏ toàn bộ `expect.poll(...)` chờ đồng hồ thật + bỏ
`test.setTimeout(90_000)`. Assertion GIỮ NGUYÊN: vẫn 409 → hiện `tel:` (hotline),
không lộ `CANCEL_TOO_LATE`/`error`.

### Chẩn đoán combo 22.5s (bằng chứng, không đoán) + fix
`customer-combo.spec.ts:223` (song song, chỉ 1 super-tech). Vòng lặp cũ
(dòng 250–261) duyệt 14 nút ngày, MỖI ngày `.ccf-bk-slot.waitFor({timeout:1500})`
chờ MÙ một slot song song KHÔNG BAO GIỜ xuất hiện (1 người không làm song song
được) → 14 × 1500ms ≈ 21s + overhead = 22.5s đo được. KHÔNG phải retry/poll
backend, KHÔNG phải backend chậm — thuần là NGÂN SÁCH TIMEOUT đốt cho mỗi ngày.
Đây KHÔNG phải vấn đề seed/`_seed.ts` giải được (test này tự dựng fixture qua
`/api/admin/*`, không đụng `_seed.ts`) → fix đúng chỗ là ở client-wait.

Fix: mỗi ngày CHỜ ĐÚNG tín hiệu ĐÃ-XONG thay vì chờ mù — race giữa slot xuất hiện
(`.ccf-bk-slot`) và tín hiệu "không đủ người" (`combo-time-empty` khi coverable &
slots rỗng — đúng ca super-tech; hoặc `combo-parallel-uncoverable`). Một trong hai
CHẮC CHẮN xảy ra sau khi `getComboAvailability` resolve → giải quyết nhanh như một
lần fetch (~sub-second) thay vì 1500ms cứng. Khẳng định GIỮ NGUYÊN: vẫn duyệt MỌI
ngày, `foundParallelSlot === false`, nút tiếp tục vẫn disabled.

`_seed.ts` trong `touches` nhưng KHÔNG cần sửa: cả 3 fix nằm gọn trong 3 spec.

### Số đo per-test trước/sau (CI=true, đo thực)
| Test | Trước | Sau |
|---|---|---|
| customer-lookup.spec.ts:149 (409 CANCEL_TOO_LATE) | 31.4s | 0.31s |
| flows/cancel-too-late-hotline.spec.ts:6 | 31.9s | 0.35s |
| customer-combo.spec.ts:223 (song song 1 người) | 22.5s | 1.8s |

Cả 3 ≤3s. (Chạy 3-file subset: 2.2m → 48.5s, 54 passed.)

### Full-suite trước/sau + 3× (CI=true npm run e2e)
- Trước (main, đo lại): ~140s. Sau: **~50s** (giảm ~64%).
- 3× liên tiếp: Run1 wall 77s, Run2 50s, Run3 51s. Run2 & Run3 xanh sạch
  (103 passed, 1 skipped tồn tại từ trước). Cả 3 target ≤3s ở CẢ 3 lần.

### Cạm bẫy gặp phải — flake TỒN TẠI TRƯỚC ở file NGOÀI phạm vi
Run1 có 1 đỏ: `customer-reschedule.spec.ts:43` (timeout 30s khi `.click()` slot đổi
giờ). File này KHÔNG trong `touches`. Đã CHỨNG MINH đây là flake tồn tại từ trước,
KHÔNG do T-35: stash 3 thay đổi của T-35, chạy lại project `chromium-d1-seed` trên
main NGUYÊN BẢN → reschedule cũng ĐỎ ngay ở lần 2 (timeout 30s, cutoff test vẫn
31.5s tức chưa có fix của mình). Cơ chế: test này đọc `data-testid` của slot đầu
rồi mới `.click()`, trong khi lưới slot tự refetch (`useEffect [dateStr,variant_id]`
ở LookupPage:320) khi availability đổi do các spec anh em seed booking cho 'Lan' →
phần tử detach giữa read-rồi-click. Tần suất tương đương trên cả hai (main ~1/6,
nhánh T-35 ~1/3). Theo luật card (chỉ đụng `touches`, KHÔNG nới assertion, KHÔNG
thêm Playwright retries) → KHÔNG sửa ở đây, báo lại. T-35 không làm nó tệ hơn; chỉ
làm 2 test cutoff chạy nhanh hơn nên cửa sổ race lộ ra ở lần chạy khác. Đề xuất: một
card riêng sửa read-then-click của `customer-reschedule.spec.ts` (neo click theo
testid ổn định / chờ lưới settle), ngoài phạm vi T-35.

### Kiểm chứng khác
- `npm run typecheck`: xanh.
- `npm test` (unit/API): **442 passed** (27 files) — giữ ≥442.
- KHÔNG thêm Playwright `retries`, KHÔNG global-serialize, KHÔNG đụng file ngoài
  `touches` (chỉ sửa 3 spec).
