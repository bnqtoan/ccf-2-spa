---
id: T-35
title: E2E nhanh gấp đôi — khử 3 test chờ đồng-hồ-thật (86s/140s)
status: todo
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
started_at: null
finished_at: null
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
(agent điền khi xong)
