---
id: T-09
title: Design tokens + component base dùng chung
status: review
model: sonnet
effort: medium
depends_on: ["T-01"]
touches:
  - src/app/styles/tokens.css
  - src/app/components/
  - tests/e2e/components.spec.ts
prd_refs: ["§10"]
owner: null
started_at: null
finished_at: "2026-07-21"
---

# T-09 · Design tokens + component base dùng chung

## Mục tiêu
Có một bộ token CSS + component nền tảng (Button, Card, Pill, Field, Notice,
Sheet, Avatar, EmptyState) mà mọi màn hình sau (T-10..T-13) import và dùng lại,
thay vì mỗi task tự vẽ lại nút và thẻ theo ý mình.

## Ngữ cảnh cần biết
`prototype/index.html` là **spec giao diện đã duyệt** — không phải gợi ý, là
nguồn sự thật cho token màu, bo góc, khoảng cách, và tên class. Nhiệm vụ ở đây
là **port**, không phải thiết kế lại. Toàn bộ biến số dưới đây trích nguyên văn
từ `<style>` của prototype (dòng 8–21):

```css
:root{
  --g-900:#14342a; --g-800:#1c4a3a; --g-700:#26654f; --g-600:#2f8064;
  --g-500:#3d9b7a; --g-300:#8fc9b3; --g-100:#dff0e8; --g-50:#f1f8f4;
  --ink:#16241f; --ink-2:#4a5f57; --ink-3:#7d918a;
  --line:#e6efe9; --bg:#f4f8f5; --white:#fff;
  --warn-bg:#fff6e6; --warn-line:#f0d9a8; --warn-ink:#7a5714;
  --danger:#b4342b; --danger-bg:#fdeceb;
  --sand:#f6f2e9;
  --r:18px; --r-sm:13px;
  --shadow:0 1px 2px rgba(20,52,42,.05), 0 10px 30px -12px rgba(20,52,42,.16);
  --shadow-lift:0 2px 6px rgba(20,52,42,.07), 0 18px 42px -16px rgba(20,52,42,.24);
  --ease:cubic-bezier(.22,.68,.32,1);
  --tap:48px;
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms !important;transition-duration:.01ms !important}
}
```

`--tap:48px` không phải trang trí — đây là vùng chạm tối thiểu bắt buộc cho mọi
phần tử bấm được, vì người dùng cuối là khách phổ thông thao tác bằng ngón tay
trên điện thoại, không phải chuột. `--sand` giữ nền không bị lạnh (thuần xanh
lá dễ trông như bệnh viện) — dùng cho các mảng nền phụ, không dùng làm màu chữ.

Các class cụ thể cần port thành component (tên class trong prototype, để agent
đối chiếu, không bắt buộc giữ tên class y hệt trong React nhưng hành vi/nhìn
phải giống):
- `.btn`, `.btn.ghost`, `.btn.danger`, `.btn.sm`, `.btn:disabled` (dòng 179–194)
- `.card`, `.card.sel` (dòng 93–110)
- `.pill`, `.pill.gray`, `.pill.warn`, `.pill.red` (dòng 112–116)
- `.field` (input/select), focus state viền xanh (dòng 152–161)
- `.notice.info`, `.notice.warn` (dòng 197–203)
- `.mask` + `.sheet` — modal trượt lên từ đáy màn hình, đóng bằng nút `.x` hoặc
  bấm nền (dòng 291–317, hàm `sheet()`/`closeSheet()` dòng 853–854)
- `.av` (avatar tròn viết tắt tên, dòng 322–327)
- `.empty` (trạng thái rỗng, icon + chữ, dòng 335–336)

## Phạm vi
**Trong:**
- `src/app/styles/tokens.css` — toàn bộ biến `--g-*`, `--ink*`, `--line`,
  `--bg`, `--warn-*`, `--danger*`, `--sand`, `--r`, `--r-sm`, `--shadow*`,
  `--ease`, `--tap`, và khối `@media(prefers-reduced-motion:reduce)`
