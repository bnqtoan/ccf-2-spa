---
id: T-14
title: Bộ E2E xuyên suốt 4 luồng nghiệp vụ đầu-cuối
status: done
model: codex
effort: high
depends_on: ["T-10", "T-11", "T-12", "T-13"]
touches:
  - tests/e2e/flows/
  - playwright.config.ts
prd_refs: ["§5", "§6", "§7", "§8"]
owner: null
started_at: null
finished_at: "2026-07-22"
---

# T-14 · Bộ E2E xuyên suốt 4 luồng nghiệp vụ đầu-cuối

## Mục tiêu
Chứng minh toàn hệ thống — customer UI, admin UI, API, D1 thật — hoạt động
đúng khi ghép lại với nhau trên đúng 4 luồng nghiệp vụ cốt lõi của spa, cộng
một kịch bản đua thật. Đây là **cổng chất lượng cuối cùng trước khi deploy**
(T-15) — không có gì được coi là xong nếu bộ test này không xanh.

## Ngữ cảnh cần biết
Từng task T-01 đến T-13 đã tự test phần của mình (API riêng lẻ, UI riêng lẻ).
Card này **không viết lại** logic của các task đó — nó chỉ lắp ráp các mảnh
đã có thành 5 kịch bản chạy xuyên suốt trên app thật (Worker + D1 thật, không
mock), giống hệt cách một khách hàng hoặc lễ tân thật sẽ trải nghiệm.

5 kịch bản bắt buộc, nêu nguyên văn để không ai tự diễn giải khác đi:

1. **Khách đặt lịch → lịch xuất hiện đúng cột đúng giờ trên admin timeline.**
   Đặt một lịch qua luồng khách (T-10), sau đó mở timeline admin (T-12) và xác
   nhận đúng block xuất hiện ở đúng cột KTV, đúng vị trí giờ.
2. **Khách huỷ lịch xa → slot mở lại → khách khác đặt được ngay slot đó.**
   Huỷ một lịch còn xa giờ hẹn qua luồng tra cứu (T-11), sau đó dùng luồng đặt
   lịch (T-10) của một khách khác chọn đúng slot vừa trống và đặt thành công.
   Đây là bằng chứng sống rằng availability luôn tính live từ `booking_items`
   (PRD §5), không có bảng lịch vật lý nào cần dọn riêng.
3. **Khách huỷ lịch trong vòng 2h → nhận 409 CANCEL_TOO_LATE → UI hiện
   hotline.** Xác nhận đúng chính sách thương mại PRD §6: dưới cutoff không
   phải lỗi kỹ thuật, mà là thiết kế ép gọi điện để lễ tân có cơ hội xếp lại.
4. **Admin tạo time-off đè booking → booking vào hàng chờ → chuyển sang KTV đủ
   skill thành công → thử chuyển sang KTV thiếu skill bị chặn.** Chạy xuyên
   suốt PRD §8: tạo time-off không từ chối, hiện `affected_items`, hàng chờ
   xuất hiện trên timeline (T-12) và màn hàng chờ (T-13), chuyển KTV hợp lệ
   thành công và item rời hàng chờ, chuyển KTV không đủ skill bị chặn với lý
   do rõ ràng.

Thêm kịch bản đua (không đánh số trong 4 luồng chính nhưng bắt buộc như nhau):

5. **Hai tab cùng đặt một slot** — mở hai tab trình duyệt độc lập, cùng đi đến
   bước xác nhận cho cùng một slot/KTV, cùng bấm xác nhận gần như đồng thời.
   Đúng một tab thành công (thấy màn hoàn tất), tab còn lại nhận thông báo hết
   chỗ và danh sách slot được làm mới (không phải màn hình đứng yên hoặc lỗi
   trắng). Đây là bằng chứng UI thật sự xử lý đúng 409 `SLOT_TAKEN` từ T-04,
   không chỉ xử lý trên lý thuyết.

## Phạm vi
**Trong:**
- `tests/e2e/flows/` — 5 file spec riêng biệt, mỗi file một kịch bản
- Cấu hình `playwright.config.ts` nếu cần điều chỉnh để chạy ổn định các test
  đa tab / cần D1 sạch giữa các lần chạy (ví dụ project riêng cho
  `tests/e2e/flows`, timeout dài hơn cho kịch bản đua)

