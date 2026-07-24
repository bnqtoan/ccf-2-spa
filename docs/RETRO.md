# Retro — xây Sen Spa Booking từ 0 đến live trong một session

Tài liệu này ghi lại toàn bộ một session: từ câu "brainstorm app booking spa"
tới một app chạy thật trên Cloudflare với auto-deploy, 247 test API + 68 test
E2E xanh. Viết để đọc lại và rút kinh nghiệm — thẳng thắn cả chỗ làm tốt lẫn
chỗ tự vấp.

---

## 1. Ý tưởng ban đầu

Yêu cầu gốc: app quản lý booking spa. Kỹ thuật viên (KTV) có kỹ năng riêng và
slot giờ riêng; khách đặt dịch vụ theo kỹ năng; hệ thống tự sắp KTV phù hợp và
đang rảnh; huỷ thì trả slot lại. Chưa cần đăng nhập. Chạy trên Cloudflare Worker.

Cách khởi động: **không viết code ngay**, mà hỏi để chốt các quyết định định hình
kiến trúc — cách gán KTV, mô hình thời gian, stack, phạm vi MVP. Từ các câu trả
lời, vài điểm quan trọng lộ ra sớm:

- Dịch vụ có **variant** (Massage 45' vs 90') — không phải service phẳng.
- Slot theo dịch vụ, admin cấu hình — không phải lưới cố định toàn cục.
- "1 khách 2 dịch vụ cùng lúc" (tóc + móng) → buộc phải tách
  `appointments` / `booking_items` ngay từ đầu, dù MVP chưa dùng combo.

**Bài học 1: hỏi trước khi code giúp bắt được ràng buộc kiến trúc trước khi nó
đắt.** Nếu dựng schema `bookings` phẳng rồi mới gặp ca combo, đã phải migration
đau. Câu hỏi "1 khách 2 dịch vụ thì sao?" đến từ người dùng, và nó thay đổi
schema.

---

## 2. Diễn tiến

Trình tự có chủ đích, mỗi bước là đầu vào của bước sau:

```
Brainstorm (hỏi/đáp)
  → PRD (docs/PRD.md) — chốt domain model, thuật toán, chính sách
    → Prototype HTML 1 file (prototype/index.html) — 4 luồng bấm được
      → Chia 15 task card + BOARD + CONVENTIONS
        → Dispatch subagent song song (Sonnet/Opus/Codex)
          → Deploy Cloudflare + auto-deploy
            → 2 lỗ hổng người dùng phát hiện → vá (T-16, T-17)
```

### 2.1 PRD trước, để chốt chỗ dễ sai

PRD không phải thủ tục — nó là nơi ghi những quyết định mà sai thì đắt:

- **Quy tắc lõi**: KTV bị chiếm `[start_at, block_end_at)`, trong đó
  `block_end_at` đã cộng buffer. `end_at` chỉ để hiển thị. Tách hai cột chính
  là thứ ngăn buffer bị quên trong query.
- **Hàng chờ reassign suy ra từ dữ liệu sống**, không lưu cột cờ.
- **no_show là dữ liệu tín nhiệm, không phải cơ chế thu hồi slot.**

Một chuyên gia ngoài góp ý về cancellation/walk-in/multi-branch. Phần lớn nhận,
nhưng **phản biện 3 điểm** thay vì nhận hết: `staff.branch_id` là sai hướng (ràng
buộc thật nằm ở `work_shifts.branch_id`), không thêm cột "để dành" nào, và
`no_show` không thu hồi slot. Đây là chỗ làm đúng — góp ý tốt vẫn cần lọc, không
nuốt trọn.

### 2.2 Prototype để thấy luồng — và để lộ nghiệp vụ

Prototype HTML bấm được (không phải bản vẽ tĩnh) làm lộ ra những tình huống mà
PRD trên giấy không thấy:

- **Ca không ai nhận được**: khi làm sheet "chuyển KTV", tự bấm thử thì thấy
  hệ thống gợi ý người không đủ skill. Sửa logic, và phát hiện tình huống thật:
  chỉ 1 KTV biết làm Móng, người đó bận → *không ai nhận được* → cần thông báo
  riêng kèm số điện thoại khách, không để 4 nút xám im lặng.
- **Walk-in lệch lưới 15 phút**: khách vãng lai đến lúc 14:07, không tròn 15
  phút → quy tắc "start_at đúng lưới" sẽ chặn thẳng. Phải miễn trừ.

**Bài học 2: prototype bấm được rẻ hơn nhiều so với phát hiện các ca này lúc đã
viết backend.** Cả hai đều vào PRD/card trước khi có dòng code thật nào.

### 2.3 Chia task để nhiều agent chạy song song

