# Product Completeness Audit — ccf-2-spa (v2, làm mới)

> **CẬP NHẬT 2026-07-24 (sau khi thi công 3 track song song, đã merge vào main):**
> Các gap sau ĐÃ ĐÓNG và verify (npm test 283 pass, e2e 76/76, no-code Gate-2 PASS mỗi track):
> - **G0** (P0 silent side-effect) — deactivate KTV có lịch nay bị CHẶN + gợi ý Báo nghỉ. `main@f5450f2`
> - **G1** — nút "Báo nghỉ" trên timeline (POST time-off), lịch ảnh hưởng vào hàng chờ. `main@f5450f2`
> - **G3/G4** — AdminNav chung 3 trang + "Xử lý ngày" điều hướng thật. `main@f5450f2`
> - **G2** — /admin/overview: lưới lấp đầy + KPI DT/lịch/lấp-đầy/no-show + lương KTV (migration 0002). `main@88c5c5b`
> - **R1a** (combo nối tiếp 1 KTV) — UI khách chọn nhiều dịch vụ, cảnh báo trước khi commit. `main@4df633a`
>
> CÒN MỞ (backlog, chưa làm): G5 đổi giờ khách, G6 combo item admin UI, G7-G12 (vocab/constraint/relationship/repeated-work/404/week-view),
> R1b combo song song, R6 Telegram → R4 rating, R3 subscribe. Payment SePay+PayPal đang chờ (task riêng).
> Flaky E2E dưới parallel workers: đã tách task fix riêng.
>
> Phần dưới là bản audit gốc, giữ nguyên làm hồ sơ.

---

Chạy lại từ đầu theo `product-completeness-audit.md`, **bỏ bản audit cũ**.
Findings tách khỏi proposals. **Chưa sửa code** — chờ product owner duyệt.

**Evidence lần này:**
- 4 scout song song có file:line: domain / capabilities / surfaces / tests-docs.
- **Tự chạy app thật trên browser** đi hết luồng khách (đặt → tra cứu → huỷ) + xem 3 workspace admin.
- **Nearest-wrong-action test bằng con-mắt-không-biết-code**: một agent riêng KHÔNG đọc source, chỉ thao tác app, đóng vai lễ tân bị kẹt. Đây là bước bản cũ tự nhận đã bỏ — lần này chạy đủ, và **nó tìm ra một P0 mà bản cũ bỏ sót**.
- Ngày: 2026-07-24. Git: `main` @ `c31f54f`.

---

## 1. Executive diagnosis

**App phản chiếu implementation, không phản chiếu công việc — và lỗ hổng nguy hiểm nhất không phải "thiếu nút", mà là một cái BẪY IM LẶNG.**

Engine cực chắc: ~330 test (231 API + 63 E2E + 36 unit) chạy trên D1 thật, luật một-chỗ (`validateBooking` dùng lại 4 đường ghi), chống race bằng SQL guard. Nửa khách (đặt/tra cứu/huỷ) trưởng thành, đúng hình dạng công việc — tôi tự đặt lịch end-to-end thành công (mã 1085).

Nhưng khi hỏi "một spa thật vận hành thế nào" — họ **báo KTV nghỉ đột xuất mỗi tuần**, **cứu khách của KTV nghỉ**, **cuối tháng cộng doanh thu** — thì:

1. **BẪY IM LẶNG (P0, MỚI phát hiện).** Không có nút "báo KTV nghỉ". Lễ tân bị kẹt sẽ với tay vào thứ gần nghĩa nhất: **Thiết lập → Nhân viên → "Cho ngưng làm"**. Con-mắt-không-biết-code đã làm đúng vậy trên KTV Lan (đang có lịch khách 17:00). Kết quả: **cả cột Lan + lịch khách biến mất khỏi timeline, KHÔNG cảnh báo trước, KHÔNG dấu vết sau, và hàng chờ reassign vẫn báo "không còn lịch nào cần xếp lại".** Khách đã trả tiền bị bỏ rơi âm thầm, không màn hình nào cho lễ tân biết. Data không mất (bật lại KTV thì hiện lại) nhưng trong lúc "ngưng làm" thì khách vô hình và vô-người-quản.

