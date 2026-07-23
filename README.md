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

## Deploy

Xem [docs/DEPLOY.md](docs/DEPLOY.md) — nối repo với Cloudflare Workers Builds để
tự deploy mỗi lần push.

## Tài liệu

- [docs/PRD.md](docs/PRD.md) — đặc tả nghiệp vụ, mô hình dữ liệu, thuật toán
- [docs/tasks/](docs/tasks/) — cách dự án được chia nhỏ và thực thi

## Ảnh

Ảnh dịch vụ và chân dung lấy từ [Unsplash](https://unsplash.com) (giấy phép miễn
phí thương mại). Chi tiết trong [public/images/CREDITS.md](public/images/CREDITS.md).