17 card (15 ban đầu + T-16, T-17 sinh sau do lỗ hổng). Mỗi card tự chứa đủ ngữ
cảnh, có `touches` (file sẽ đụng), checklist test bắt buộc, và mục "Cạm bẫy đã
biết". Phân model: **Opus cho 3 chỗ sai-thì-đắt-và-im-lặng** (availability
engine, booking transaction, reassign), Sonnet cho CRUD/UI, Codex cho task lặp
lại có test rõ.

Chạy theo đợt, tối đa 3–4 agent song song, giữa mỗi đợt tự review + chạy lại
test + kiểm `touches` không bị vượt.

---

## 3. Những vấn đề đã gặp và cách giải quyết

Đây là phần giá trị nhất của retro. Chia theo loại.

### 3.1 Lỗi CHIA TASK — lặp lại 4 lần cùng một dạng

**Vấn đề gốc: chia phạm vi theo "việc cần làm" mà không đối chiếu ngược danh
sách đặc tả.** Hậu quả: những thứ rơi vào *khe giữa* các card thì không ai nhận.

| Lần | Cái bị bỏ sót | Ai phát hiện |
|---|---|---|
| 1 | `GET /api/services` (khe T-04/T-06) | agent T-10 khi dựng UI |
| 2 | `GET /api/admin/schedule` (khe T-06/T-07) | agent T-12 |
| 3 | `POST /api/admin/appointments/:id/items` | kiểm toán của tôi |
| 4 | **Toàn bộ UI CRUD quản trị** (backend đủ, không màn nào dùng) | **người dùng** |

Lần 1–3 gộp thành T-16. Lần 4 là T-17 — và **người dùng bắt được, không phải
tôi**. Đó là điểm trừ lớn nhất session: backend CRUD admin có 19 endpoint test
xanh từ T-06, nhưng khi chia task UI tôi làm timeline/walk-in/reassign/đặt
lịch/tra cứu mà *quên hẳn màn quản trị*.

**Cách phòng đã tìm ra (và giá như dùng từ đầu):** quét mọi endpoint trong đặc
tả rồi `grep` ngược vào code — "endpoint này, màn nào dùng?". Chạy trong vài
giây. Chính vòng lặp này tìm ra endpoint thứ 3 mà chưa agent nào thấy. Lẽ ra
phải chạy nó ngay sau khi chia card, không phải sau khi phát hiện lỗ hổng đầu
tiên.

**Điểm cộng trong cái sai này:** mọi agent gặp lỗ hổng đều **dừng lại đặt
`blocked` và báo, không tự vá ngoài `touches`**. Kỷ luật phạm vi giữ được ngay
cả khi agent bị chặn hoàn toàn.

### 3.2 Xung đột file khi chạy song song — bắt được ở khâu REVIEW CARD

Khi review 15 card (trước khi code), phát hiện **7 card cùng khai báo
`src/worker/index.ts` trong `touches`**, ba trong đó (T-05/T-07/T-08) chạy song
song. Ba agent cùng sửa một file để mount route = vỡ merge chắc chắn.

**Giải:** tách `registerRoutes()` sang `src/worker/routes/index.ts`, mỗi task chỉ
**thêm một dòng** vào cuối một hàm. Nhiều agent cùng append một dòng thì git
merge được. Khi đợt 5 chạy thật: 8 route từ 6 task, ba agent song song, **không
xung đột**.

**Bài học 3: `touches` không chỉ là tài liệu — nó là công cụ phát hiện xung đột
ở khâu thiết kế.** Phát hiện lỗi này lúc review card rẻ hơn nhiều lần so với lúc
ba agent đã viết code xong.

### 3.3 Test "xanh giả" — mutation test là cách duy nhất tin được

Nhiều agent báo "test xanh, đã mutation-test". Tôi tự chạy lại và tìm ra **lỗ
hổng thật mà báo cáo không thấy**:

- **T-04 pickStaff**: bỏ tiebreak "hoà thì chọn staff_id nhỏ hơn" mà 123 test
  vẫn xanh — vì thứ tự chèn của `Map` *tình cờ* trùng thứ tự id. Nếu SQL đổi thứ
  tự trả về, auto-assign mất tính tất định mà không test nào báo. Bổ sung
  `tests/unit/pick-staff.test.ts` truyền đầu vào đảo ngược; xác nhận nó đỏ khi
  bỏ tiebreak.
- **T-08 walk-in**: test "lệch lưới 15 phút" dùng `Date.now()` thật, nên chỉ
  phân biệt đúng/sai khi đồng hồ *tình cờ* rơi vào phút lệch lưới — chốt chặn
  quan trọng nhất phụ thuộc may rủi. Thêm unit test tất định khoá cả hai chiều.

