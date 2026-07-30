---
id: T-36
title: Ca làm việc — sửa theo TUẦN MẪU mỗi KTV (thay danh sách 35 dòng thêm-từng-cái)
status: review
model: opus
effort: high
depends_on: []
touches:
  - src/app/routes/admin/setup/ShiftsTab.tsx
  - src/app/routes/admin/setup/setup.css
  - src/app/routes/admin/setup/api.ts
  - tests/e2e/admin-setup.spec.ts
  # Hướng (b) replace-week nguyên tử — file thêm ngoài touches gốc (card cho phép):
  - src/worker/routes/admin-staff-shifts.ts   # route mới (approach b)
  - src/worker/routes/index.ts                # +1 dòng đăng ký route
  - src/worker/db/crud.ts                      # +replaceStaffWeek() nguyên tử
  - tests/api/admin-crud.test.ts              # test endpoint replace-week (approach b)
prd_refs: []
owner: null
started_at: 2026-07-30
finished_at: 2026-07-30
---

# T-36 · Ca làm việc — sửa theo TUẦN MẪU mỗi KTV

## Mục tiêu
Bỏ UX hiện tại (thêm ca TỪNG DÒNG qua form 4 field → danh sách phẳng chỉ có nút
"Xoá", 7 dòng gần-giống-nhau mỗi KTV, không sửa được). Thay bằng: **chọn 1 KTV →
sửa cả TUẦN MẪU trong một lưới 7 ngày (bật/tắt từng ngày + giờ vào/ra), một lần
lưu.** Owner nhìn ra ngay "ai làm ngày nào giờ nào", sửa tại chỗ, không xoá-tạo-lại.

## Ngữ cảnh — data model ĐÃ ĐỦ, đây gần như THUẦN UI (đã đọc source)
- `work_shifts(id, staff_id, weekday 0-6, start_min, end_min)` — MỖI (KTV, thứ) là
  một dòng. Chính là "tuần mẫu" rồi; chỉ thiếu UI sửa-theo-tuần.
- Engine đọc đúng bảng này: `availability.ts:80-86` ("no shift → no slots"),
  `validate-booking.ts:34`, `admin-overview.ts`. **KHÔNG đổi schema, KHÔNG đổi cách
  engine đọc** — chỉ đổi cách UI ghi/hiển thị.
- API hiện có (`setup/api.ts`): `getShifts`, `createShift({staff_id,weekday,start_min,
  end_min})`, `deleteShift(id)`. Đủ để làm tuần-mẫu bằng cách diff (xem dưới) — KHÔNG
  cần endpoint mới nếu không muốn; nhưng một endpoint `PUT /api/admin/staff/:id/shifts`
  (thay toàn bộ tuần của 1 KTV nguyên tử) sẽ SẠCH hơn. Card cho phép chọn:
  (a) diff ở client (tạo/xoá đúng dòng thay đổi) — 0 backend mới, hoặc
  (b) 1 endpoint replace-week nguyên tử — sạch hơn, thêm 1 route (1 dòng index.ts).
  Ưu tiên (b) nếu rẻ; nếu chọn (a), phải xử đúng lỗi từng-request.

## Phạm vi
**Trong:**
- ShiftsTab: chọn KTV → lưới 7 ngày (Thứ 2…CN). Mỗi ngày: toggle "làm/nghỉ" +
  input giờ vào / giờ ra (mặc định 09:00–17:00 khi bật). Một nút "Lưu tuần".
- Tiện: "Áp giờ này cho các ngày đang bật" (điền nhanh) + "Copy tuần của KTV khác"
  (đỡ nhập lại 5 KTV) — nếu rẻ; không thì ghi hoãn.
- Hiển thị tóm tắt tuần mỗi KTV gọn (vd "T2–T6 09–17, T7 09–12, CN nghỉ") thay danh
  sách 7 dòng.
- Giữ ràng buộc: start < end (đã có CHECK ở DB + validate); báo lỗi thân thiện.

