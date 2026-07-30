# BOARD — ccf-2-spa

Bảng tổng. Đọc file này trước khi bắt đầu bất kỳ phiên làm việc nào.

Nguồn sự thật: `docs/PRD.md` (nghiệp vụ) · `docs/tasks/CONVENTIONS.md` (kỹ thuật)
Khuôn card: `docs/tasks/_TEMPLATE.md`

## Trạng thái

`todo → in_progress → review → done`, cộng `blocked`.

**Agent không bao giờ tự đặt `done`.** Cao nhất là `review` — code xong, test
xanh, chờ người đọc diff xác nhận. Test đỏ mà không sửa được thì đặt `blocked`,
ghi lý do, dừng lại; không xoá test, không nới assertion cho xanh.

## Bảng task

| Mã | Tiêu đề | Status | Model | Depends |
|---|---|---|---|---|
| T-01 | Scaffold Worker + Hono + D1 + Vite SPA + test | done | sonnet | — |
| T-02 | Schema D1 + migrations + seed | done | sonnet | T-01 |
| T-03 | **Availability engine** + `GET /api/availability` | done | **opus** | T-02 |
| T-04 | **Booking write path** + re-check + 409 SLOT_TAKEN | done | **opus** | T-03 |
| T-05 | Cancel + cutoff 2h + status transitions | done | sonnet | T-04 |
| T-06 | Admin CRUD API | done | codex | T-02 |
| T-07 | **Time-off + affected_items + reassign queue** | done | **opus** | T-04 |
| T-08 | Walk-in API (miễn lưới 15') | done | sonnet | T-04 |
| T-09 | Design tokens + component base | done | sonnet | T-01 |
| T-10 | UI khách: đặt lịch | done | sonnet | T-09, T-04 |
| T-11 | UI khách: tra cứu + huỷ | done | sonnet | T-09, T-05 |
| T-12 | UI admin: day timeline | done | sonnet | T-09, T-07 |
| T-13 | UI admin: walk-in + reassign queue | done | sonnet | T-12, T-08 |
| T-14 | E2E Playwright: 5 luồng đầu-cuối | done | codex | T-10..T-13 |
| T-15 | Deploy: worker live + D1 remote migrated | done | sonnet | T-14 |
| T-16 | Ba endpoint PRD §9 bị bỏ sót | done | sonnet | T-07 |
| T-17 | UI Thiết lập (nhân viên/skill/dịch vụ/ca) | done | sonnet | T-06, T-09 |
| T-18 | **CI gate** chặn merge nếu typecheck/test đỏ | review | sonnet | T-20 |
| T-19 | **Auth** chặn mọi `/api/admin/*` + trang admin | review | **opus** | T-20 |
| T-20 | Khử non-determinism test → CI serial tất định | done | sonnet | — |
| T-21 | Centralize now() + inject clock (near-midnight walk-in) | done | sonnet | T-20 |
| T-22 | **RBAC** 3 vai trò (owner/lễ tân/KTV) filter-by-role | review | **opus** | T-19 |
| T-23 | Bỏ ADMIN_PASSWORD — owner/admin123 + bắt đổi lần đầu | review | sonnet | T-22 |
| T-24 | **G5** khách tự đổi giờ (reschedule nguyên tử) | review | opus | — |
| T-25 | **G6** UI lễ tân thêm dịch vụ (combo admin) | review | sonnet | T-19, T-22 |
| T-26 | **R1b** combo song song (nhiều KTV cùng lúc) | review | opus | T-19 |
| T-27 | **R6** Telegram nội bộ (báo lễ tân) | review | sonnet | — |
| T-28 | Fix RBAC gap — gate POST /appointments/:id/items | review | sonnet | T-22, T-25 |
| T-29 | **G1/G2** Tạo lịch trên timeline (click ô trống → prefill) | review | sonnet | T-22 |
| T-30 | **G1/G3** Đổi giờ/KTV trên timeline (kéo + nút sheet) | review | opus | T-22, T-24 |
| T-31 | **G4** Timeline week view + chọn ngày + "Hôm nay" | review | sonnet | T-12 |
| T-32 | **G5** Hiện tên+SĐT+nút gọi trên sheet chi tiết lịch | review | sonnet | T-12 |

## Nhóm timeline-as-calendar (T-29..T-32)

Sinh từ **audit timeline độc lập bằng con-mắt-không-biết-code** (agent thao tác app
thật trên browser, không đọc source; kết quả trùng với audit đọc-code). Kết luận:
timeline là **Calendar/Timeline archetype nhưng vi phạm contract của chính nó** —
đây là **một** gap cấu trúc `Archetype mismatch` (P1), không phải chùm gap nhỏ rời
rạc. T-29/T-30/T-31 là ba mặt cụ thể của nó (create / revise / perspective); T-32 là
Relationship-opacity P2 (SĐT khách vắng mặt trên sheet lịch thường) — thứ chỉ
con-mắt-thao-tác-thật bắt được. Ba P1 đều **backend rẻ**: walk-in/reschedule/add-item
endpoint đã có + đã gate RBAC; thiếu là ở surface tương tác trên workspace này.
Nhớ bài học T-28: gate RBAC ở **route**, ẩn nút UI không đủ.

## Cổng trước production (T-18, T-19)

Sau phiên audit + 4 feature song song (operational-safety, combo, dashboard,
payment) đã lên `main`, hệ thống **chạm tiền** (payment) và **lộ số liệu kinh
doanh** (overview). Hai card này là cổng bắt buộc trước khi bật production thật:

- **T-18 CI gate** — không cho code đỏ lên `main`; hiện deploy tự động mà test
  không chạy trong pipeline.
- **T-19 Auth** — mọi route admin (kể cả doanh thu + payment) đang MỞ; PRD cũ ghi
  "No auth in v1", card này chính thức nâng auth vào scope.

Độc lập nhau về code. Nên làm **T-18 trước** (để nó bắt lỗi cho T-19), rồi T-19.
Webhook payment và route khách phải VẪN public — xem cạm bẫy trong T-19.

## Thứ tự chạy

```
T-01
 ├─ T-02 ──┬─ T-03 ── T-04 ──┬─ T-05 ──────────┐
 │         │                 ├─ T-07 ───────┐  │
 │         │                 └─ T-08 ────┐  │  │
 │         └─ T-06                       │  │  │
 └─ T-09 ─────────────────────────────┬──┴──┴──┴─ T-10, T-11, T-12
                                      └─ T-13 (sau T-12)
                                            └─ T-14 ── T-15
```

**Chạy song song được:**
- Sau T-01: T-09 chạy song song toàn bộ nhánh backend
- Sau T-02: T-03 và T-06
- Sau T-04: T-05, T-07, T-08
- Sau T-09 + API tương ứng: T-10, T-11, T-12 (T-13 chờ T-12)

Tối đa 3–4 agent cùng lúc. Nhiều hơn thì xung đột file và review không xuể.

### File dùng chung khi chạy song song

`src/worker/routes/index.ts` bị 7 card cùng khai báo trong `touches`. Đây là
**có chủ ý**: T-01 tạo hàm `registerRoutes()`, mỗi task sau chỉ **thêm đúng một
dòng** vào đó (CONVENTIONS §7). Nhiều agent cùng thêm một dòng ở cuối một hàm
thì git merge được; nếu để mỗi task tự sửa `src/worker/index.ts` theo cách riêng
thì T-05/T-07/T-08 chạy song song sẽ đụng nhau chắc chắn.

`src/worker/index.ts` **chỉ T-01 được sửa**. Các card khác không có nó trong
`touches` — nếu thấy mình cần sửa file đó, dừng lại và báo.

## Vì sao chia model như vậy

**Opus cho T-03, T-04, T-07** — ba chỗ sai thì đắt và **sai thì im lặng**:
T-03 sai → khách bị xếp trùng giờ. T-04 sai → race condition chỉ lộ khi đông
khách. T-07 sai → booking mồ côi không ai biết cho tới lúc khách tới nơi.

**Codex cho T-06, T-14** — lặp lại nhiều, đặc tả rõ, test tự kiểm chứng được.
Gọi qua `mcp__codex__codex`: `sandbox: "workspace-write"`,
`approval-policy: "never"`, `cwd` là root repo.

**Sonnet cho phần còn lại** — CRUD và render, sai thì lộ ngay.

## Cách dispatch

Một task, một agent, một card:

```
Đọc docs/tasks/T-03-availability-engine.md và thực hiện đúng card đó.
Card là nguồn sự thật. Không mở rộng phạm vi.
Xong thì cập nhật frontmatter status: review và điền mục "Đã làm gì".
```

Card tự chứa đủ ngữ cảnh — đó là lý do card dài. Không cần dán thêm PRD.

Sau mỗi task: đọc diff, chạy lại test, kiểm `touches` không bị vượt, rồi mới
đổi `review → done`.