2. **Năng lực vô hình.** `POST /api/admin/time-off` **và** `POST /api/admin/appointments/:id/items` (ghép combo) đều có backend + test đầy đủ nhưng **không có đường vào UI nào** (grep `src/app` = rỗng cho cả hai). Đáng chú ý: **PRD.md dòng 13 + §8 liệt kê time-off là MVP đã làm** — docs nói xong, sản phẩm thì chưa.

3. **Lớp đo lường vắng mặt hoàn toàn.** `price` lưu mọi variant, `no_show` ghi được — nhưng 0 endpoint aggregate (`grep SUM|GROUP BY|revenue` trên `src/worker` → chỉ 1 comment). Chủ spa không trả lời được câu kinh doanh nào.

---

## 2. Operating model

Không auth v1 — mọi actor chung admin UI mở (`PRD.md:8-9`). Phân biệt theo CÔNG VIỆC.

### 2a. Job app HIỆN hỗ trợ

| # | Actor | Trigger | Job (nhỏ) | Decision | Action | Expected result | Exceptions |
|---|---|---|---|---|---|---|---|
| J1 | Khách | Muốn dịch vụ | Chọn dịch vụ + gói | Gói nào | service→variant | Biết giá/thời lượng | — |
| J2 | Khách | Đã chọn gói | Tìm giờ + (chọn KTV) | Giờ nào, ai | slot+staff | Có slot | Ngày kín |
| J3 | Khách | Đã chọn giờ | Xác nhận + để danh tính | Đúng chưa | tên+SĐT→confirm | Có mã đặt | Slot vừa mất |
| J4 | Khách | Cần huỷ | Huỷ lịch mình | Còn kịp? | tra SĐT→huỷ | Slot mở lại | <2h→gọi |
| J5 | Lễ tân | Khách tới không hẹn | Nhận walk-in | KTV nào rảnh | quick booking | KTV bận ngay | Không ai rảnh |
| J6 | Lễ tân | Khách tới/rời | Đổi trạng thái lịch | Bắt đầu/xong/vắng | bấm block→status | Trạng thái đúng | Transition sai |
| **J7** | **Lễ tân** | **KTV nghỉ đột xuất** | **Ghi KTV nghỉ** | **Nghỉ từ mấy giờ** | **(tạo time-off)** | **Lịch ảnh hưởng lộ ra** | **—** |
| J8 | Lễ tân | Có lịch mồ côi | Cứu từng lịch | Chuyển ai/huỷ | reassign/cancel | Khách được xử lý | Không ai nhận |
| J9 | Chủ spa | KTV mới | Thêm NV + skill | Ai, skill gì | setup staff | KTV vào hệ thống | — |
| J10 | Chủ spa | Đổi menu/giá | Thêm/sửa DV + gói | Tên, giá, thời lượng | setup services | Menu đúng | Xoá skill đang dùng |
| J11 | Chủ spa | Xếp lịch làm | Đặt ca | Thứ nào, giờ nào | setup shifts | Ca đúng | end≤start |
| **J12** | **Lễ tân** | **Khách muốn thêm DV thứ 2 trong cùng buổi** | **Ghép combo item** | **DV gì, ai làm** | **(add item)** | **Cùng buổi 2 DV** | **trùng body_zone** |

### 2b. CANDIDATE JOBS — domain có, app CHƯA làm (HYPOTHESIS, chờ duyệt)