**Bài học 4: test chỉ chứng minh được giá trị khi ta bắt nó thất bại một lần.**
Một bộ test toàn xanh không nói lên nó bảo vệ được gì.

**Phòng lỗi bằng kiểu, không bằng lời:** T-03 định nghĩa `BusyItem` **cố tình
không có field `end_at`** — biến lỗi im lặng nguy hiểm nhất (dùng nhầm `end_at`
thay `block_end_at`) thành *lỗi không thể biểu đạt*. Đây là cách phòng tốt hơn
hẳn viết cảnh báo.

### 3.4 Lỗi CHỈ LỘ Ở PRODUCTION — bắt được trước khi nối CI/CD

Khi chuẩn bị deploy, cài lại `node_modules` (đã bị xoá) và chạy `npm run build`:

- **Build đỏ**: comment CSS trong `timeline.css` chứa chuỗi `.tl*/` — dấu `*/`
  đóng comment sớm. Dev server bỏ qua, nhưng minifier production báo lỗi. **Nếu
  đẩy Git rồi nối Cloudflare ngay, mỗi push sẽ build fail** và phải đi tìm
  nguyên nhân trong log CI.

**Bài học 5: `npm run build` (production) phải xanh trước khi nối auto-deploy.**
Dev server dung thứ nhiều thứ mà production build từ chối.

### 3.5 Test HẾT HẠN THEO ĐỒNG HỒ — bom hẹn giờ

18 test đỏ sau khi cài lại deps. Nguyên nhân: `const DATE = '2026-07-22'` cứng
+ `dayStart + 3600` (01:00 sáng). Viết lúc 00:xx thì xanh; đến 01:42 cùng ngày
thì `start_at` trôi vào quá khứ → 422. **Lỗi trông y hệt lỗi logic, không hề gợi
ra là test hết hạn.**

Sửa sang ngày động (`futureDateStr(n)`) — nhưng lần đầu sửa **chưa trọn**: đổi
`FUTURE_DATE` mà quên `FUTURE_WEEKDAY` (ca không khớp ngày → availability rỗng)
và `at()` (mốc giờ lệch vài ngày). Phải sửa **trọn bộ ba thứ** ở 4 file.

**Bài học 6: ngày cứng trong test là nợ ẩn.** Đã ghi vào CONVENTIONS: đổi sang
ngày động phải đổi cả `DATE` + `weekday suy ra từ DATE` + `mốc giờ neo vào
dayStart` — cả ba, không sót cái nào.

### 3.6 Ô nhiễm dữ liệu E2E — xanh khi chạy riêng, đỏ khi chạy chung

E2E toàn bộ đỏ 4 test dù từng file riêng đều xanh. Hai nguyên nhân chồng nhau:

1. **Fixture tích luỹ**: mỗi spec tạo KTV/service riêng, không dọn → một lần
   chạy đẩy KTV active từ 5 lên 38; sau vài chục lần lên 132. Timeline và hàng
   chờ (tài nguyên toàn cục) vỡ theo.
2. **Hàng chờ reassign toàn cục**: 3 spec cùng thao tác nó, chạy song song thì
   file này dọn xong file kia tạo orphan mới.

**Giải:** `global-setup.ts` dọn D1 về seed sạch trước mỗi lần chạy; gom 3 spec
đụng hàng chờ vào một project `chromium-shared-queue` chạy tuần tự.

**Bài học 7: "chạy từng file thì xanh, chạy cả bộ thì đỏ" = ô nhiễm trạng thái
dùng chung.** Gần như luôn là test không dọn sau nó, hoặc tài nguyên toàn cục bị
tranh chấp.

### 3.7 Sandbox của Codex chặn test — và cách xử lý đúng

Codex (làm T-06, T-14) bị sandbox chặn mở socket workerd (`listen EPERM`), không
tự chạy được test. Nó **tự đặt `blocked` và báo, không đoán bừa "chắc là xanh"**.
Tôi chạy hộ ngoài sandbox: 17/17 xanh, rồi mới gỡ `blocked`. Đúng quy trình —
agent không được tự tuyên bố xanh khi không chạy được.

### 3.8 Va chạm namespace `/api/*` — triệu chứng không gợi ra nguyên nhân

Agent T-10 đặt `src/app/api/client.ts`. Vite root là `src/app` nên file đó có
URL `/api/client.ts`, khớp `run_worker_first: ["/api/*"]` trong wrangler.jsonc và
bị Worker nuốt → 404 → **toàn bộ SPA trắng trang** (vì `main.tsx` import xuyên
qua) → 10/10 test timeout ở thao tác đầu. Triệu chứng (mọi test timeout) hoàn
toàn không gợi ra nguyên nhân (va chạm URL). Agent phải đọc network log mới thấy.

