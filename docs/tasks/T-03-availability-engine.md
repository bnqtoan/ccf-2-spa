---
id: T-03
title: Availability engine (hàm thuần) + GET /api/availability
status: todo
model: opus
effort: high
depends_on: ["T-02"]
touches:
  - src/worker/lib/time.ts
  - src/worker/lib/intervals.ts
  - src/worker/lib/availability.ts
  - src/worker/routes/availability.ts
  - src/worker/routes/index.ts
  - tests/api/availability.test.ts
  - tests/unit/intervals.test.ts
prd_refs: ["§3.1", "§4", "§11"]
owner: null
started_at: null
finished_at: null
---

# T-03 · Availability engine + GET /api/availability

## Mục tiêu
Trả lời đúng một câu hỏi: **"Ngày X, gói dịch vụ Y, có thể bắt đầu vào những giờ
nào, và ai làm được?"** — đã trừ ca làm việc, nghỉ phép, booking đã có, và buffer
dọn dẹp. Đây là nền của mọi thứ: T-04 dùng lại nó làm kiểm tra chân lý trước khi
ghi, T-07 dùng lại để tìm người thay thế.

## Ngữ cảnh cần biết
Thuật toán đã chốt nguyên văn ở PRD §4:

```
1. Load variant → duration_min, buffer_after_min, service.skill_id
   block = duration_min + buffer_after_min
2. candidates = active staff having skill_id
   if preferred_staff_id: narrow to that one
3. for each candidate:
   a. work_shifts for that weekday → working window(s)
   b. subtract time_off intervals intersecting the day
   c. subtract booking_items where status IN ('booked','in_service'),
      using [start_at, block_end_at)
   → list of free intervals
   d. walk the 15-minute grid inside each free interval; keep t if
      [t, t + block) fits entirely within that free interval
4. Group by time: each distinct t → list of staff available at t
5. Return slots [{ start_at, staff_ids[] }]
```

Quy tắc lõi (PRD §3.1): KTV bị chiếm trong `[start_at, block_end_at)`.
**`end_at` không bao giờ được dùng để kiểm tra rảnh/bận.**

Auto-assign chọn từ `staff_ids` theo **ít phút đã đặt nhất trong ngày** (cân
bằng tải), hoà thì lấy `staff_id` nhỏ hơn cho tất định.

Quy mô thật: dưới 20 KTV, một ngày, lưới 15 phút. Brute-force là đúng và đủ
nhanh. **Không tối ưu sớm** — PRD nói thẳng điều này.

## Phạm vi
**Trong:**
- `src/worker/lib/intervals.ts` — đại số khoảng thuần: `subtract`, `overlaps`,
  `merge`. Không biết gì về spa.
- `src/worker/lib/time.ts` — quy đổi epoch ↔ giờ địa phương, lấy `weekday`,
  biên ngày địa phương, làm tròn lưới 15 phút.
- `src/worker/lib/availability.ts` — hàm thuần `computeAvailability(input)` nhận
  **dữ liệu đã load sẵn**, không tự query D1.
- `src/worker/routes/availability.ts` — load dữ liệu từ D1 rồi gọi hàm thuần.
- `GET /api/availability?variant_id&date[&staff_id]`

**Ngoài:**
- Không ghi gì vào DB. Task này chỉ đọc.
- Không xử lý combo nhiều item (v2).
- Không làm UI.
- Không cache. Availability luôn tính live từ `booking_items`.

## Đầu vào đã có
- T-02 để lại: đủ bảng + index + seed. `src/worker/db/types.ts` có type từng bảng.
- Index `booking_items(staff_id, start_at)`, `time_off(staff_id, start_at)`,
  `work_shifts(staff_id, weekday)`, `staff_skills(skill_id)` đã có sẵn — dùng đúng
  chúng, đừng quét toàn bảng.

## Việc phải làm
1. **`intervals.ts`** — hàm thuần trên `{start, end}` (nửa mở):
   - `overlaps(a, b)` → `a.start < b.end && b.start < a.end`
   - `subtract(base, holes[])` → mảng khoảng còn lại
   - `mergeOverlapping(list)`
   Không phụ thuộc timezone, không phụ thuộc domain.
2. **`time.ts`** — dùng `Intl.DateTimeFormat` với `SPA_TZ`:
   - `localDayBounds(dateStr)` → `{start, end}` epoch của ngày địa phương
   - `weekdayOf(dateStr)` → 0–6
   - `minutesToEpoch(dayStart, minutes)` — ghép `work_shifts.start_min` vào ngày
   - `isOnGrid(epoch)` → đúng bội 15 phút **theo giờ địa phương**