| # | Actor | Job domain | Vì sao thật | Nguồn |
|---|---|---|---|---|
| C1 | Chủ spa | Doanh thu ngày/tuần/tháng | Quyết giá/lương | `price` lưu, không tổng hợp |
| C2 | Chủ spa | Tỷ lệ lấp đầy từng KTV | Quyết tuyển/cắt ca | ca+booking có, không có phép chia |
| C3 | Chủ spa | Theo dõi no_show + SĐT lặp | Quyết đặt cọc/chặn số | `no_show` ghi mà không đọc |
| C4 | Khách/lễ tân | Đổi giờ (reschedule) | Khách bận, dời chứ không bỏ | chỉ có huỷ |
| C5 | Hệ thống | Nhắc khách trước hẹn | Giảm no_show | PRD §"Out" v2 |
| C6 | Khách | Đặt lịch định kỳ | Khách đều đặn | PRD §"Out" v2 |
| C7 | Chủ spa | Lịch sử/khách quen | Chăm sóc, upsell | tra thô theo phone |
| C8 | Lễ tân | Nghỉ phép CỐ ĐỊNH (off thứ 3 hàng tuần) | Lịch nền, khác đột xuất | PRD §"Out" |
| C9/C10 | Chủ spa | Phòng/giường; đa chi nhánh | Tài nguyên hữu hạn; chuỗi | PRD §12 hoãn có chủ ý |

C9/C10 PRD cố ý hoãn; C5/C6 xếp v2. Ghi để đầy đủ, không đề xuất v1.

---

## 3. Object relationship map

```
Khách ──đặt──> Appointment ──gồm──> BookingItem(s)
                   │ source                │
                   │ (online/walk_in/admin)├─ staff_id ─> Staff ─có─> Skill(s)
                   │                        │               │  active 0/1
                   │                        ├─ variant ─> ServiceVariant ─> Service ─cần─> Skill
                   │                        │            (duration,buffer,price)  (body_zone)
                   │                        └─ [start_at, block_end_at)  ← chiếm chỗ (gồm buffer)
Staff ─làm theo─> WorkShift (weekday, start_min..end_min)
Staff ─nghỉ─> TimeOff (start_at..end_at)  ← chồng BookingItem = "mồ côi" (JOIN suy ra)
```

Invariant (evidence trong scout domain, file:line):
- Chiếm chỗ `[start_at, block_end_at)` nửa mở, gồm buffer; `end_at` chỉ để hiện (`availability.ts:1-8`, `validate-booking.ts:58-64`).
- `booked→{in_service,cancelled,no_show}`, `in_service→done`; terminal cố định (`status.ts:20-28`).
- Cutoff huỷ khách 120', server-side; admin miễn (`status.ts:11-41`, `admin-status.ts:87-93`).
- Hàng chờ reassign **suy ra bằng JOIN** `status IN(booked,in_service) ∩ time_off`, KHÔNG có cờ (`timeoff.ts:160-176`).
- **`staff.active=0` lọc KTV khỏi MỌI query hiển thị** (`availability.ts:75-76`, `admin-schedule.ts` JOIN active=1) — đây là gốc của bẫy im lặng: tắt active giấu luôn cả lịch đang có.
- Reassign validate y hệt booking mới — một luật một chỗ (`admin-reassign.ts:157`).
- Không xoá dòng; huỷ = đổi status (`ON DELETE RESTRICT`, migrations:6-8).

---

## 4. Workspace & perspective map

| Job | Surface tự nhiên | Perspective | Named decision | Có? |
|---|---|---|---|---|
| J1-J3 đặt lịch | Luồng bước | Object+Temporal | "giờ nào, ai" | ✅ |
| J4 huỷ | List lịch mình | Object | "còn kịp?" | ✅ |
| J5 walk-in | **Timeline** (thấy ai rảnh) | Now | "KTV nào rảnh" | ⚠️ sai chỗ (ở /reassign) |
| J6 đổi trạng thái | Timeline (trên block) | Operational | "bắt đầu/xong" | ✅ |
| **J7 ghi KTV nghỉ** | **Timeline** (trên cột KTV) | Exception | "nghỉ từ mấy giờ" | ❌ **không có → bẫy** |
| J8 cứu lịch mồ côi | Hàng chờ | Exception | "chuyển ai" | ✅ (chỉ vào bằng URL) |
| J9-J11 cấu hình | Form+list | Managerial-config | "ai/giá/ca" | ✅ |
| J12 ghép combo | Trên appointment | Operational | "thêm DV nào" | ❌ vô hình |
| C1-C3 đo hiệu quả | **Dashboard** | Managerial-measure | "tuyển/giá/cọc" | ❌ ABSENT |
| C4 đổi giờ | List lịch (trên lịch đó) | Object | "dời giờ nào" | ❌ |

