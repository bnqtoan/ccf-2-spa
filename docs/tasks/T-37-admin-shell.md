---
id: T-37
title: AdminShell — nav + độ rộng thống nhất mọi trang admin + restyle bảng users
status: review
model: sonnet
effort: medium
depends_on: []
touches:
  - src/app/components/AdminShell.tsx
  - src/app/components/AdminShell.css
  - src/app/main.tsx
  - src/app/pages/AdminPage.css
  - src/app/routes/admin/timeline/TimelinePage.tsx
  - src/app/routes/admin/setup/SetupPage.tsx
  - src/app/routes/admin/setup/setup.css
  - src/app/routes/admin/overview/overview.css
  - src/app/routes/admin/users/UsersPage.tsx
prd_refs: []
owner: null
started_at: 2026-07-30 14:16
finished_at: 2026-07-30 14:35
---

# T-37 · AdminShell — khung admin thống nhất

## Mục tiêu
Mọi trang admin dùng CHUNG một khung: cùng thanh nav, cùng độ rộng container. Trước
đó mỗi trang tự đặt độ rộng riêng (720/960/full) → nhảy layout khi chuyển trang. Kèm
restyle bảng Người dùng cho khớp hệ style chung.

## Ngữ cảnh
- Có sẵn `AdminNav` (T-19/T-22, lọc theo role). Thiếu là một wrapper đặt nav + giới
  hạn độ rộng một chỗ để mọi trang kế thừa.

## Phạm vi
**Trong:** component `AdminShell` (nav + container 1100px), áp cho timeline/setup/
overview/users/hub; restyle bảng users bằng `.ccf-su-table` thật.
**Ngoài:** không đổi logic từng trang, chỉ khung + độ rộng + style bảng.

## Đã làm gì
- Thêm `AdminShell.tsx` + `.css`: một wrapper gồm `AdminNav` + container 1100px, mọi
  trang admin bọc trong đó → hết nhảy độ rộng giữa các trang.
- `UsersPage` restyle bằng `.ccf-su-table` (khớp bảng setup) thay markup rời rạc.
- Sửa lỗi hook-order tự gây (hooks đặt sau early-return trong TimelinePage → "Rendered
  more hooks than during the previous render"): dời toàn bộ hook lên trước mọi return.
- Verify: typecheck sạch; E2E full-suite xanh (không đổi hành vi, chỉ layout/style).
