# Sen Spa — Booking

Ứng dụng đặt lịch cho spa, chạy trên Cloudflare Workers. Khách đặt dịch vụ, hệ
thống tự sắp kỹ thuật viên có kỹ năng phù hợp và đang rảnh; lễ tân quản lý lịch
ngày, nhận khách vãng lai, và xử lý khi kỹ thuật viên nghỉ đột xuất.

Không có đăng nhập ở bản v1 — cả trang khách lẫn trang quản lý đều mở.

## Stack

- **Cloudflare Workers** + **D1** (SQLite) — API và lưu trữ
- **Hono** — router API
- **React + Vite** — SPA (trang khách và trang quản lý dùng chung)
- **Vitest** (chạy trong workerd, D1 thật) + **Playwright** — test

## Tính năng

**Khách**
- Đặt lịch: chọn dịch vụ → gói → ngày/giờ → kỹ thuật viên (hoặc để spa sắp)
- Tra cứu & huỷ bằng số điện thoại; huỷ trong vòng 2 tiếng chuyển sang gọi hotline

**Lễ tân**
- Lịch ngày theo cột kỹ thuật viên, hiện cả thời gian dọn dẹp giữa hai lịch
- Nhận khách vãng lai (bắt đầu ngay, không cần đặt trước)
- Kỹ thuật viên nghỉ đột xuất → các lịch bị ảnh hưởng vào hàng chờ để chuyển người

## Chạy local

```bash
npm ci
npm run db:migrate:local   # tạo bảng
npm run db:seed:local      # dữ liệu mẫu: 4 dịch vụ, 5 KTV
npm run dev                # http://localhost:5173
```

Trang khách ở `/`, quản lý ở `/admin/timeline`, tra cứu ở `/lookup`.

## Test

```bash
npm run typecheck
npm test          # 246 test API — D1 thật trong workerd, không mock
npm run e2e       # 56 test Playwright — 5 luồng nghiệp vụ đầu-cuối
```

## Thanh toán online (PAYMENT)

Thanh toán full tại lúc đặt lịch, sau adapter pattern — SePay (VietQR, nhận tiền
qua webhook) và PayPal (redirect + capture). "Trả tại spa" vẫn là mặc định;
thanh toán online là một MODE, không thay thế.

**Secrets phải set qua `wrangler secret put <NAME>` (KHÔNG commit):**

- `SEPAY_API_KEY` — key xác thực webhook SePay (`Authorization: Apikey <key>`)
- `SEPAY_ACCOUNT_NUMBER` — số tài khoản nhận tiền, encode vào VietQR
- `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` — REST API credentials
- `PAYPAL_WEBHOOK_ID` — id webhook PayPal, dùng để verify chữ ký

**Vars không bí mật (đã có trong `wrangler.jsonc`):** `PAYPAL_BASE_URL` (mặc định
sandbox), `PAYPAL_VND_PER_USD` (tỉ giá quy đổi khi tạo order PayPal).

Local dev: đặt các giá trị trên vào `.dev.vars` (đã gitignore).

## Live

Production: https://ccf-2-spa.bnqtoan.workers.dev

## Deploy

Xem [docs/DEPLOY.md](docs/DEPLOY.md) — nối repo với Cloudflare Workers Builds để
tự deploy mỗi lần push.

## Tài liệu

- [docs/PRD.md](docs/PRD.md) — đặc tả nghiệp vụ, mô hình dữ liệu, thuật toán
- [docs/tasks/](docs/tasks/) — cách dự án được chia nhỏ và thực thi

## Ảnh

Ảnh dịch vụ và chân dung lấy từ [Unsplash](https://unsplash.com) (giấy phép miễn
phí thương mại). Chi tiết trong [public/images/CREDITS.md](public/images/CREDITS.md).
