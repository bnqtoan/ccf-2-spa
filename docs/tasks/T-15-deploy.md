---
id: T-15
title: Deploy Cloudflare — D1 remote, migrations, smoke test production
status: todo
model: sonnet
effort: medium
depends_on: ["T-14"]
touches:
  - wrangler.jsonc
  - package.json
  - docs/DEPLOY.md
prd_refs: ["§2"]
owner: null
started_at: null
finished_at: null
---

# T-15 · Deploy Cloudflare

## Mục tiêu
Đưa app chạy thật trên Cloudflare, đủ để một khách thật đặt lịch và huỷ lịch
trên URL production — không phải "deploy xong" theo nghĩa `wrangler deploy`
không báo lỗi, mà theo nghĩa **có bằng chứng một lượt đặt-huỷ thật đã chạy**
trên môi trường thật.

## Ngữ cảnh cần biết
Stack đã chốt (PRD §2): Cloudflare Workers + D1 + Hono API + React SPA (Vite),
một Worker phục vụ cả API lẫn SPA (không tách domain riêng cho frontend).

Task này là bước cuối cùng sau khi T-14 đã xanh toàn bộ — nghĩa là **logic đã
được xác minh trên local/CI**. Việc còn lại thuần là hạ tầng: D1 local (dùng
để test) khác hoàn toàn với D1 remote (dùng cho production), migrations phải
chạy lại thủ công trên remote vì chúng không tự đồng bộ.

Không có auth trong v1 (PRD §2 bảng quyết định) — `/admin/*` là route thường,
không guard. Vì vậy sau khi deploy, **URL admin công khai cho bất kỳ ai có
link** — đây là quyết định đã chốt của PRD, không phải lỗi cần vá ở task này,
nhưng phải nêu rõ trong `docs/DEPLOY.md` để người vận hành spa biết giới hạn
này khi chia sẻ link.

## Phạm vi
**Trong:**
- Tạo D1 database remote (nếu chưa có) và cập nhật `wrangler.jsonc` với đúng
  `database_id` remote
- Chạy toàn bộ migrations lên D1 remote theo đúng thứ tự đã đánh số
  (CONVENTIONS §7: `migrations/`, đánh số tăng dần)
- `wrangler deploy` — build SPA + deploy Worker
- Smoke test thủ công trên URL production thật: đặt một lịch, xem nó trên
  admin, huỷ lịch đó
- Viết `docs/DEPLOY.md`: các bước deploy từ đầu, và hướng dẫn rollback
- Thêm script `deploy` vào `package.json` nếu T-01 chưa có sẵn hoặc cần chỉnh

**Ngoài:**
- Không thiết lập domain tuỳ chỉnh / DNS riêng nếu spa chưa có domain — dùng
  subdomain mặc định `*.workers.dev` trừ khi có domain thật được cung cấp
- Không dựng CI/CD tự động deploy (out of scope, chưa có yêu cầu trong PRD)
- Không thêm auth cho `/admin/*` — đó là quyết định PRD đã chốt cho v1, không
  tự vá ở đây
- Không seed dữ liệu mẫu (dịch vụ/KTV) lên production nếu spa thật đã có kế
  hoạch nhập liệu riêng — chỉ hỏi/xác nhận nếu cần dữ liệu tối thiểu để chạy
  smoke test, và ghi rõ trong "Đã làm gì" dữ liệu nào đã được tạo để test rồi
  cần xoá hay giữ lại

## Đầu vào đã có
- **T-14 để lại** toàn bộ 5 kịch bản E2E xanh trên local — bằng chứng logic
  nghiệp vụ đã đúng trước khi deploy. Task này không kiểm tra lại logic, chỉ
  kiểm tra hạ tầng deploy có đưa đúng logic đó lên production hay không.
- T-01 để lại `wrangler.jsonc` với binding D1 tên `DB` trỏ database local/test,
  và `package.json` với các script `dev`, `build`, `typecheck`, `test`, `e2e`.
- `migrations/` (từ T-02 trở đi) chứa các file SQL đánh số tăng dần, đã chạy
  đúng trên D1 local qua toàn bộ các task trước.

## Việc phải làm
1. Kiểm tra `wrangler.jsonc` hiện tại đang trỏ D1 nào (local dev) — xác định
   cần tạo D1 remote mới hay đã có sẵn.
2. Tạo D1 remote: `wrangler d1 create <tên-database>` (nếu chưa có), cập nhật
   `database_id` remote vào `wrangler.jsonc`.
3. Chạy migrations lên remote: `wrangler d1 migrations apply <tên-database>
   --remote`, xác nhận đúng thứ tự, không bỏ sót migration nào.
