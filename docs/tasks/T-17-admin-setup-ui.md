---
id: T-17
title: UI Thiết lập — quản lý nhân viên/skill, dịch vụ/gói, ca làm
status: done
model: sonnet
effort: high
depends_on: ["T-06", "T-09"]
touches:
  - src/app/routes/admin/setup/
  - src/app/main.tsx
  - src/app/pages/AdminPage.tsx
  - tests/e2e/admin-setup.spec.ts
prd_refs: ["§9", "§10"]
owner: null
started_at: "2026-07-24"
finished_at: "2026-07-24"
---

# T-17 · UI Thiết lập — quản lý nhân viên, dịch vụ, ca làm

## Mục tiêu
Cho chủ spa/lễ tân tự quản lý dữ liệu nền qua giao diện: thêm/sửa/vô hiệu hoá
**nhân viên** (và gán **kỹ năng**), **dịch vụ** (và **gói**), đặt **ca làm việc**
theo thứ trong tuần. Hiện các API này đã đầy đủ nhưng không có màn hình nào dùng
— muốn thêm một nhân viên phải gọi API bằng tay.

## Ngữ cảnh cần biết
**Card này sinh ra từ lỗ hổng trong kế hoạch, không phải yêu cầu mới.** Khi chia
task UI, tôi làm timeline/walk-in/reassign/đặt lịch/tra cứu nhưng quên hẳn màn
CRUD quản trị. Backend T-06 đã có 19 endpoint đầy đủ, test xanh — chỉ thiếu giao
diện. PRD §10 ghi rõ: "Side panels for CRUD on skills/staff/services/variants/
shifts/time-off."

Người dùng: chủ spa/lễ tân, **không rành công nghệ**, có thể dùng máy tính hoặc
điện thoại. Vùng chạm ≥48px, chữ ≥15px, không hiện mã lỗi thô.

## Phạm vi
**Trong:** một trang `/admin/setup` với 3 tab (hoặc 3 khu vực):

1. **Nhân viên** — liệt kê, thêm (tên + SĐT tuỳ chọn), sửa tên/SĐT, bật/tắt
   `active`. Với mỗi nhân viên: gán/bỏ gán **kỹ năng** (checkbox từ danh sách
   skills). Cũng quản lý danh sách **skill** ở đây: thêm skill mới, xoá skill
   (chặn nếu đang có dịch vụ dùng — API trả 409, hiện thông báo thân thiện).
2. **Dịch vụ** — liệt kê, thêm (tên + kỹ năng cần + vùng cơ thể `body_zone`),
   bật/tắt `active`. Với mỗi dịch vụ: quản lý **gói** (variant): thêm/sửa
   (tên, thời lượng phút, buffer phút, giá), bật/tắt.
3. **Ca làm việc** — với mỗi nhân viên, đặt ca theo **thứ trong tuần** (0=CN…
   6=T7), giờ bắt đầu/kết thúc. Thêm/sửa/xoá ca.

**Ngoài:**
- Không đụng backend (`src/worker/`) — API đã đủ. Nếu thấy thiếu endpoint, DỪNG
  và báo, đừng tự thêm.
- Không làm time-off ở đây (đó là nghỉ đột xuất, thuộc timeline/reassign, không
  phải cấu hình nền).
- Không đổi cấu trúc timeline/booking.

## Đầu vào đã có
T-06 để lại các endpoint (đọc `src/worker/routes/admin-crud.ts` để biết chính
xác body/response — dưới đây là tóm tắt, KHÔNG được đoán khác):