- `src/app/components/Button.tsx` (+ biến thể primary/ghost/danger/sm, disabled)
- `src/app/components/Card.tsx` (thường + `selected`)
- `src/app/components/Pill.tsx` (mặc định/gray/warn/red)
- `src/app/components/Field.tsx` (input + select, label, hint, focus ring)
- `src/app/components/Notice.tsx` (info/warn)
- `src/app/components/Sheet.tsx` (modal đáy: mask, grab handle, nút X, đóng khi
  bấm nền)
- `src/app/components/Avatar.tsx`
- `src/app/components/EmptyState.tsx`
- `tests/e2e/components.spec.ts`

**Ngoài:**
- Không dựng màn hình nghiệp vụ nào (booking, lookup, timeline...) — đó là
  T-10..T-13
- Không thêm biến màu/token nào không có trong prototype
- Không đổi giá trị màu/bo góc/shadow so với prototype — đây là port, không
  phải thiết kế lại

## Đầu vào đã có
- T-01 để lại scaffold Vite/React tại `src/app/` với router `/` và `/admin`
  đã chạy được — component ở đây chỉ cần import vào, không cần dựng lại app
  shell.
- `prototype/index.html` — spec giao diện duy nhất để tham chiếu token, class,
  và hành vi tương tác (hover/active/disabled/focus). Đọc trực tiếp file này,
  không suy đoán.

## Việc phải làm
1. Tạo `src/app/styles/tokens.css`, copy nguyên các biến `:root` và khối
   `prefers-reduced-motion` từ prototype (dòng 8–24). Import file này ở entry
   point của SPA (nơi T-01 để lại, ví dụ `src/app/main.tsx`).
2. Với mỗi component, port đúng style + trạng thái tương tác từ CSS class
   tương ứng trong prototype (đối chiếu số dòng ở trên):
   - `Button`: props `variant` (`primary` mặc định | `ghost` | `danger`),
     `size` (`md` mặc định | `sm`), `disabled`. Chiều cao tối thiểu `--tap`
     (trừ biến thể `sm` theo đúng prototype là 44px — vẫn ghi rõ đây là ngoại
     lệ có chủ đích, không phải lỗi).
   - `Card`: props `selected`, click handler, nội dung tự do (children).
   - `Pill`: props `tone` (`default` | `gray` | `warn` | `red`).
   - `Field`: props cho input hoặc select, `label`, `hint`, `error` tuỳ chọn,
     `type` (bao gồm `tel` cho số điện thoại).
   - `Notice`: props `tone` (`info` | `warn`), children.
   - `Sheet`: props `open`, `onClose`, `title`, children cho phần thân + phần
     chân (nút hành động). Đóng khi bấm nút X **hoặc** bấm vào lớp nền mờ
     (không đóng khi bấm bên trong sheet — xem `onclick="if(event.target===this)"`
     dòng 393 của prototype).
   - `Avatar`: prop `name`, tự lấy chữ cái đầu của từ cuối trong tên (theo cách
     prototype làm ở nhiều chỗ: `name.split(' ').pop()[0]`).
   - `EmptyState`: props `icon` (emoji), `text`.
3. Viết `tests/e2e/components.spec.ts` dựng một trang demo tối thiểu (hoặc route
   ẩn) render đủ các component để Playwright kiểm tra.

## Quy ước bắt buộc
`docs/tasks/CONVENTIONS.md` §7 (cấu trúc thư mục — component thuộc `src/app/`).

Nhấn lại:
- Vùng chạm tối thiểu 48px (`--tap`) áp dụng cho mọi phần tử bấm được, trừ
  ngoại lệ `.btn.sm` (44px) đã có sẵn trong prototype.
- Chữ tối thiểu 15px cho nội dung khách đọc — theo cỡ chữ prototype đã dùng
  (`body{font-size:17px}`, `.field input{font-size:17px}`, `.hint{13px}` chỉ
  cho phụ chú).
- Phải giữ `@media(prefers-reduced-motion:reduce)` — tắt animation cho người
  dùng đã bật cờ hệ điều hành, không được bỏ qua vì "component đơn giản không
  cần".

## Checklist đầu ra
- [ ] `npm run typecheck` xanh
- [ ] `npm run e2e -- tests/e2e/components.spec.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at` trong frontmatter card này
- [ ] Ghi "Đã làm gì"

