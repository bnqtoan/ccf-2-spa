---
id: T-26
title: R1b — Combo song song (nhiều KTV làm cùng lúc)
status: review
model: opus
effort: high
depends_on: [T-19]      # combo serial R1a (đã merge) — mở rộng lib combo
touches:
  - src/worker/lib/combo.ts
  - src/worker/routes/combo.ts
  - src/worker/db/bookings.ts
  - src/app/routes/booking/
  - tests/
prd_refs: ["§1"]
owner: null
started_at: null
finished_at: null
---

# T-26 · R1b — Combo song song (nhiều KTV cùng lúc)

## Mục tiêu
Combo serial (R1a) đã có: nhiều dịch vụ, MỘT KTV làm nối tiếp. R1b thêm kiểu
**song song**: nhiều dịch vụ do NHIỀU KTV làm CÙNG LÚC (vd massage + làm móng đồng
thời) → khách xong nhanh hơn. Khách CHỌN kiểu (nối tiếp hay song song).

## Ngữ cảnh cần biết (product owner đã chốt)
- Làm CẢ HAI kiểu, khách chọn (bản đầy đủ). R1a serial đã xong; card này thêm R1b.
- Song song: mỗi dịch vụ một KTV khác nhau, cùng khung giờ (hoặc gối nhau), mỗi KTV
  đủ skill của dịch vụ mình làm (KHÁC serial: 1 KTV đủ MỌI skill).
- Body_zone: 2 dịch vụ song song KHÔNG được cùng body_zone (không thể làm 2 thứ
  trên cùng vùng cơ thể cùng lúc) — dùng lại rule zone-conflict đã có.

## Phạm vi
**Trong:**
- `lib/combo.ts`: thêm layout SONG SONG — cấp phát nhiều KTV cho các leg cùng khung
  giờ, validate: mỗi leg một KTV đủ skill, không 2 leg cùng body_zone chồng giờ,
  mỗi KTV không bận. Tìm khung giờ mà ĐỦ số KTV rảnh đồng thời.
- `routes/combo.ts`: availability + booking cho mode song song. Body có `mode:
  'serial'|'parallel'`. Song song: trả slot kèm KTV cho từng leg; đặt = nhiều
  booking_item cùng appointment, cùng/gối khung giờ, KTV khác nhau, NGUYÊN TỬ.
- SPA BookingPage: sau khi chọn ≥2 dịch vụ → chọn KIỂU (nối tiếp/song song) →
  grid phù hợp. Song song hiện "được làm bởi ai, lúc nào".

**Ngoài:**
- KHÔNG phòng/giường như tài nguyên (C9, PRD hoãn) — song song giả định đủ chỗ.
- KHÔNG trộn nửa-serial-nửa-song song trong một combo (chọn một kiểu cho cả combo).

## Đầu vào đã có
- `lib/combo.ts`: `comboTotalBlockSec`, `requiredSkillIds`, `coversAllSkills`,
  `ComboLeg`, `layoutChain` (serial) — mở rộng, đừng phá serial.
- `routes/combo.ts`: POST /api/combo/availability + /api/combo/bookings (serial).
- Body_zone conflict rule (admin-appointment-items.ts) — tái dùng.
- validateBooking + SQL-guard atomic (db/bookings.ts).

## Việc phải làm
1. lib/combo: hàm layout song song + tìm khung đủ N KTV rảnh + validate zone/skill.
2. routes/combo: mode param; availability + booking song song nguyên tử (nhiều item).
3. UI: chọn kiểu; grid + hiển thị "ai làm gì lúc nào" cho song song.

## Quy ước bắt buộc (CONVENTIONS)
- §6 validate đầy đủ mỗi leg. §5 mã lỗi cũ (ZONE_CONFLICT/SLOT_TAKEN/...). §7 route.
- Đặt song song NGUYÊN TỬ: hoặc tất cả leg đặt được, hoặc không leg nào (không để
  nửa combo). §8/§9.

## Checklist đầu ra
- [x] typecheck · npm test · e2e --workers=1 xanh (serial R1a KHÔNG hồi quy)
- [x] status review + "Đã làm gì"

## Test phải viết
- `song song 2 dịch vụ, 2 KTV đủ skill, khác zone → đặt được, 2 item cùng appointment`
- `song song mà chỉ đủ 1 KTV rảnh khung đó → coverable:false, báo trước khi đặt`
- `song song 2 dịch vụ cùng body_zone → bị chặn (không làm cùng vùng cùng lúc)`
- `đặt song song mà 1 leg bị cướp KTV giữa chừng → KHÔNG leg nào đặt (nguyên tử), báo`
- `serial R1a vẫn hoạt động nguyên vẹn (không hồi quy)`
- E2E: `khách chọn 2 dịch vụ → chọn song song → thấy 2 KTV/2 giờ → đặt thành công`

## Định nghĩa "xong"
Khách đặt được combo song song (nhiều KTV cùng lúc), thấy rõ ai làm gì; đặt nguyên
tử (không nửa combo); serial R1a không hồi quy.

## Cạm bẫy đã biết
- **Silent side-effect:** đặt song song không nguyên tử → nửa combo (1 leg đặt, 1
  fail) → khách tưởng đủ mà thiếu. PHẢI test "1 leg bị cướp → không leg nào đặt".