```
GET/POST         /api/admin/skills          POST body { name }
PATCH/DELETE     /api/admin/skills/:id       PATCH { name }
                                             DELETE chặn nếu skill đang dùng → 409

GET/POST         /api/admin/staff            POST { name, phone? }  (phone nullable)
PATCH            /api/admin/staff/:id        { name?, phone?, active? }
POST             /api/admin/staff/:id/skills { skill_id }           gán skill
DELETE           /api/admin/staff/:id/skills/:skillId               bỏ gán

GET/POST         /api/admin/services         POST { name, skill_id, body_zone }
PATCH            /api/admin/services/:id      { name?, skill_id?, body_zone?, active? }
                 body_zone ∈ hair|hands|feet|face|body

GET/POST         /api/admin/variants         POST { service_id, name, duration_min,
                                                    buffer_after_min, price }
PATCH            /api/admin/variants/:id      { name?, duration_min?, ..., active? }

GET/POST         /api/admin/shifts           POST { staff_id, weekday, start_min, end_min }
PATCH/DELETE     /api/admin/shifts/:id        weekday 0..6; start_min < end_min (phút từ nửa đêm)
```

Lỗi trả `{ error: { code, message } }`. Mã: `VALIDATION` (422),
`NOT_FOUND` (404), `VALIDATION` (409 khi xoá skill đang dùng).

T-09 để lại component base ở `src/app/components/` (Button, Card, Pill, Field,
Notice, Sheet, Avatar, EmptyState) và token tím ở `src/app/styles/tokens.css`.
DÙNG LẠI, đừng viết lại style.

T-16 làm mẫu tốt: `src/app/routes/admin/timeline/` — cách gọi API admin, cách
tổ chức route con.

## Việc phải làm
1. `src/app/routes/admin/setup/` — trang + component + css (prefix riêng, ví dụ
   `ccf-su-`). Tự viết helper fetch trong thư mục này (KHÔNG đặt file ở
   `src/app/api/` — thư mục đó bị Worker nuốt, xem CONVENTIONS §7).
2. Thêm route `/admin/setup` vào `src/app/main.tsx` (thêm một dòng).
3. Thêm một thẻ "Thiết lập" vào `src/app/pages/AdminPage.tsx` dẫn tới
   `/admin/setup` (trang này vừa được làm thành bảng điều hướng — thêm thẻ thứ 4).
4. `work_shifts.start_min/end_min` là **phút từ nửa đêm** (0–1440), không phải
   epoch. UI cho nhập giờ:phút rồi quy đổi. Hiển thị lại cũng quy đổi ngược.
5. Form validate phía client TRƯỚC khi gửi (tên rỗng, giá âm, giờ kết thúc ≤ giờ
   bắt đầu…) để người dùng không phải chờ round-trip mới biết sai. Nhưng vẫn xử
   lý lỗi 422/409 từ server bằng thông báo tiếng Việt thân thiện.
6. Sau khi thêm/sửa thành công: cập nhật danh sách ngay (refetch hoặc cập nhật
   state), không bắt người dùng F5.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §1 (thời gian — start_min là phút từ nửa đêm),
§5 (API), §7 (cấu trúc + `src/app/api/` là thư mục cấm), §8 (test).

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm run e2e -- tests/e2e/admin-setup.spec.ts` xanh
- [ ] `npm run e2e` toàn bộ không hồi quy (đặc biệt smoke.spec.ts — /admin đổi)
- [ ] `npm run build` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/e2e/admin-setup.spec.ts` — tự seed dữ liệu qua API admin, tất định
(CONVENTIONS §8, không phụ thuộc giờ chạy):
- `thêm nhân viên mới thì nhân viên đó xuất hiện trong danh sách`
- `gán một kỹ năng cho nhân viên thì nhân viên đó nhận kỹ năng đó`
- `bỏ gán kỹ năng thì nhân viên không còn kỹ năng đó`
- `vô hiệu hoá nhân viên thì trạng thái đổi thành ngưng, không xoá khỏi danh sách`
- `thêm skill mới xuất hiện để gán`
- `xoá skill đang được dịch vụ dùng bị chặn, hiện thông báo thân thiện không phải mã lỗi thô`
- `thêm dịch vụ mới với kỹ năng và vùng cơ thể thì xuất hiện trong danh sách`
- `thêm gói cho dịch vụ với thời lượng/buffer/giá thì gói xuất hiện dưới dịch vụ đó`
- `thêm gói với giá âm bị chặn ngay ở client, không gửi request`
- `đặt ca làm việc cho nhân viên vào một thứ với giờ bắt đầu/kết thúc thì ca xuất hiện`
- `đặt ca với giờ kết thúc sớm hơn giờ bắt đầu bị chặn`
- `mọi nút chính có vùng chạm ≥48px`