## Test phải viết
`tests/e2e/components.spec.ts`
- `nút Button primary có vùng chạm cao tối thiểu 48px`
- `nút Button size sm vẫn đủ cao tối thiểu 44px theo đúng prototype`
- `Sheet mở ra khi trigger, đóng được khi bấm nút X`
- `Sheet đóng được khi bấm vào lớp nền mờ phía sau`
- `Sheet không đóng khi bấm vào nội dung bên trong sheet`
- `Field input hiện viền xanh rõ ràng khi focus (không mất outline)`
- `component render đúng ở viewport 375px, không có phần tử nào tràn ngang trang`
- `Button disabled không nhận click (onClick không được gọi)`

## Định nghĩa "xong"
Mở trang demo component trên viewport 375px, không phần tử nào tràn ngang, và
mọi nút/field bấm/focus đúng như mô tả — kiểm chứng được bằng
`npm run e2e -- tests/e2e/components.spec.ts`.

## Cạm bẫy đã biết
- Prototype dùng CSS thuần global (`.btn`, `.card`...) — khi port sang React
  component, đừng để trùng tên class với style framework khác nếu project có
  sẵn (kiểm tra T-01 đã chọn styling approach nào: CSS module, plain CSS, hay
  Tailwind — bám theo đó, không tự đổi hướng).
- `.btn.sm` cố ý thấp hơn `--tap` (44px so với 48px) — đừng "sửa" nó lên 48px
  tưởng là tuân thủ quy tắc, đây là ngoại lệ prototype đã duyệt cho nút phụ nhỏ
  nằm cạnh nút khác, không phải lỗi.
- Sheet phải phân biệt bấm nền và bấm nội dung bên trong — nếu bắt sự kiện click
  sai (bắt trên toàn bộ overlay thay vì check `event.target === overlay`) sẽ
  đóng luôn khi người dùng chỉ đang bấm vào nút bên trong sheet.

## Đã làm gì
- Tạo `src/app/styles/tokens.css` (biến `--g-*`, `--ink*`, `--line`, `--bg`,
  `--warn-*`, `--danger*`, `--sand`, `--r`, `--r-sm`, `--shadow*`, `--ease`,
  `--tap` + `@media(prefers-reduced-motion:reduce)`), import ở
  `src/app/main.tsx` (entry point, theo đúng chỉ dẫn của card).
- Tạo 8 component tại `src/app/components/`: `Button.tsx`, `Card.tsx`,
  `Pill.tsx`, `Field.tsx`, `Notice.tsx`, `Sheet.tsx`, `Avatar.tsx`,
  `EmptyState.tsx` — style dùng chung nằm trong `components/components.css`
  (class prefix `ccf-` để tránh đụng framework CSS khác sau này), mỗi file
  import trực tiếp `./components.css`.
- Quy ước import cho T-10..T-13: `import Button from '../components/Button'`
  (default export mỗi component, không barrel `index.ts`). Props: `Button`
  (`variant`: primary/ghost/danger, `size`: md/sm), `Card` (`selected`),
  `Pill` (`tone`: default/gray/warn/red), `Field` (`label`, `hint`, `error`,
  `as="select"` cho select, mặc định input — hỗ trợ mọi `type` kể cả `tel`),
  `Notice` (`tone`: info/warn), `Sheet` (`open`, `onClose`, `title`, children,
  `footer`), `Avatar` (`name`), `EmptyState` (`icon`, `text`).
- Route demo ẩn `/dev/components` (`src/app/components/ComponentsDemo.tsx`,
  wired trong `main.tsx`) render đủ 8 component cho Playwright — không phải
  màn hình nghiệp vụ, T-10..T-13 không cần đụng route này.
- Đã thêm `box-sizing: border-box` cục bộ cho `.ccf-btn/.ccf-card/.ccf-field-input`
  (component nào có `width:100%` + padding) vì prototype dựa vào reset global
  `*{box-sizing:border-box}` không có trong scope tokens.css — nếu không thêm,
  Field input tràn ngang 8px ở viewport 375px.
- Test: `npm run typecheck` xanh, `npm run e2e -- tests/e2e/components.spec.ts`
  xanh (8/8), `npm run e2e` toàn bộ xanh (10/10, không phá smoke.spec.ts).
</content>