4. `npm run build` rồi `wrangler deploy`, ghi lại URL production được cấp.
5. Chạy smoke test thủ công trên URL production thật (không phải localhost):
   - Mở URL customer, đặt một lịch hẹn thật (chọn dịch vụ có sẵn, giờ còn
     trống, nhập tên/SĐT test rõ ràng là dữ liệu test, ví dụ tên "TEST DEPLOY")
   - Mở `/admin`, xác nhận lịch vừa đặt xuất hiện đúng trên timeline
   - Quay lại customer, tra cứu bằng đúng số điện thoại vừa dùng, huỷ lịch đó
   - Xác nhận lịch chuyển sang "Đã huỷ" và biến mất khỏi timeline admin (hoặc
     đổi màu tương ứng)
6. Viết `docs/DEPLOY.md` gồm: các bước deploy từ đầu (tạo D1, migrations,
   deploy), cách deploy lại khi có thay đổi mới, và hướng dẫn rollback (quay
   lại version Worker trước đó qua `wrangler rollback`, hoặc deploy lại từ
   commit trước — ghi rõ cách nào áp dụng được với setup này).
7. Xoá hoặc ghi chú rõ dữ liệu test đã tạo trên production trong bước 5, để
   người vận hành spa không nhầm là booking thật.

## Quy ước bắt buộc
Không có quy ước CONVENTIONS.md riêng cho hạ tầng deploy — bám theo PRD §2
(stack đã chốt) và không tự đổi sang nền tảng khác.

Nhấn lại:
- Không tự thêm auth, domain, hay CI/CD ngoài phạm vi đã liệt kê — cần thì báo
  trước, không tự quyết.
- `docs/DEPLOY.md` viết ngắn gọn, đủ để một người khác (hoặc tương lai chính
  agent) chạy lại được, không phải văn bản trình bày.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm run e2e -- tests/e2e/flows` vẫn xanh trên local trước khi deploy (không làm vỡ gì trong lúc chỉnh `wrangler.jsonc`/`package.json`)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
Không phải test tự động — đây là **smoke test thủ công có checklist rõ ràng
từng bước** trên môi trường production, ghi lại kết quả từng bước trong "Đã
làm gì":
1. `D1 remote đã tạo, migrations đã áp dụng đủ và đúng thứ tự (liệt kê số
   migration cuối cùng đã chạy)`
2. `wrangler deploy chạy xong không lỗi, có URL production`
3. `mở URL production, trang khách tải được, không lỗi console`
4. `đặt một lịch hẹn thật trên URL production thành công, thấy màn hoàn tất`
5. `mở /admin trên URL production, thấy đúng lịch vừa đặt trên timeline đúng cột đúng giờ`
6. `tra cứu bằng đúng số điện thoại vừa dùng, thấy đúng lịch vừa đặt`
7. `huỷ lịch đó thành công, lịch chuyển sang Đã huỷ`
8. `admin timeline không còn hiện lịch đó ở trạng thái đang hoạt động`

## Định nghĩa "xong"
Một lịch hẹn được tạo và huỷ thành công qua thao tác tay thật trên URL
production (không phải localhost, không phải preview), có ghi lại URL và kết
quả từng bước trong "Đã làm gì".

## Cạm bẫy đã biết
- **D1 local và D1 remote là hai database hoàn toàn khác nhau** — migrations
  chạy xanh trên local (qua toàn bộ T-02 đến T-14) không tự động có nghĩa là
  remote đã có schema đó. Phải chạy `--remote` riêng, và kiểm tra lại bằng
  cách query thử (ví dụ `wrangler d1 execute <db> --remote --command "select
  count(*) from services"`) trước khi tin tưởng smoke test sẽ qua.
- Quên cập nhật `database_id` remote đúng trong `wrangler.jsonc` sẽ khiến
  `wrangler deploy` build được nhưng Worker chạy production lại trỏ nhầm D1
  (hoặc D1 rỗng chưa có migration) — kiểm tra kỹ trước khi deploy, không chỉ
  sau khi thấy lỗi.
- Đừng seed dữ liệu test rồi quên dọn — dữ liệu "TEST DEPLOY" lẫn vào dữ liệu
  thật của spa sẽ gây nhầm lẫn cho lễ tân sau này. Ghi rõ đã dọn hay chưa dọn
  trong "Đã làm gì".
- `wrangler rollback` chỉ hoạt động nếu có version trước đó đã deploy qua
  Cloudflare (không phải quay lại code cũ rồi tự build lại) — kiểm tra thật kỹ
  cách rollback nào áp dụng được với cấu hình `wrangler.jsonc` hiện tại trước
  khi viết vào `docs/DEPLOY.md`, đừng ghi hướng dẫn chưa thử qua.

## Đã làm gì
(agent điền khi xong)
</content>
