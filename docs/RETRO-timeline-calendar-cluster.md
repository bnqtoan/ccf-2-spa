# Retro — timeline-as-calendar cluster (T-29..T-32)

Ngày: 2026-07-30. Người lái: autopilot (/auto). Cho AI đọc, ngắn gọn.

## Bối cảnh
Từ 2 yêu cầu "tiện lợi" của owner (click tạo lịch như Google Calendar; xem tuần/
tháng) → sửa **guide audit** (không phải sửa code) → audit độc lập bằng
con-mắt-không-biết-code xác nhận → 4 card. Tất cả đã merge + verify, `review`, chờ
sign-off. Full suite 442/442, E2E timeline 25/25 (chạy tuần tự).

## Cái gì ĐÚNG (giữ)
- **Một nguyên lý tổng quát > nhiều luật riêng.** Sửa guide bằng "workspace phải hợp
  archetype contract" gộp 2 yêu cầu rời thành **một** gap P1 (archetype mismatch),
  không phải P1-lẻ + P3-lẻ. Fresh agent (2 lần, 2 môi trường) tự đi tới đúng kết
  luận — nguyên lý tổng quát hoá, không overfit.
- **Con-mắt-không-biết-code bắt cái đọc-code bỏ sót.** Browser agent tìm ra "SĐT
  khách vắng trên sheet lịch thường" (T-32) — cái *vắng mặt* trên UI, không lộ khi
  đọc source.
- **Agent dừng ở ranh giới thật, không bulldoze.** T-29 v1 block đúng chỗ (endpoint
  under-spec), T-30 bỏ edge-resize thật thà (backend giữ variant). Rule "ngoài
  touches thì dừng + báo" hoạt động.
- **Verify bằng chính tay planner, không tin report.** Mỗi merge tự chạy typecheck +
  suite trên main (per-card PASS ≠ integrated-green). Bắt được đúng con số baseline
  tăng dần 427→431→438→442.
- **Reuse write-path, không viết validate mới.** T-29 dùng lại `insertBookingAtomically`
  (`source='admin'` đã type sẵn, chưa route nào dùng); T-30 dùng lại reschedule
  nguyên tử T-24 → không đẻ race mới.
- **RBAC ở route, không ẩn UI** (bài học T-28 áp đúng: T-29 gate route; T-32 free-ride
  trên row-filter `resolveOnlyStaffId` sẵn có).

## Cái gì CHẬM / SAI (sửa lần sau)
- **Worktree không có node_modules** → v1 typecheck/test vô nghĩa (báo `hono` giả).
  Fix: mọi agent `npm install` + copy `.dev.vars` + `db:migrate:local` trước khi
  code. Đưa vào dispatch-template mặc định.
- **Audit→card handoff under-spec backend touches 3/4 lần.** Audit thấy gap UI nhưng
  card chỉ liệt file UI; đóng gap luôn cần file backend (T-29 route mới, T-31 range
  endpoint, T-32 payload phone). Planner phải widen trước dispatch mỗi lần. → sửa
  `_TEMPLATE.md`: khi card đụng UI-đọc-dữ-liệu-mới, buộc hỏi "payload/endpoint nào
  cấp dữ liệu này?" và liệt file đó vào touches.
- **Worktree-isolated subagent là công cụ SAI cho 4 sửa nhỏ cùng 1 file.** Ceremony
  (install + isolation) > lợi ích; và vì cùng đụng `TimelinePage.tsx` nên buộc phải
  serialize → mất luôn lợi thế parallel. Đúng cho việc lớn, nhiều file, disjoint.
  Lần sau: sửa nhỏ cùng file → build thẳng in-session hoặc parallel-chỉ-phần-disjoint.
- **2 executor chết giữa chừng** (T-29 v1 block hợp lệ; T-32 v1 API stall). Không mất
  code (worktree giữ). Nhưng nhắc: notification CAN be lost → backstop + đọc worktree
  thật khi wake, đừng tin im lặng.

## Nợ kỹ thuật phát hiện (KHÔNG thuộc cluster này — card riêng)
Xem `docs/tasks/T-33-e2e-parallel-d1-contention.md`.

**Điểm mấu chốt (owner nhắc đúng):** đây KHÔNG phải nợ mới sinh từ cluster, và một
phần TRÔNG như đã-được-sửa-rồi nhưng chưa:
- `chromium-shared-queue` (workers:1) đã sửa **race LOGIC global-state** (hàng chờ
  reassign) — cluster ta chạy trong project này nên luôn xanh.
- Nhưng project `chromium` mặc định vẫn `fullyParallel:true`, và nhiều spec seed qua
  `wrangler d1 execute --local` = nhiều tiến trình mở thẳng 1 file SQLite → **race
  TÀI NGUYÊN** (SQLITE_BUSY) + dev server OOM (exit 137). `customer-reschedule.spec.ts:70`
  (`rs-slot-` không hiện) nhiều khả năng là *triệu chứng* của việc file khác seed
  đồng thời làm hỏng availability — không phải bug logic của reschedule.
- Tức là T-20-era chỉ đóng nửa vấn đề (logic), nửa còn lại (D1 subprocess concurrency)
  vẫn mở. Đừng file trùng "flaky parallel" như thể chưa ai đụng — phải nói rõ nửa nào.

## Một dòng rút ra
Guide bớt luật + một nguyên lý tổng quát = model theo đúng hơn; verify bằng tay +
agent-dừng-ở-ranh-giới = autonomy không trôi; nhưng audit→card luôn thiếu backend
files và worktree-cho-việc-nhỏ là phí — hai chỗ sửa quy trình.