**Ngoài:**
- Không viết lại test đơn lẻ của T-01 đến T-13 — những test đó vẫn đứng độc
  lập, không bị xoá hay thay thế
- Không thêm tính năng nghiệp vụ mới — nếu phát hiện thiếu tính năng để chạy
  hết một kịch bản, dừng lại và báo, không tự chế thêm ngoài phạm vi các task
  trước
- Không chạy trên môi trường production — đây là gate trước deploy, không phải
  smoke test sau deploy (đó là T-15)

## Đầu vào đã có
- **T-10 để lại** luồng khách đặt lịch hoàn chỉnh (chọn dịch vụ → gói → giờ →
  xác nhận), đã tự xử lý 409 `SLOT_TAKEN` bằng cách làm mới slot.
- **T-11 để lại** luồng tra cứu + huỷ lịch, đã tự xử lý cutoff 2 tiếng và hiện
  hotline khi 409 `CANCEL_TOO_LATE`.
- **T-12 để lại** timeline admin đọc từ `GET /api/admin/schedule?date=` và
  `GET /api/admin/reassign-queue`.
- **T-13 để lại** sheet khách vãng lai, màn hàng chờ, sheet chuyển KTV với lý
  do loại rõ ràng.
- Toàn bộ API nền (T-02 đến T-08) đã chạy thật trên D1 qua
  `@cloudflare/vitest-pool-workers`/wrangler dev, không mock.
- `prototype/index.html` vẫn là tài liệu tham chiếu nếu cần đối chiếu lại một
  chi tiết giao diện khi viết selector cho test (ví dụ tên/nhãn nút chính xác).

## Việc phải làm
1. Xác định cách seed dữ liệu sạch cho mỗi test (KTV, dịch vụ, ca làm việc) —
   dùng lại helper seed nếu các task trước đã để lại, hoặc viết helper dùng
   chung tối thiểu trong `tests/e2e/flows/` nếu chưa có, không đụng
   `tests/api/` của các task khác.
2. Viết 5 file spec, mỗi file độc lập, mỗi file tự seed dữ liệu nó cần (không
   phụ thuộc thứ tự chạy — theo CONVENTIONS §8):
   - `tests/e2e/flows/booking-to-timeline.spec.ts`
   - `tests/e2e/flows/cancel-frees-slot.spec.ts`
   - `tests/e2e/flows/cancel-too-late-hotline.spec.ts`
   - `tests/e2e/flows/timeoff-reassign-block.spec.ts`
   - `tests/e2e/flows/race-two-tabs.spec.ts`
3. Với kịch bản đua (`race-two-tabs.spec.ts`), dùng hai `BrowserContext` độc
   lập của Playwright, đưa cả hai tới cùng bước xác nhận, gọi hành động xác
   nhận gần như song song (`Promise.all`), rồi khẳng định đúng một tab thành
   công và một tab nhận trạng thái làm mới đúng như mô tả.
4. Điều chỉnh `playwright.config.ts` chỉ nếu thật sự cần (ví dụ thêm project
   riêng, tăng timeout cho test đa tab) — ghi rõ lý do thay đổi trong "Đã làm
   gì" vì đây là file cấu hình chung ảnh hưởng mọi spec khác.
5. Chạy toàn bộ 5 spec, đảm bảo xanh ổn định — chạy lại ít nhất 2 lần để phát
   hiện test chập chờn (đặc biệt kịch bản đua), không chấp nhận "thỉnh thoảng
   xanh".

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §8.

Nhấn lại:
- Mỗi test tự seed dữ liệu nó cần, không phụ thuộc thứ tự chạy.
- Test khẳng định hành vi nghiệp vụ, tên test viết như câu tiếng Việt mô tả
  tình huống người dùng.