3. **`availability.ts`** — `computeAvailability({ variant, service, staff[],
   shifts[], timeOff[], busyItems[], dayStart, dayEnd, now })`:
   - Trả `{ start_at, staff_ids[] }[]`, sắp xếp tăng dần theo `start_at`
   - Loại slot bắt đầu trong quá khứ (so với `now`)
   - Với mỗi KTV: shift → trừ time_off → trừ busy → quét lưới 15'
   - Chỉ giữ `t` khi **cả** `[t, t+block)` nằm gọn trong một khoảng rảnh
4. **Route** — parse + validate query, load dữ liệu bằng số câu query cố định
   (không N+1: load hết shift/time_off/busy của tập KTV ứng viên trong 1 câu mỗi
   loại), gọi hàm thuần, trả JSON.
5. Lỗi: thiếu/sai `variant_id` hay `date` → 422 `VALIDATION`; variant không tồn
   tại → 404 `NOT_FOUND`.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §1 (thời gian), §2 (chiếm chỗ), §3 (trạng thái),
§5 (API), §7 (logic thuần tách khỏi D1), §8 (test).

Nhấn lại ba điều:
- Khoảng là **nửa mở** `[start, end)`. Kề nhau không phải chồng nhau.
- Availability chỉ đếm `status IN ('booked','in_service')`.
- Hàm trong `lib/` **không được import D1**.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test -- tests/unit/intervals.test.ts` xanh
- [ ] `npm test -- tests/api/availability.test.ts` xanh
- [ ] `src/worker/lib/*.ts` không import gì từ D1 (kiểm bằng grep)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết

`tests/unit/intervals.test.ts` (thuần, không DB)
- `hai khoảng kề nhau không tính là chồng nhau`
- `subtract khoét lỗ giữa trả về hai khoảng`
- `subtract lỗ trùm hết trả về mảng rỗng`
- `subtract lỗ nằm ngoài giữ nguyên khoảng gốc`
- `subtract nhiều lỗ chồng nhau xử lý đúng`

`tests/api/availability.test.ts` (D1 thật)
- `KTV không có ca ngày đó thì không xuất hiện slot nào`
- `KTV có ca nhưng không có skill của service thì bị loại`
- `KTV inactive bị loại`
- `slot cuối ngày bị loại nếu buffer tràn qua giờ đóng cửa`
- `booking đã có che đúng khoảng bận, kể cả phần buffer`
- `slot ngay sau block_end_at của booking trước là hợp lệ (kề nhau, không chồng)`
- `time_off cắt đúng khoảng rảnh trong ca`
- `booking status cancelled không chiếm chỗ`
- `booking status no_show không chiếm chỗ`
- `booking status in_service vẫn chiếm chỗ`
- `truyền staff_id thì chỉ trả slot của đúng người đó`
- `hai KTV cùng rảnh một giờ thì slot đó có 2 staff_ids`
- `mọi start_at trả về đều rơi đúng lưới 15 phút`
- `slot trong quá khứ của ngày hôm nay bị loại`
- `variant_id không tồn tại trả 404 NOT_FOUND`
- `thiếu date trả 422 VALIDATION`
- `variant duration khác nhau cho ra tập slot khác nhau (90' ít slot hơn 45')`

## Định nghĩa "xong"
Với dữ liệu seed, gọi `GET /api/availability?variant_id=<massage 90'>&date=<ngày
có ca>` trả về danh sách slot mà **mọi slot đều thoả**: có ít nhất một KTV có
skill Massage, đang trong ca, không nghỉ phép, và khoảng `[t, t+90+15)` không
chồng bất kỳ `[start_at, block_end_at)` nào đang `booked`/`in_service`.

## Cạm bẫy đã biết
- **Dùng `end_at` thay `block_end_at` là lỗi im lặng.** Test một booking đơn lẻ
  vẫn xanh; chỉ sai khi hai booking sát nhau — đúng lúc quán đông. Test
  `slot ngay sau block_end_at...` là chốt chặn cho lỗi này, đừng bỏ.
- **Nhầm nửa mở thành đóng** làm mất một slot hợp lệ ở mỗi ranh giới. Rất khó
  nhận ra vì kết quả "trông vẫn hợp lý".
- **Timezone**: `new Date(epoch).getDay()` trả weekday theo giờ **máy chủ**, mà
  Worker chạy UTC. Ngày 2026-07-22 giờ VN bắt đầu từ 17:00 UTC ngày 21. Phải quy
  đổi qua `SPA_TZ`, không dùng getter local của `Date`.
- **N+1 query**: dễ viết vòng lặp query mỗi KTV một lần. Load theo lô.
- Lưới 15 phút tính theo **giờ địa phương**, không phải theo epoch chia hết cho
  900 — hai thứ này chỉ trùng nhau khi offset timezone là bội 15 phút (VN là
  +07:00 nên tình cờ trùng, nhưng đừng dựa vào sự tình cờ đó).

## Đã làm gì
(agent điền khi xong)