---

## 5. Workspace interaction audit

11 lớp coverage cho 3 primary workspace. `—` = không áp dụng.

### 5a. Timeline lễ tân (`/admin/timeline`) — workspace vận hành chính

| Lớp | Đánh giá | Evidence |
|---|---|---|
| Entry | Vào từ /admin; xem lịch hiển nhiên | browser |
| Empty space | Ô trống KTV×giờ **không tạo booking** | browser: cell không click |
| Existing object | Bấm block → sheet đổi trạng thái. TỐT | `TimelinePage:294-319` |
| Create | **Không tạo walk-in được từ đây** dù đây là nơi thấy ai rảnh | browser: 0 FAB |
| Revise | Đổi trạng thái inline; **không kéo/dời lịch** | không drag |
| Perspectives | Chỉ DAY; không week/month | `admin-schedule.ts` chỉ ?date= |
| Relationships | KTV×lịch; buffer dải mờ. TỐT | browser (legend "Thời gian dọn dẹp") |
| Constraints | Nút status disable theo trạng thái. TỐT | `TimelinePage:410,419` |
| Repeated work | Không bulk | — |
| Exceptions | Banner reassign hiện; **nút "Xử lý ngay" chỉ `window.scrollTo`, KHÔNG điều hướng** (code tự nhận placeholder) | `TimelinePage:203-207` |
| Measurement | **0 con số** (số lịch, lấp đầy hôm nay) | `admin-schedule.ts` trả raw list |

### 5b. Hàng chờ xếp lại (`/admin/reassign`) — workspace exception

| Lớp | Đánh giá | Evidence |
|---|---|---|
| Entry | **Chỉ vào bằng URL / thẻ /admin**; banner timeline không dẫn tới | browser: 0 nav |
| Existing object | Gọi/chuyển/huỷ inline. TỐT | `ReassignQueuePage:96-120` |
| Create | Walk-in FAB nằm ở ĐÂY (sai chỗ) — và **không hỏi chọn KTV nào** | browser + `WalkInFab` |
| Revise | Chuyển KTV inline. TỐT | `ReassignSheet` |
| Constraints | Ứng viên không đủ ĐK hiện lý do. TỐT | `admin-reassign.ts` candidates |
| Exceptions | Không ai nhận → Notice + tel: khách. TỐT | `ReassignSheet:123-136` |
| Measurement | Không đếm "còn bao nhiêu chờ" | — |

### 5c. Thiết lập (`/admin/setup`) — workspace config

| Lớp | Đánh giá | Evidence |
|---|---|---|
| Entry | Từ /admin; 3 tab rõ | browser |
| Create | Form inline mỗi tab. TỐT | Staff/Services/ShiftsTab |
| Existing object | Bấm → sheet sửa. TỐT | các Tab |
| Revise | Toggle active, sửa inline | `admin-crud.ts` |
| Relationships | staff↔skill checkbox **không bền qua reload** (modal tự nhận "hệ thống hiện không lưu trạng thái này để hiển thị lại") | browser + `StaffTab:278-282` |
| **Constraints** | **"Cho ngưng làm" KHÔNG cảnh báo dù KTV đang có lịch** → bẫy im lặng | **con-mắt-không-code** |
| Repeated work | Đặt ca từng dòng; không copy tuần/KTV | ShiftsTab |

### Counterfactual + nearest-wrong-action test (con-mắt-không-biết-code)