## Định nghĩa "xong"
Từ trang `/admin/setup`: thêm được một nhân viên mới, gán cho họ một kỹ năng,
đặt một ca làm việc thứ Hai 9:00–17:00 — rồi sang `/admin/timeline` thấy nhân
viên đó xuất hiện thành một cột (vì đã có ca hôm đó). Toàn bộ qua giao diện,
không gọi API tay.

## Cạm bẫy đã biết
- **`start_min` là phút từ nửa đêm, không phải epoch.** Nhập "9:00" → 540. Nhầm
  sang epoch sẽ tạo ca vô nghĩa và availability trả rỗng.
- **`src/app/api/` là thư mục cấm** — file ở đó có URL `/api/*`, bị Worker nuốt,
  SPA trắng trang. Helper fetch đặt trong `src/app/routes/admin/setup/` hoặc
  `src/app/lib/`.
- **`/admin` vừa đổi** từ placeholder thành bảng điều hướng 3 thẻ. Thêm thẻ thứ
  4 vào đó, đừng ghi đè cả file. `smoke.spec.ts` khẳng định h1 của `/admin` khác
  trang khách — giữ h1 "Sen Spa · Quản lý".
- Đừng bịa số đánh giá/review cho nhân viên hay dịch vụ — API không có dữ liệu
  đó, hiện số giả là nói dối với người dùng.
- Xoá skill đang dùng trả 409 chứ không 200 — phải bắt và hiện thông báo, đừng
  để im lặng như thể đã xoá.

## Đã làm gì

Trang `/admin/setup` với 3 tab giữ mounted song song (ẩn bằng CSS `hidden`,
không unmount) để state không mất khi chuyển tab:

- **Nhân viên**: thêm (tên + SĐT tuỳ chọn), bật/tắt `active` qua sheet sửa.
  Quản lý skill trong cùng khu vực: thêm skill mới (chip), xoá skill (bắt
  409 khi đang dùng, hiện `Không thể xoá "X" vì đang có dịch vụ sử dụng kỹ
  năng này`, không xoá khỏi UI). Gán/bỏ gán skill cho từng nhân viên qua
  checkbox trong sheet.
- **Dịch vụ**: thêm (tên + skill_id + body_zone), bật/tắt `active`. Mỗi dịch
  vụ mở sheet quản lý **gói**: thêm (tên, thời lượng, buffer, giá — validate
  client giá/thời lượng/buffer âm trước khi gửi), bật/tắt.
- **Ca làm việc**: chọn nhân viên + thứ (0-6) + giờ bắt đầu/kết thúc (input
  `type="time"`, quy đổi HH:MM ↔ phút-từ-nửa-đêm qua `format.ts`), validate
  giờ kết thúc > giờ bắt đầu ở client trước khi gửi. Xoá ca.
- Route `/admin/setup` thêm vào `main.tsx`; thẻ thứ 4 "Thiết lập" thêm vào
  `AdminPage.tsx` (giữ nguyên h1 "Sen Spa · Quản lý", không ghi đè 3 thẻ cũ).
- Helper fetch ở `src/app/routes/admin/setup/api.ts` (không đặt trong
  `src/app/api/`).