- Song song ≠ serial: đừng ép 1 KTV đủ mọi skill. Mỗi leg KTV riêng.
- Tìm khung đủ N KTV rảnh ĐỒNG THỜI là phần khó nhất — cẩn thận độ phức tạp query.

## Đã làm gì

Thêm combo SONG SONG (R1b) bên cạnh serial R1a, khách CHỌN kiểu ở màn combo-time.

**Mô hình song song đã chốt:** mọi leg bắt đầu CÙNG `start_at`, mỗi leg 1 KTV
RIÊNG đủ skill CỦA LEG ĐÓ (khác serial: 1 KTV đủ MỌI skill). Vì mọi leg chồng
giờ nhau → tất cả body_zone phải KHÁC nhau (thuộc tính của TẬP dịch vụ, báo
`coverable:false` trước khi đặt). Xong sau ~ leg dài nhất (không cộng dồn).

**lib/combo.ts (thuần, không D1):**
- `parallelZonesDistinct`, `parallelSpanSec`.
- `assignParallel` — bipartite matching (Kuhn augmenting-path) gán mỗi leg 1 KTV
  KHÁC NHAU đủ skill + rảnh; trả `null` khi không có matching hoàn hảo. Leg ít →
  nhanh & tất định (candidate list tăng dần → matching đầu tiên ổn định giữa
  preview và write).
- `computeParallelAvailability` — mỗi grid start: dựng candidate mỗi leg (skill +
  cả window nằm gọn 1 shift + rảnh), rồi `assignParallel`. Slot sống chỉ khi có
  matching.
- `layoutParallel` — mọi item cùng start, mỗi item mang staff_id được gán.

**routes/combo.ts (MỞ RỘNG, serial giữ nguyên):** thêm `mode:'serial'|'parallel'`
(mặc định serial → R1a caller cũ không đổi). Parallel availability: coverable =
mọi leg có KTV + zones distinct; load shift/timeoff/busy cho MỌI KTV đủ skill BẤT
KỲ leg. Parallel booking `bookParallel`: NGUYÊN TỬ — 1 appointment + N item trong
1 `db.batch`, MỌI statement gác trên `allFreeGuard` (AND của "từng KTV rảnh window
leg mình" trên PRE-EXISTING). 1 leg bị cướp KTV → appointment không insert →
`last_insert_rowid()` vô dụng + guard chặn item → KHÔNG leg nào ghi (không nửa
combo). Items 1 statement multi-row VALUES để `last_insert_rowid()` = appointment
cho mọi row. `staff_id` bị TỪ CHỐI (422) ở parallel (N KTV, không phải 1). Phản
hồi parallel: `staff:null` + `staff_by_id` roster để UI hiện "ai làm gì".

**SPA BookingPage.tsx:** màn combo-time thêm bước CHỌN KIỂU (2 card serial/parallel
giải thích rõ khác biệt + thời gian ~). Parallel: slot → hiện "AI LÀM GÌ LÚC NÀO"
(mỗi dịch vụ · KTV #x · giờ) TRƯỚC khi cam kết. Confirm/Done hiện kiểu + KTV từng
leg. Uncoverable serial gợi ý thử song song; uncoverable parallel gợi ý trùng zone/
thiếu KTV. apiClient: `mode` trong ComboMode + `staff_by_id` trong result.

**GATE 1 (5 câu, đã trả lời trong session):** actor=khách thật chọn ≥2 dịch vụ
muốn xong nhanh; coverage layers = skill-per-leg + N-tech đồng thời + zone-set +
atomicity; ràng buộc HIỆN TRƯỚC (uncoverable/zone/thiếu người → báo trước, chỉ
race thật → SLOT_TAKEN quay lại chọn giờ); parallel≠serial (KTV riêng/leg, KHÔNG
ép 1 KTV đủ mọi skill, KHÔNG layout nối tiếp); atomicity = all-or-none 1 batch.

**GATE 2:** typecheck sạch · vitest 396 pass (unit 18 combo + api 17 combo mới,
gồm test "1 leg bị cướp KTV → 0 leg đặt, no half-combo") · e2e --workers=1: 88
pass / 1 skip (serial R1a + mọi flow KHÔNG hồi quy) trên PORT RIÊNG 5199 (5173 do
main worktree chiếm). Xác minh mắt: khách chọn Massage+Móng → song song → thấy KTV
#23 (15:45–16:45) + KTV #25 (15:45–16:30) cùng bắt đầu → đặt được, không nửa combo.

**Test đã viết (đúng card):** song song 2 dịch vụ 2 KTV khác zone → đặt được 2 item
cùng appointment KTV khác nhau · chỉ đủ 1 KTV (dù đủ mọi skill) → coverable nhưng
0 slot, báo trước · 2 leg cùng body_zone → bị chặn (ZONE_CONFLICT/coverable:false) ·
1 leg bị cướp KTV → KHÔNG leg nào đặt (nguyên tử) · serial R1a không hồi quy · E2E
khách chọn song song thấy ai làm gì → đặt thành công.

**File đụng:** src/worker/lib/combo.ts, src/worker/routes/combo.ts,
src/app/routes/booking/BookingPage.tsx, src/app/lib/apiClient.ts,
tests/unit/combo.test.ts, tests/api/combo.test.ts, tests/e2e/customer-combo.spec.ts.