| Job | Counterfactual | Nearest-wrong-action khi kẹt | Hậu quả |
|---|---|---|---|
| J1-J3 đặt | **PASS** (tự đặt xong, mã 1085) | — | — |
| J4 huỷ | **PASS** (tra SĐT, huỷ inline; <2h chuyển hotline lịch sự) | — | — |
| **J7 KTV nghỉ** | **FAIL** — không có nút báo nghỉ | Bấm **"Cho ngưng làm"** (Setup→NV) — gần nghĩa nhất | 🔴 **SILENT SIDE-EFFECT: cột KTV + lịch khách biến mất khỏi timeline, KHÔNG cảnh báo, reassign queue vẫn rỗng. Khách bị bỏ rơi vô hình** |
| J5 walk-in | **FAIL structural** — timeline không có nút | Phải rời timeline → /admin → /reassign mới thấy FAB | Mất context, 2+ hop |
| C4 đổi giờ | **FAIL** — chỉ có nút Huỷ | Khách tự huỷ rồi đặt lại | Mất slot giữa chừng, có thể bị cướp |
| C1 doanh thu | **FAIL** — không surface nào | — | Không quyết định được |
| Nav admin | **FAIL** — 3 trang làm việc 0 link | Gõ URL / browser back | — |

**Kết luận phương pháp:** bẫy J7 chỉ lộ ra vì chạy bằng con-mắt-không-biết-code. Người xây tránh nút "Cho ngưng làm" theo bản năng nên bản audit trước xếp J7 là "P1, fix rẻ" mà **bỏ sót hoàn toàn khía cạnh silent side-effect P0**.

---

## 6. Job × Capability Matrix

0 ABSENT · 1 TECHNICAL ONLY · 2 THIN UI · 3 USABLE · 4 OPERATIONAL.

| Job | Understand | Act | Revise | Prevent | Recover | Measure |
|---|---|---|---|---|---|---|
| J1 chọn DV/gói | 4 | 4 | 4 | 4 | — | — |
| J2 tìm giờ+KTV | 4 | 4 | 4 | 4 | 4 | — |
| J3 xác nhận đặt | 4 | 4 | 3 | 4 | 4 | — |
| J4 khách huỷ | 4 | 4 | 3 | 4 | 4 | — |
| J5 walk-in | 3 | 3 | 2 | 4 | 3 | — |
| J6 đổi trạng thái | 4 | 4 | 3 | 4 | 3 | — |
| **J7 ghi KTV nghỉ** | 2 | **0** | — | **0 🔴** | — | — |
| J8 cứu lịch mồ côi | 3 | 3 | 3 | 4 | 3 | 1 |
| J9 thêm NV+skill | 3 | 3 | 2 | 3 | 3 | — |
| J10 DV+gói | 3 | 3 | 2 | 2 | 3 | — |
| J11 đặt ca | 3 | 3 | 2 | 3 | 3 | — |
| **J12 ghép combo** | **1** | **0** | 0 | — | — | — |
| **C1 doanh thu** | **0** | 0 | — | — | — | **0** |
| **C2 lấp đầy KTV** | **0** | — | — | — | — | **0** |
| **C3 no_show** | **1** | 0 | — | — | — | **0** |
| **C4 đổi giờ** | 2 | **0** | 0 | — | — | — |

Chú ý (không trung bình hoá che ô 0):
- **J7 Prevent=0 🔴**: không nút báo nghỉ + nút thay-thế ("ngưng làm") không cảnh báo → không phòng được lỗi mất khách. Đây là ô nâng J7 lên P0.
- **J12 = vô hình**: `admin-appointment-items.ts` có + test 9 ca, UI không gọi.
- **C1/C2 = 0 toàn dòng**: 0 aggregate.

---

## 7. Principle findings

**Object-first:** Khách tốt. Admin lệch — timeline là object đúng nhưng hành động thuộc về nó (báo nghỉ, walk-in) không nằm trên nó; ngược lại hành động KHÔNG thuộc về "quản lý nhân viên" (báo nghỉ 1 hôm) lại bị nhét vào đó dưới dạng "ngưng làm" gây hại.

**Direct manipulation:** Mạnh (status/huỷ/CRUD inline). Lỗ: khách không đổi giờ (huỷ-tạo-lại); timeline không kéo/dời.

**Progressive disclosure:** Ổn, nhưng daily action giấu sai chỗ (walk-in ở /reassign; "Xử lý ngay" chỉ scroll).