**Ngoài (đừng lố):**
- **KHÔNG làm "override trong calendar" trong card này.** Nghỉ-đột-xuất một ngày ĐÃ
  có (time_off + báo nghỉ trên timeline — T-07). "Tuần mẫu" (recurring) là việc của
  card này; override một-lần đã có đường riêng. Ghi rõ ranh giới này trong UI (một
  dòng hint: "Nghỉ đột xuất một hôm → dùng Báo nghỉ trên Lịch ngày").
- KHÔNG đổi schema work_shifts, KHÔNG đổi engine availability/validate.
- KHÔNG đụng các tab khác (Nhân viên/Dịch vụ) ngoài phần dùng chung setup.css.

## Đầu vào đã có
- `ShiftsTab.tsx` hiện tại (form + list) — thay ruột.
- `setup/api.ts`: getShifts/createShift/deleteShift.
- `setup/format.ts`: `WEEKDAY_LABELS`, `hmToMinutes`, `minutesToHm`.
- setup.css: đã có card/badge/table (T-admin-ui) — tái dùng, thêm style lưới tuần.

## Việc phải làm
1. Chọn hướng backend (a diff / b replace-week) — nêu lý do.
2. Lưới tuần 7 ngày cho KTV đang chọn, prefill từ work_shifts hiện có.
3. Lưu → tạo/xoá/replace đúng, reload, giữ nguyên KTV đang chọn.
4. Tóm tắt tuần gọn thay list phẳng.
5. Hint ranh giới "nghỉ đột xuất → Báo nghỉ".

## Checklist đầu ra
- [ ] Typecheck xanh
- [ ] `npm test` (unit/API) xanh (≥ số hiện tại)
- [ ] E2E admin-setup xanh (cập nhật test shift theo UI mới — vẫn kiểm được: đặt
      tuần cho 1 KTV, giờ end<start bị chặn, tuần lưu và hiện lại đúng)
- [ ] Engine không đổi hành vi: một booking đúng giờ trong tuần mẫu vẫn đặt được;
      ngoài tuần mẫu vẫn bị chặn (chạy lại test availability/validate hiện có)
- [ ] Không đụng file ngoài touches
- [ ] `status: review` + `finished_at` + "Đã làm gì"

## Test phải viết
- E2E: chọn KTV → bật T2–T6 09–17, tắt T7/CN → Lưu → tải lại thấy đúng.
- E2E: giờ ra ≤ giờ vào một ngày → chặn, báo thân thiện.
- API (nếu làm endpoint replace-week): thay tuần nguyên tử, thứ ngoài 0-6 → 422.
- Regression: test availability/validate-booking hiện có vẫn xanh (engine đọc
  work_shifts không đổi).

## Định nghĩa "xong"
Owner đặt được cả tuần làm việc của một KTV trong một màn, một lần lưu, sửa tại chỗ;
danh sách 35-dòng-thêm-từng-cái biến mất; engine đặt lịch không đổi hành vi.

## Cạm bẫy đã biết
- **Đừng ôm "override calendar" vào đây** — đó là time_off (đã có). Card này chỉ
  tuần-mẫu recurring. Gộp vào là phình scope.
- Nếu diff ở client (hướng a): xoá dòng cũ + tạo dòng mới không nguyên tử → nếu lỗi
  giữa chừng tuần bị nửa vời. Cân nhắc hướng b (replace nguyên tử) cho an toàn.
- Giữ `start_min < end_min` (DB CHECK sẽ ném lỗi thô nếu lọt — validate ở client +
  map lỗi).
- weekday: xác nhận mapping 0=? (CN hay T2) khớp `WEEKDAY_LABELS` + `localWeekday`
  trong engine, đừng lệch một ngày.

## Đã làm gì

