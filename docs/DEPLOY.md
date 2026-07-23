# Deploy — Cloudflare Workers Builds

Auto-deploy: nối repo GitHub với Cloudflare, mỗi push lên `main` → Cloudflare tự
build + deploy. Không cần API token trong GitHub.

## Chuẩn bị một lần (trước khi nối)

### 1. Tạo D1 remote thật

`wrangler.jsonc` hiện trỏ `database_id` tới D1 **local**. Deploy cần D1 remote:

```bash
npx wrangler d1 create ccf-spa
```

Lệnh này in ra `database_id` mới. **Thay `database_id` trong `wrangler.jsonc`**
bằng id đó. (Local vẫn chạy bình thường vì `--local` không đọc id này.)

### 2. Chạy migrations lên D1 remote

Workers Builds chỉ chạy `npm run build` + `wrangler deploy` — **không tự áp
migrations**. Chạy tay một lần trước khi deploy đầu tiên (script đã có sẵn):

```bash
npm run db:migrate:remote
```

Sau này mỗi khi thêm file vào `migrations/`, chạy lại lệnh này. (Không tự động
hoá trong build — migration là thao tác không nên chạy mù trong CI.)

### 3. Seed dữ liệu ban đầu lên remote (tuỳ chọn)

Production **nên có dữ liệu thật**, không phải dữ liệu seed dùng cho test. Sau
khi deploy, mở trang `/admin` và tạo dịch vụ/KTV/ca làm việc thật qua giao diện.

(Nếu chỉ muốn xem thử nhanh với dữ liệu mẫu, `src/worker/db/seed.ts` export
`buildSeedStatements()` trả về danh sách câu SQL — có thể viết một script nhỏ đổ
lên remote, nhưng không khuyến khích cho production thật.)

## Nối repo (trong dashboard Cloudflare)

1. Cloudflare Dashboard → Workers & Pages → Create → Workers → **Connect to Git**.
2. Chọn repo `ccf-2-spa`, branch `main`.
3. Build command: `npm run build` — Cloudflare tự chạy `wrangler deploy` sau đó.
4. Cloudflare tự phát hiện binding D1 `DB` từ `wrangler.jsonc`.
5. Save → push đầu tiên sẽ trigger build.

Từ đây, mỗi `git push origin main` → tự deploy.

## Smoke test sau deploy đầu tiên

URL production dạng `https://ccf-2-spa.<account>.workers.dev`.

1. `GET /api/health` → `{ ok: true }`
2. `GET /api/services` → có dịch vụ (nếu đã seed) hoặc `{ services: [] }`
3. Mở `/` → trang đặt lịch render, có ảnh dịch vụ
4. Mở `/admin/timeline` → lịch ngày render
5. Đặt thử một lịch → vào `/lookup` tra bằng SĐT vừa nhập → huỷ

Nếu `/api/*` trả 500: gần như chắc chắn **quên chạy migrations remote** (bước 2)
— bảng chưa tồn tại.

## Rollback

Workers Builds giữ lịch sử deploy. Dashboard → Worker → Deployments → chọn bản
cũ → **Rollback**. Hoặc `git revert` rồi push, deploy mới sẽ ghi đè.

## Lưu ý bảo mật khi repo PUBLIC

- `.dev.vars` đã trong `.gitignore` — không commit secret.
- `database_id` trong `wrangler.jsonc` không phải secret (chỉ là định danh, cần
  quyền tài khoản mới truy cập được) — commit bình thường.
- Ảnh trong `public/images/` đều từ Unsplash (giấy phép thương mại) — xem
  `public/images/CREDITS.md`.