**Plain domain language:** Tốt phía khách (tôi thấy "Spa sắp xếp", không lộ ID ở luồng đặt). Rò rỉ còn: fallback `Kỹ thuật viên #{staffId}` (`BookingPage:471`); `err.message` thô 3 sheet admin (`ReassignQueuePage:56`, `ReassignSheet:73`, `WalkInSheet:135`).

**Domain specialization:** Timeline đúng hình dạng scheduling. Thiếu lớp metric-gắn-quyết-định; chủ spa không thấy app hiểu kinh doanh.

**Calm technology:** Điềm tĩnh, nhưng nghịch lý: trạng thái đáng-thấy-ngay (KTV nghỉ hôm nay, lịch bị bỏ rơi, doanh thu ngày) lại không có surface — calm thành ra mù.

---

## 8. Complete ranked product-gap backlog

Severity tách khỏi delivery ease.

| ID | Type | Priority | Ease | Confidence | Actor/Job | Evidence | Consequence | Screen-level implication |
|---|---|---|---|---|---|---|---|---|
| **G0** | **Silent side-effect** | **P0** | Vừa | **Rất cao (no-code repro)** | Lễ tân/J7 | "Cho ngưng làm" giấu cột+lịch khỏi timeline, không cảnh báo, queue rỗng; gốc `active=0` lọc mọi query (`availability.ts:75-76`) | **Khách đã trả tiền bị bỏ rơi âm thầm, không ai thấy** | Setup NV: khi "ngưng làm" KTV đang có lịch → chặn/cảnh báo "N lịch sắp tới sẽ mất người làm" + đề nghị chuyển sang "báo nghỉ". States: modal confirm liệt kê lịch ảnh hưởng |
| G1 | Invisible capability | **P1** | Dễ (BE sẵn) | Cao (grep+browser) | Lễ tân/J7 | `admin-timeoff.ts:40` có API+test, UI 0 gọi; **PRD:13 nói MVP xong** | Sự cố thường nhật nhất không xử lý được; loop reassign chết | Timeline: bấm đầu cột KTV → "Báo nghỉ" → chọn khoảng giờ. Hiện affected_items ngay |
| G2 | Management gap | **P1** | Khó (cần BE mới) | Cao (grep) | Chủ spa/C1-C3 | 0 aggregate; price/no_show data-only | Không ra quyết định kinh doanh nào | /admin/overview mới. 3 số gắn 3 quyết định. day/week/month |
| G3 | Misplaced action | **P1** | Dễ | Cao (browser) | Lễ tân/J5 | FAB chỉ ở /reassign; timeline 0 FAB; walk-in không hỏi chọn KTV | Hành động hằng ngày không ở nơi làm việc | Timeline: FAB walk-in, prefill slot/KTV đang xem |
| G4 | Attention/Nav gap | **P1** | Dễ | Cao (no-code) | Mọi việc | 3 trang admin 0 link điều hướng; "Xử lý ngay" chỉ scroll | Kẹt trong 1 trang, phải gõ URL/back | Header/nav chung mọi trang admin; sửa CTA "Xử lý ngay" điều hướng thật |
| G5 | Revision gap | **P1** | Vừa | Cao (browser+copy) | Khách/C4 | LookupPage chỉ huỷ; **copy hứa "đổi lịch" nhưng chỉ có nút Huỷ + gọi điện** | Khách dời lịch phải huỷ→mất slot→tranh lại | /lookup: nút "Đổi giờ" cạnh Huỷ (khi >2h) → mở lại grid; đổi nguyên tử |
| G6 | Invisible capability | **P2** | Vừa (BE sẵn) | Cao (grep) | Lễ tân/J12 combo | `admin-appointment-items.ts` có+test 9 ca, UI 0 gọi | Không bán được combo tại quầy dù engine sẵn | Trên sheet 1 appointment: "+ Thêm dịch vụ", chặn trùng body_zone |
| G7 | Vocabulary gap | **P2** | Dễ | Cao | Khách+lễ tân | `#{staffId}` fallback `BookingPage:471`; `err.message` 3 chỗ | Bối rối ID; câu lỗi kỹ thuật | Đổi ID→tên; map message theo code |
| G8 | Constraint invisibility | **P2** | Dễ | Cao | Chủ spa/J10 | Xoá skill đang dùng báo SAU khi bấm | Thử rồi mới biết không được | Setup: disable/tooltip "đang dùng bởi N dịch vụ" |
| G9 | Relationship opacity | **P2** | Vừa | Cao (no-code xác nhận) | Chủ spa/J9 | staff↔skill checkbox không bền qua reload (modal tự thú) | Không nắm ai có skill gì | Hiện skill-chip ngay trên dòng staff; persist |
| G10 | Repeated-work gap | **P2** | Vừa | Cao | Chủ spa/J11 | Đặt ca từng dòng (5 KTV×7 ngày=35 lần) | Setup ban đầu cực nhọc | "Áp ca cho cả tuần / KTV khác" |
| G11 | Exception gap | **P3** | Dễ | Cao | Mọi actor | Không route 404 (`main.tsx:21-29`) | Gõ nhầm URL → trang trắng | Catch-all → trang "không tìm thấy" + link về |
| G12 | Missing perspective | **P3** | Vừa | Vừa | Lễ tân | Timeline chỉ DAY | Xếp lịch tuần khó nhìn | Chế độ week (gắn "cân tải tuần") |