**Giải:** đổi `src/app/api/` → `src/app/lib/`, không nới `run_worker_first` —
namespace `/api/*` thuộc Worker, SPA không nên tranh. Ghi vào CONVENTIONS:
`src/app/api/` là thư mục cấm.

### 3.9 Giới hạn 100 bound-param của D1 — chỉ lộ khi dữ liệu lớn

`admin-schedule` bind từng `staff_id` qua `IN (?, ?, …)`. **D1 giới hạn 100
bound params/statement (không phải 999 như SQLite thường)** → spa ~98+ KTV nhận
HTTP 500. Tái hiện thật với 120 KTV. Sửa: `JOIN staff active` thay vì bind id —
số param cố định. Bug này *không thể lộ* với seed 5 KTV; chỉ xuất hiện vì rác
test tích luỹ vượt ngưỡng — một tai nạn may mắn.

---

## 4. Điều tôi tự vấp — về cách KIỂM CHỨNG

Nhất quán suốt session: **phép đo / trí nhớ của tôi tự sai vài lần**, và mỗi lần
suýt dẫn tới kết luận "có lỗi" sai:

- Mutation test dùng `perl` chỉ thay lần khớp đầu → trúng **dòng comment**, code
  thật không đổi → tưởng test có lỗ hổng. Thực ra đột biến chưa bao giờ áp dụng.
- `WHERE NOT EXISTS (SELECT 1 WHERE 0)` → tưởng vô hiệu hoá guard, thực ra luôn
  `true` nên guard vẫn nguyên.
- Đo tương phản chip/nút "+" → nhắm **nhầm phần tử** (chip chưa chọn, span trang
  trí) → báo động giả 2 lỗi không tồn tại.
- Nhớ nhầm seed của Lan là "Massage + Da mặt" → thấy UI hiện "Massage + Tóc" →
  suýt kêu sai. Truy DB: Lan đúng là Massage + Tóc. UI đúng.

**Bài học 8 (quan trọng nhất về kỷ luật bản thân): luôn xác nhận công cụ đo đang
đo đúng thứ, trước khi tin kết quả của nó.** Với mutation test: `grep` xác nhận
đột biến ăn vào đúng dòng code. Với đo UI: xác nhận đang đo đúng phần tử. Với dữ
liệu: query nguồn sự thật (DB/code), đừng tin trí nhớ về seed. Mỗi lần tôi bỏ
qua bước này, tôi tạo ra một báo động giả.

---

## 5. Cái gì làm nên khác biệt

Nếu phải rút gọn thành vài nguyên tắc dùng lại được:

1. **Hỏi trước khi code** — bắt ràng buộc kiến trúc khi còn rẻ.
2. **Prototype bấm được trước backend** — lộ nghiệp vụ mà giấy tờ không thấy.
3. **Card tự chứa + `touches` + "cạm bẫy đã biết"** — biến kinh nghiệm đã trả
   giá thành đầu vào cho agent, và phát hiện xung đột ở khâu thiết kế.
4. **Không tin báo cáo — tự mutation-test, tự chạy lại, tự mở trình duyệt đo.**
   Test toàn xanh không chứng minh gì; phải bắt nó đỏ một lần.
5. **Phòng lỗi bằng kiểu** (BusyItem không có end_at) hơn phòng bằng lời dặn.
6. **Đối chiếu ngược đặc tả** — với mỗi endpoint/yêu cầu, hỏi "cái gì dùng nó?".
   Đây là bài học phải trả giá 4 lần mới ghi vào quy trình.
7. **Kiểm chứng công cụ đo trước khi tin nó** — grep đột biến, xác nhận phần tử,
   query nguồn sự thật.

---

## 6. Số liệu cuối

- 24 commit, từ PRD tới production live
- 17 task card (2 sinh sau do lỗ hổng phát hiện muộn)
- 247 test API (workerd + D1 thật, không mock) + 68 test E2E
- App live: https://ccf-2-spa.bnqtoan.workers.dev, auto-deploy 15–45s mỗi push
- 2 lỗ hổng backend tự vá (3 endpoint thiếu + endpoint đọc staff-skill)
- Nhiều bug tự phát hiện qua mutation test và kiểm trình duyệt mà không test
  nào ban đầu bắt được

Nguồn sự thật của dự án: `docs/PRD.md` (nghiệp vụ), `docs/tasks/CONVENTIONS.md`
(quy ước — nơi mọi bài học "cạm bẫy đã biết" được ghi lại để không vấp lần hai).
