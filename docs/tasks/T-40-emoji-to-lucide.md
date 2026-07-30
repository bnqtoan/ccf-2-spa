---
id: T-40
title: Thay toàn bộ emoji UI bằng icon SVG lucide-react
status: review
model: sonnet
effort: low
depends_on: []
touches:
  - package.json
  - src/app/components/AdminNav.tsx
  - src/app/components/EmptyState.tsx
  - src/app/components/components.css
  - src/app/components/ComponentsDemo.tsx
  - src/app/pages/AdminPage.tsx
  - src/app/routes/admin/setup/SetupPage.tsx
  - src/app/routes/admin/setup/StaffTab.tsx
  - src/app/routes/admin/setup/ServicesTab.tsx
  - src/app/routes/admin/setup/ShiftsTab.tsx
  - src/app/routes/admin/overview/OverviewPage.tsx
  - src/app/routes/admin/reassign/ReassignQueuePage.tsx
  - src/app/routes/admin/reassign/ReassignSheet.tsx
  - src/app/routes/admin/timeline/TimelinePage.tsx
  - src/app/routes/booking/BookingPage.tsx
  - src/app/routes/lookup/LookupPage.tsx
prd_refs: []
owner: null
started_at: 2026-07-30 17:14
finished_at: 2026-07-30 17:14
---

# T-40 · Emoji → lucide SVG icons

## Mục tiêu
Thay 17 emoji khác nhau rải khắp frontend (nav, thẻ trang, tab, empty-state, icon
điện thoại/cảnh báo inline) bằng icon lucide — sắc nét mọi cỡ, tô theo currentColor,
không lệ thuộc cách render emoji của từng máy/OS.

## Phạm vi
**Trong:** đổi glyph, GIỮ nguyên hành vi (mọi data-testid + nhãn chữ). Thêm dependency
`lucide-react`.
**Ngoài:** không đổi layout/logic; giữ "Rảnh"/nhãn chữ bên cạnh icon.

## Đã làm gì
- `npm i lucide-react`. `EmptyState.icon: string → ReactNode` (caller truyền `<Icon/>`).
- Field icon dạng data (AdminNav LINKS, AdminPage CARDS, SetupPage TABS, BookingPage
  ZONE_ICON) đổi sang giữ component `LucideIcon`. Inline glyph (phone/warn) dùng
  `size="1em"` + `.ccf-ico-inline` (căn baseline).
- Map: 📊 BarChart3 · 📅 Calendar · 🗓️ CalendarDays · 🔁 RefreshCw · ⚙️ Settings ·
  👥 Users · 👤 User · 🚪 LogOut · 🌿 Leaf · 🧴 SprayCan · 🕒 Clock · 📞 Phone ·
  ⚠️ TriangleAlert · 🧩 Puzzle · 💆 Sparkles · 💇 Scissors · 💅 Hand · 😊 Smile.
- Verify: typecheck sạch; 453/453 vitest; E2E 102/1-skip; prod build OK (tree-shake).