Mô tả sai kèm G3: thẻ `/admin` ghi timeline "…nhận khách vãng lai" (`AdminPage.tsx`) nhưng walk-in không ở timeline.

**Điều app làm ĐÚNG (ghi để cân bằng):** đặt-lịch end-to-end mượt; <2h chuyển hotline không lộ mã lỗi; SLOT_TAKEN race tự làm mới; reassign một-luật-một-chỗ; buffer hiện trực quan; ~330 test D1 thật xanh.

---

## 9. Coherent target experiences (tối đa 3)

### Đề xuất A — "Báo KTV nghỉ" trên Timeline + bịt bẫy "ngưng làm" (giải G0 + G1, kéo G3/G4)

```
Actor: lễ tân · Trigger: một KTV gọi báo ốm
→ entry: /admin/timeline (đang xem lịch)
→ thấy: cột KTV đó + lịch trong ngày
→ decision: nghỉ từ mấy giờ tới mấy giờ
→ action: bấm đầu cột KTV → "Báo nghỉ" → chọn khoảng giờ → xác nhận
→ feedback: hiện ngay affected_items + vào hàng chờ; banner "Xử lý ngay" ĐIỀU HƯỚNG THẬT
→ đồng thời: ở Setup, "Cho ngưng làm" KTV đang có lịch → CHẶN kèm cảnh báo, gợi ý dùng "Báo nghỉ"
→ constraint giữ: time-off không từ chối; item giữ status/staff (PRD §8)
→ exception: không lịch bị ảnh hưởng → "đã ghi nghỉ, không có lịch bị ảnh hưởng"
→ result: xử lý sự cố mà không rời timeline, không rơi vào bẫy mất khách
```
- Backend: `POST /api/admin/time-off` đủ (trả `affected_items`); bẫy cần thêm guard UI ở Setup.
- Acceptance: "Báo Lan nghỉ 14:00–19:00 → 2 lịch vào hàng chờ → banner dẫn sang xử lý → chuyển 1, gọi khách 1." + "Bấm 'ngưng làm' Lan khi còn lịch → bị chặn, hiện danh sách lịch, gợi ý báo nghỉ."
- Out of scope: nghỉ phép cố định hàng tuần (C8), thông báo tự động.

### Đề xuất B — Bảng tổng quan chủ spa (giải G2)

```
Actor: chủ spa · Trigger: cuối ngày/tuần muốn biết làm ăn
→ entry: /admin → thẻ "Tổng quan"
→ thấy 3 số GẮN QUYẾT ĐỊNH:
   • Doanh thu (price của item done) → giá/khuyến mãi
   • Lấp đầy theo KTV (giờ đặt / giờ ca) → tuyển/xếp ca
   • no_show + SĐT lặp → đặt cọc/chặn số
→ backend cần: 1-3 endpoint aggregate (CHƯA có)
```
- Metric là HYPOTHESIS — chủ spa xác nhận câu hỏi kinh doanh trước khi build.
- Rules: chỉ tính `done` cho doanh thu; `no_show` không tính doanh thu.