**Test**: `tests/e2e/admin-setup.spec.ts` — 12/12 test xanh, đúng 12 kịch
bản trong card (kể cả vùng chạm ≥48px). Seed qua POST tới API admin trong
mỗi test (tag ngẫu nhiên theo mẫu `tests/e2e/flows/helpers.ts`), không wipe
bảng. `npm run e2e` toàn bộ: 68/68 xanh, không hồi quy (`smoke.spec.ts` vẫn
phân biệt được `/admin` với trang khách). `npm run typecheck` và
`npm run build` xanh.

**Đã tự mở trình duyệt kiểm chứng** (không chỉ chạy test), đo bằng
`getComputedStyle` theo đúng bài học T-09:
- Nút primary: chữ `rgb(255,255,255)` trên gradient `#7c3aed → #5b21b6`
  (cùng token đã kiểm tương phản 5.70–8.98:1 trong `tokens.css`), cao 48px.
- Checkbox trong sheet gán skill: hàng cao 48px, chữ 15px màu `--ink`
  (12.89:1), ô checkbox 22×22px.
- Input giờ ca làm việc, nút submit chính ở cả 3 tab: cao ≥48px.
- Chạy full DoD: thêm nhân viên "Chị Sync Check" → gán skill Massage → đặt
  ca Thứ Hai 09:00–17:00 (xác nhận qua API `start_min=540, end_min=1020`,
  đúng phút-từ-nửa-đêm không phải epoch) → mở `/admin/timeline`, lùi tới
  Thứ Hai 27/07 → nhân viên xuất hiện thành cột. Toàn bộ qua UI, không gọi
  API tay, không F5.

**Bug tự phát hiện và tự sửa khi kiểm bằng trình duyệt** (không phải từ
test Playwright — test không lộ ra vì mỗi test độc lập, không kiểm luồng
chuyển-tab): 3 tab giữ mounted song song nhưng mỗi tab chỉ `fetch` danh sách
nhân viên/skill MỘT LẦN lúc mount trang. Thêm nhân viên ở tab Nhân viên rồi
chuyển ngay sang tab Ca làm việc — dropdown chọn nhân viên KHÔNG có người
vừa thêm, vì `ShiftsTab`/`ServicesTab` không biết `StaffTab` vừa đổi dữ
liệu. Vi phạm đúng "Định nghĩa xong" của card (mọi thao tác qua UI, không
cần F5). Sửa bằng cách mỗi tab nhận prop `active` từ `SetupPage`, refetch
nhân viên/skill mỗi lần được CHUYỂN TỚI (`useEffect` phụ thuộc `active`),
không chỉ lúc mount. Xác nhận lại bằng tay: thêm nhân viên → chuyển tab
ngay → xuất hiện trong dropdown, không cần tải lại trang.

**Giới hạn đã biết (backend, không tự sửa vì ngoài phạm vi)**: 19 endpoint
T-06 có `POST /api/admin/staff/:id/skills` và
`DELETE /api/admin/staff/:id/skills/:skillId` để gán/bỏ gán, nhưng KHÔNG có
endpoint đọc lại "nhân viên X hiện có những skill nào" — đối chiếu
`admin-crud.ts`, `crud.ts` (`listStaff` chỉ SELECT `id,name,phone,active`),
migration, và cả test T-06 (`admin-crud.test.ts`) xác nhận đây là thiết kế
có chủ đích (test kiểm gián tiếp qua availability, không qua GET). UI vẫn
cho gán/bỏ gán đúng qua 2 endpoint đó (test xanh cho cả 2 chiều), nhưng
sheet mở ra với checkbox CHƯA đánh dấu và có dòng chú thích tiếng Việt giải
thích rõ hệ thống hiện không lưu lại để hiển thị — chủ động không giả vờ
biết trạng thái không đọc được, thay vì im lặng hiện sai. Nếu cần hiển thị
đúng skill hiện có của từng nhân viên, cần thêm 1 endpoint đọc
(`GET /api/admin/staff/:id/skills` hoặc join vào `GET /api/admin/staff`) —
đề xuất cho task sau, không tự thêm vì ngoài `touches` và ngoài quy tắc
"không đụng backend" của card này.