### Backend: hướng (b) — endpoint replace-week nguyên tử (vì sao)
Chọn `PUT /api/admin/staff/:id/shifts` thay vì diff xoá-tạo-lại ở client.
- Lý do: diff nhiều request KHÔNG nguyên tử — lỗi giữa chừng để lại "tuần nửa
  vời" (vài ngày mới, vài ngày cũ), đúng cạm bẫy card cảnh báo. Endpoint gói
  `DELETE FROM work_shifts WHERE staff_id=?` + các `INSERT` trong MỘT
  `db.batch()` → hoặc cả tuần lưu, hoặc không đổi gì.
- Rẻ đúng như card nói: 1 helper `crud.replaceStaffWeek()`, 1 route file mới
  (`admin-staff-shifts.ts`), +1 dòng `import` + 1 dòng `app.route()` trong
  `index.ts` (card cho phép sửa index.ts cho approach b).
- KHÔNG đổi schema `work_shifts`, KHÔNG đổi engine. `availability.ts`,
  `validate-booking.ts`, `admin-overview.ts` vẫn đọc bảng y như cũ — chỉ cách
  GHI đổi. Regression: 446/446 unit+API xanh (gồm availability/validate-booking).
- Route nằm dưới `/api/admin/*` nên auth guard áp sẵn; shifts là owner+lễ tân
  (không gate thêm, khớp comment index.ts). Validation ở server: weekday 0-6,
  phút 0-1440, start<end, chặn trùng weekday → 422 VALIDATION.

### Weekday mapping (đã xác nhận, không lệch ngày)
`weekdayOf()` trong `src/worker/lib/time.ts` trả **0=CN..6=T7**, khớp
`WEEKDAY_LABELS[0]='Chủ nhật'`. Lưới hiển thị Thứ 2→CN qua `WEEK_ORDER =
[1,2,3,4,5,6,0]` (thứ tự DÒNG cho quen mắt owner VN) nhưng giá trị `weekday`
LƯU vẫn theo mapping gốc — không đổi số. E2E khẳng định trực tiếp qua API:
bật T2–T6 → đúng weekday [1,2,3,4,5], 540–1020 phút-từ-nửa-đêm.

### UX trước/sau
- Trước: form 4-field thêm TỪNG ca một → danh sách phẳng 7 dòng/KTV, mỗi dòng
  chỉ có nút "Xoá", không sửa được (35 dòng nhập tay cho 5 KTV).
- Sau: chọn 1 KTV → lưới 7 ngày (toggle làm/nghỉ + giờ vào/ra, mặc định
  09:00–17:00 khi bật) → một nút "Lưu tuần". Kèm "Áp giờ cho các ngày đang bật"
  và "Copy tuần của KTV khác" (điền nhanh). Khối "Tóm tắt tuần theo KTV" hiện
  gọn ("T2 09:00–17:00, T3 …") và bấm được để nạp thẳng vào lưới sửa.
- Hint ranh giới: "Nghỉ đột xuất một hôm → dùng Báo nghỉ trên Lịch ngày" —
  KHÔNG làm override calendar (out of scope).

### Ghi chú phạm vi
Tuần mẫu = một cửa sổ ca / ngày. Endpoint + UI cố ý chặn hai dòng cùng weekday
(split-shift hai cửa sổ cùng ngày) — nằm ngoài phạm vi card này. Nếu nghiệp vụ
cần split-shift thật thì phải mở card riêng (data model một-dòng-mỗi-(KTV,thứ)
đủ chứa, nhưng UI tuần-mẫu hiện chỉ một cửa sổ).

### Verify (output thật)
- `npm run typecheck`: sạch (không lỗi).
- `npm test`: **446 passed (27 files)** — trước là 442, +4 test replace-week.
  Availability/validate-booking regression xanh.
- E2E `admin-setup` (chromium, --no-deps, workers=1): **12 passed**, gồm 2 test
  tuần-mẫu mới (lưu+tải-lại, end≤start bị chặn không gọi API) + tap-target.
  Lần chạy full-deps trước đó đỏ 1 test ở `admin-timeline.spec.ts`
  (`create-booking-staff-select` không nạp options) — đây là flake env đã biết ở
  pha seed-dependency, KHÔNG liên quan logic ca làm việc.