### Đề xuất C — Đổi giờ tự phục vụ cho khách (giải G5)

```
Actor: khách · Trigger: bận đột xuất, muốn dời (>2h)
→ entry: /lookup, trên lịch đang xem
→ thấy nút "Đổi giờ" cạnh "Huỷ"
→ action: mở lại grid đúng DV → chọn giờ mới → xác nhận
→ constraint: đổi = huỷ cũ + đặt mới NGUYÊN TỬ; giữ cutoff 2h
→ exception: slot mới vừa bị cướp → báo nhẹ, chọn lại
```
- Backend cần: endpoint reschedule nguyên tử (CHƯA có; ghép cancel+book có race).

---

## 10. Recommendation

**Làm Đề xuất A trước — và lần này vì SEVERITY, không chỉ delivery order.**

Khác bản cũ: G0 là **P0 silent side-effect** (mất khách âm thầm) — playbook nói loại này nâng lên P0 dù trông "nhỏ", vì người dùng *tưởng đã làm đúng*. A vừa bịt bẫy P0 (G0) vừa hoàn thiện loop vận hành đã đầu tư (G1 + reassign build kỹ nhưng chết vì thiếu trigger). Delivery ease cao, evidence rất cao (repro được bằng no-code).

Nhóm P1 (G1-G5) cùng mức severity; trong đó A gánh luôn G1. Sau A, nếu mục tiêu "cho chủ spa thấy app đáng tiền" thì B là giá trị kinh doanh mới lớn nhất nhưng đắt (cần BE + bạn định nghĩa metric). C tốt cho khách nhưng không chặn vận hành.

Trade-off chọn A: khôi phục + bảo vệ vận hành, chưa tạo giá trị kinh doanh mới. Nếu ưu tiên giá trị mới, đảo sang B — nhưng **G0 nên fix trước bất kể roadmap** vì nó là mất-mát-ẩn.

---

## 11. Decisions required from product owner

1. **G0 (bẫy "ngưng làm"):** chọn cách bịt — (a) chặn cứng khi KTV còn lịch, (b) cảnh báo + cho tiếp, (c) biến "ngưng làm" thành "báo nghỉ hôm nay" luôn? (Khuyến nghị: chặn + gợi ý báo nghỉ.)
2. **Thứ tự sau A:** B (kinh doanh mới, đắt) hay C (trải nghiệm khách) trước?
3. **CANDIDATE nào vào scope v-tiếp?** C1-C3 đo lường, C4 đổi giờ, J12 combo (BE sẵn), C7 khách quen.
4. **Nếu làm B — 3 metric nào?** Doanh thu/lấp đầy/no_show là đề xuất; mỗi cái gắn 1 quyết định thật. Xác nhận/đổi?
5. **Tách actor lễ tân vs chủ spa?** Hiện chung admin không auth. Lễ tân có nên thấy doanh thu không?
6. **Nghỉ cố định (C8) vs đột xuất:** có làm lịch nghỉ lặp hàng tuần, hay đột xuất là đủ?

---

## 12. Design handoff boundary

Audit này đã tới: structural UX findings, interaction direction, target experience end-to-end, screen-level implication (mục 8), states + acceptance (mục 9).

Audit **cố ý chưa** làm: visual hierarchy chi tiết, wireframe có kích thước, responsive, component spec, typography/color/token — thuộc bước **Interaction/UX Specification** sau khi bạn chọn target (mục 11). App đã có design system tím + component base, spec đó tái dùng.

**Giới hạn bias đã xử lý:** các job P0/P1 đã kiểm bằng con-mắt-không-biết-code (agent không đọc source, chỉ thao tác app) — nhờ đó bắt được G0 mà người-xây bỏ sót. Chưa có quyết định của bạn thì chưa sửa code.
