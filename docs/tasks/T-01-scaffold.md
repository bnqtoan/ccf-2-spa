---
id: T-01
title: Scaffold Worker + Hono + D1 + Vite SPA + Vitest/Playwright
status: todo
model: sonnet
effort: medium
depends_on: []
touches:
  - package.json
  - tsconfig.json
  - wrangler.jsonc
  - vite.config.ts
  - vitest.config.ts
  - playwright.config.ts
  - src/worker/index.ts
  - src/worker/routes/index.ts
  - src/app/
  - tests/api/smoke.test.ts
  - tests/e2e/smoke.spec.ts
prd_refs: ["§2", "§10"]
owner: null
started_at: null
finished_at: null
---

# T-01 · Scaffold Worker + Hono + D1 + Vite SPA + Vitest/Playwright

## Mục tiêu
Dựng bộ khung chạy được: một Worker phục vụ cả API (Hono) lẫn React SPA, có D1
gắn sẵn, và **hai đường test chạy xanh** để 14 task sau có chỗ mà verify. Không
có task nào sau đó tự dựng lại hạ tầng test.

## Ngữ cảnh cần biết
Stack đã chốt (PRD §2): Cloudflare Workers + D1 + Hono + React SPA (Vite).
Không auth trong v1 — `/admin/*` chỉ là một route thường.

Máy đã có: Node v22.22.3, npm 10.9.8, wrangler 4.112.0.

Test API **phải** chạy trong workerd với D1 thật qua
`@cloudflare/vitest-pool-workers`, không mock D1. Lý do: logic booking phụ thuộc
hành vi transaction thật của SQLite; mock sẽ cho test xanh giả.

## Phạm vi
**Trong:**
- `package.json` với scripts: `dev`, `build`, `typecheck`, `test`, `e2e`, `deploy`
- `wrangler.jsonc`: Worker + D1 binding `DB` + assets cho SPA
- Hono app tối thiểu với `GET /api/health` → `{ ok: true }`
- React SPA tối thiểu: 2 route `/` và `/admin` render chữ khác nhau
- Vitest + `@cloudflare/vitest-pool-workers` + 1 test smoke gọi `/api/health`
- Playwright + 1 spec smoke mở `/` và `/admin`
- TypeScript strict

**Ngoài:**
- Không tạo bảng nào (T-02 làm)
- Không viết logic nghiệp vụ
- Không port giao diện từ prototype (T-09 làm)

## Đầu vào đã có
- `docs/PRD.md` — §2 stack, §10 frontend
- `prototype/index.html` — chỉ để tham khảo, **không import vào build**
- `.gitignore` đã có sẵn

## Việc phải làm
1. `npm init`, cài: `hono`, `react`, `react-dom`, `react-router-dom`, và dev deps
   `wrangler`, `typescript`, `vite`, `@cloudflare/vite-plugin`, `vitest`,
   `@cloudflare/vitest-pool-workers`, `@playwright/test`, `@types/*`.
2. `wrangler.jsonc`: `main` trỏ Worker, `compatibility_date` gần nhất,
   `d1_databases` binding tên `DB` (`database_name: "ccf-spa"`), `assets` cho SPA
   build output, `nodejs_compat` nếu cần.
3. `src/worker/index.ts`: Hono app, gọi `registerRoutes(app)`, fallback trả SPA
   assets. **Đây là task duy nhất được sửa file này** — sau T-01 nó đứng yên.
4. `src/worker/routes/index.ts`: điểm gom route duy nhất (CONVENTIONS §7). T-01
   tạo khung + mount `/api/health`; mọi task sau chỉ **thêm một dòng** vào hàm
   `registerRoutes`. Có file này thì T-05, T-07, T-08 chạy song song không giẫm
   chân nhau; không có nó thì ba agent cùng sửa `index.ts` và merge sẽ vỡ.

   ```ts
   import type { Hono } from 'hono'
   export function registerRoutes(app: Hono) {
     app.get('/api/health', (c) => c.json({ ok: true }))
     // các task sau thêm dòng của mình vào đây
   }
   ```
5. `src/app/`: entry React + router 2 route.
6. `vitest.config.ts` dùng `defineWorkersConfig`, trỏ `wrangler.jsonc`, bật
   D1 migrations dir (kể cả khi migrations còn rỗng).
7. `tests/api/smoke.test.ts`: gọi `/api/health` qua `SELF.fetch`, assert 200.
8. `playwright.config.ts`: `webServer` chạy `npm run dev`, baseURL localhost.
9. `tests/e2e/smoke.spec.ts`: mở `/` và `/admin`, assert nội dung khác nhau.
10. Chạy đủ 3 lệnh cho xanh: `npm run typecheck`, `npm test`, `npm run e2e`.

## Quy ước bắt buộc
Đọc `docs/tasks/CONVENTIONS.md` §7 (cấu trúc thư mục) và §8 (test).
Điểm quan trọng: `src/worker/lib/` dành cho logic thuần, không import D1 —
tạo sẵn thư mục kèm `.gitkeep`.

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm test` xanh (smoke API)
- [ ] `npm run e2e` xanh (smoke UI)
- [ ] `npm run dev` mở được `/` và `/admin` trên trình duyệt
- [ ] `npm run build` không lỗi
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/api/smoke.test.ts`
- `GET /api/health trả 200 và { ok: true }`
- `route API không tồn tại trả 404`

`tests/e2e/smoke.spec.ts`
- `trang khách / render được`
- `trang admin /admin render được và khác trang khách`

## Định nghĩa "xong"
Chạy `npm test && npm run e2e` từ thư mục sạch (sau `npm ci`) đều xanh, và
`npm run dev` phục vụ được cả SPA lẫn `/api/health`.

## Cạm bẫy đã biết
- `@cloudflare/vitest-pool-workers` cần `defineWorkersConfig` (không phải
  `defineConfig` thường) và phải trỏ đúng `wrangler.jsonc`, nếu không D1 binding
  sẽ `undefined` trong test — lỗi này lộ ra mãi tận T-03.
- Playwright `webServer.reuseExistingServer` để `!process.env.CI`, nếu không mỗi
  lần chạy local sẽ treo vì port bận.
- Đừng để Vite build SPA đè lên đường dẫn `/api/*`; kiểm tra fallback SPA không
  nuốt request API.

## Đã làm gì
(agent điền khi xong)