- Test đỏ mà không sửa được → đặt `status: blocked`, ghi rõ lý do, dừng lại.
  Không xoá test, không nới assertion cho xanh — đặc biệt quan trọng ở đây vì
  đây là gate cuối cùng, nới lỏng ở đây là nới lỏng cho toàn bộ hệ thống.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm run e2e -- tests/e2e/flows/booking-to-timeline.spec.ts` xanh
- [ ] `npm run e2e -- tests/e2e/flows/cancel-frees-slot.spec.ts` xanh
- [ ] `npm run e2e -- tests/e2e/flows/cancel-too-late-hotline.spec.ts` xanh
- [ ] `npm run e2e -- tests/e2e/flows/timeoff-reassign-block.spec.ts` xanh
- [ ] `npm run e2e -- tests/e2e/flows/race-two-tabs.spec.ts` xanh (chạy ổn định
      ít nhất 2 lần liên tiếp)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
Chính là 5 spec sau, mỗi spec một kịch bản, tên file như liệt kê ở "Việc phải
làm":
- `tests/e2e/flows/booking-to-timeline.spec.ts` — `khách đặt lịch xong thì lịch xuất hiện đúng cột KTV đúng giờ trên admin timeline`
- `tests/e2e/flows/cancel-frees-slot.spec.ts` — `khách huỷ lịch còn xa giờ hẹn thì slot mở lại và khách khác đặt được ngay slot đó`
- `tests/e2e/flows/cancel-too-late-hotline.spec.ts` — `khách huỷ lịch trong vòng 2 tiếng nhận 409 CANCEL_TOO_LATE và giao diện hiện hotline thay vì lỗi`
- `tests/e2e/flows/timeoff-reassign-block.spec.ts` — `admin tạo nghỉ đột xuất đè booking thì booking vào hàng chờ, chuyển sang KTV đủ skill thành công, chuyển sang KTV thiếu skill bị chặn`
- `tests/e2e/flows/race-two-tabs.spec.ts` — `hai tab cùng đặt một slot thì đúng một tab thành công, tab còn lại nhận thông báo hết chỗ và danh sách được làm mới`

## Định nghĩa "xong"
Chạy toàn bộ `npm run e2e -- tests/e2e/flows` hai lần liên tiếp trên app thật
(Worker + D1 thật), cả 5 spec xanh cả hai lần, không có spec nào chập chờn.

## Cạm bẫy đã biết
- **Kịch bản đua rất dễ viết thành tuần tự "giả song song"** (await lần lượt
  thay vì `Promise.all` thật) — nếu vậy test luôn xanh dù logic race-condition
  ở T-04 có lỗi. Đây là chốt chặn duy nhất cho race condition ở tầng UI, viết
  sai coi như không có gate này.
- Seed dữ liệu không sạch giữa các spec (dùng chung một KTV/dịch vụ cố định mà
  các spec khác cũng seed) sẽ gây xung đột ngẫu nhiên khi Playwright chạy
  song song nhiều worker — mỗi spec nên tạo dữ liệu riêng biệt đủ để không đụng
  spec khác (tên khách, số điện thoại, hoặc khung giờ riêng).
- Test kịch bản 3 (cutoff) phải seed một lịch hẹn *thật* gần giờ hiện tại, không
  giả lập đồng hồ trình duyệt — nếu không sẽ không chạm được nhánh 409 thật từ
  server.
- Đừng để bộ test này trở thành nơi vá lỗi tạm cho UI/API còn thiếu — nếu một
  kịch bản không chạy được vì thiếu tính năng ở task trước, đó là dấu hiệu task
  trước chưa xong, không phải việc của T-14 để bù đắp.

## Đã làm gì
- Thêm 5 spec flow độc lập trong `tests/e2e/flows/`: đặt lịch → timeline,
  huỷ xa giờ → mở slot, cutoff 2 giờ → hotline, time-off → hàng chờ/chuyển
  KTV, và đua hai BrowserContext cùng đặt một slot.
- Thêm helper fixture dùng API admin để INSERT skill/KTV/dịch vụ/gói/ca làm
  việc riêng cho từng test, không wipe DB. Case cutoff seed booking thật sát
  ranh giới 2 giờ theo cùng mẫu `customer-lookup.spec.ts`, vì API đặt lịch
  bắt buộc mốc 15 phút nên không thể tạo ranh giới vài giây qua UI/API.
- Flow time-off tự huỷ hợp lệ các item mồ côi cũ trong hàng chờ toàn cục trước
  khi kiểm chứng; flow race bấm xác nhận thật bằng `Promise.all` rồi kiểm tra
  dữ liệu cuối chỉ còn đúng một booking.
- `npm run typecheck` xanh. Đã cố chạy `npm run e2e -- tests/e2e/flows/` nhưng
  sandbox chặn Vite/Cloudflare mở inspector tại `0.0.0.0:9229` với
  `listen EPERM`; cần orchestrator chạy bộ E2E ngoài sandbox (và chạy lại lần
  hai theo checklist card).
</content>
