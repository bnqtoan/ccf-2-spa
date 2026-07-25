# Phân tích nhóm yêu cầu tính năng — ccf-2-spa

> Nguồn: 6 yêu cầu thô từ product owner, phân tích theo phương pháp
> "job đằng sau yêu cầu bề mặt" + map vào domain (dựa trên APP-MAP.md &
> PRODUCT-AUDIT.md). Ngày: 2026-07-24.
> **Trạng thái: PHÂN TÍCH, CHƯA CODE.** File này để gộp với nhóm yêu cầu
> khác ở session sau rồi mới quyết plan.

## Quyết định của product owner (đã chốt trong session này)

- **Hướng app:** làm feature vận hành trước, **gác subscribe** (chưa quyết
  bán SaaS hay 1 spa dùng riêng).
- **Combo dịch vụ:** làm **cả hai** kiểu — nối tiếp 1 KTV VÀ song song nhiều
  KTV, khách chọn (bản đầy đủ, nặng nhất).

---

## 0. Bối cảnh app (1 dòng)

Hệ đặt lịch spa 2 mặt: khách tự đặt/huỷ, lễ tân điều phối. Core chắc (1 module
validate dùng chung, chống race bằng SQL guard). **Lỗ hổng lớn nhất theo audit:
lớp ĐO LƯỜNG (doanh thu/lấp đầy/no-show) hoàn toàn vắng, và KHÔNG có kênh
thông báo nào.** Stack: React 19 + Hono/CF Worker + D1. Không auth, single-tenant.

---

## 1. Yêu cầu bề mặt → job thật đằng sau

| # | Yêu cầu thô | Job thật (đằng sau) | Đây thực chất là gì |
|---|-------------|---------------------|---------------------|
| R1 | Cho chọn nhiều dịch vụ cùng lúc | Khách làm **combo nhiều dịch vụ trong 1 buổi** | Mở rộng booking — data model đã sẵn (`booking_items` số nhiều, F8 ghép combo đã có ở admin) |
| R2 | Tính lương NV theo ngày/tuần/tháng, tính thuế shop | Chủ **biết mỗi KTV làm ra bao nhiêu tiền/công** để trả lương & khai thuế | Lớp measurement C1/C2 (ABSENT) |
| R3 | Subscribe + free trial 2 tuần | **Product owner (vendor)** muốn thu tiền từ chính app | Vendor-layer — ĐỔI BẢN CHẤT app (single→multi-tenant SaaS). Ngoài domain spa |
| R4 | Đánh giá dịch vụ, báo cáo doanh thu, báo cáo đánh giá KTV | Chủ **biết KTV nào tốt/tệ** (qua tiền + qua sao) để thưởng/phạt | C1 (tiền) + C3 (rating — data mới) |
| R5 | Màn quản lý: ô vuông theo khung giờ, xanh=có khách/xám=trống, "giống máy tính bấm tay" | Chủ/quản lý **liếc 1 phát biết ai bận/rảnh + lấp đầy bao nhiêu** | C2 occupancy — chính "measurement" mà timeline đang thiếu |
| R6 | Thông báo qua Telegram | **Kênh chạm** app đang thiếu hoàn toàn: nhắc khách, báo lễ tân, gửi link đánh giá | Hạ tầng notification — ENABLER cho nhiều feature khác |

**Nhận định lõi:** R2, R4, R5 cùng rơi vào **một lỗ hổng: lớp đo lường vắng
mặt**. Data đã nằm sẵn trong DB (`price` mọi variant, `no_show` đã ghi,
`booking_items.staff_id`), chỉ **chưa cộng lại + surface ra UI** → vừa dễ vừa
giá trị cao. R1 mở rộng luồng đã có. R6 là hạ tầng dùng chung. **R3 lạc loài** —
phục vụ vendor, không phục vụ spa.

---

## 2. Map vào domain + data đã có sẵn chưa

| # | Domain trong app | API/UI hiện có liên quan | Data đã có? | Cần thêm data model? |
|---|------------------|--------------------------|-------------|----------------------|
| R1 | Booking (J1/J3) | F8 `POST /appointments/:id/items` (admin combo) đã có; `booking_items` số nhiều; validate chống 2 item cùng `body_zone` đè nhau | ✅ | Không (chỉ mở UI khách + logic slot combo) |
| R2 | Measurement C1/C2 | KHÔNG có endpoint aggregate (`grep SUM/GROUP BY/revenue` = rỗng) | ✅ `price`×`staff_id`×`status=done` | Thêm `commission_rate` cho staff; `tax_rate` cho shop (nhỏ) |
| R3 | Vendor-layer | KHÔNG có — app không auth, mọi route mở (`PRD.md:8-9`) | ❌ | **Nặng:** tenant, auth, billing, feature-gate, trial-counter |
| R4 | C1 (tiền) + C3 (rating) | Tiền: như R2. Rating: KHÔNG có gì | Tiền ✅ / Rating ❌ | **Rating cần bảng mới** `reviews(appointment_id, rating, comment, created_at)` + kênh thu thập |
| R5 | C2 occupancy | `GET /api/admin/schedule?date=` trả list booking + đọc shift | ✅ (booking ∩ shift) | Không (chỉ 1 query gộp + UI grid) |
| R6 | Notification (mới) | KHÔNG có (PRD ghi notification = v2) | ❌ | Cần: token bot, `chat_id` per actor, hàng đợi/cron gửi, template |

---

## 3. Xếp hạng (độ dễ × giá trị) — chỉ nhóm feature spa (R1,R2,R4,R5,R6)

R3 tách riêng (mục 5).

### 🥇 Hạng 1 — R5 Lưới lấp đầy KTV ("máy tính bấm tay")
- **Dễ nhất:** backend `GET /api/admin/schedule?date=` đã trả booking+shift →
  chỉ cần 1 query gộp + render grid ô xanh/xám. Không form, không CRUD.
- **Giá trị cao:** audit mục 5a ghi rõ timeline "KHÔNG con số nào". Lấp đúng đó.
- Trả lời cùng lúc: "KTV nào rảnh ngay" (J5 walk-in đang sai chỗ) + "lấp đầy %".
- **Đề xuất gộp:** biến thành *Dashboard quản lý* — lưới + dải KPI trên cùng
  (DT hôm nay · số lịch · % lấp đầy · no-show). KPI gần như free khi đã có lưới.
  Bấm 1 KTV → DT + công KTV đó (nền cho R2). → 1 màn nuốt gọn R5 + nửa R2 + nửa R4.

### 🥈 Hạng 2 — R1 Chọn nhiều dịch vụ (combo)
- `booking_items` đã số nhiều, F8 đã xử được nhiều item không đè `body_zone`.
- Việc chính: **mở UI khách** chọn nhiều variant + tính tổng thời lượng/giá.
- **Độ khó theo quyết định "cả hai":** đây là bản NẶNG NHẤT.
  - *Nối tiếp 1 KTV:* block = tổng thời lượng, KTV phải đủ mọi skill. Vừa.
  - *Song song nhiều KTV:* cần cấp phát nhiều KTV cùng khung, validate overlap
    chéo, hiển thị khách "được làm bởi ai/lúc nào". Phức tạp đáng kể.
  - *Khách chọn kiểu:* thêm UI quyết định + 2 nhánh validate.
- **Rủi ro:** logic availability cho combo song song là phần khó nhất toàn nhóm.
  Nên tách slice: (a) nối tiếp 1 KTV trước → (b) song song sau.

### 🥉 Hạng 3 — R2 Báo cáo doanh thu + lương KTV + thuế
- 1 endpoint aggregate mới: `SUM(price) GROUP BY staff, day/week/month WHERE status=done`.
- Lương = DT KTV × `commission_rate` (thêm 1 field staff). Thuế = tổng DT × `tax_rate`.
- Công vừa; giá trị cao nhất về lâu dài. Ăn theo dashboard ở R5.

### Hạng 4 — R4 Đánh giá bằng sao (phần rating)
- Cần **bảng mới** `reviews` + **kênh thu thập** (gửi link sau khi `done`).
- Kênh thu thập chính là R6 (Telegram) → R4-rating PHỤ THUỘC R6.
- Phần "báo cáo doanh thu / đánh giá KTV bằng tiền" của R4 = trùng R2, làm cùng.

### Hạng — R6 Telegram (ENABLER, xếp riêng)
- Không phải feature đơn lẻ mà **hạ tầng** nhiều thứ ăn theo:
  - Nhắc khách trước giờ hẹn (giảm no-show — C5).
  - Báo lễ tân: booking mới / KTV nghỉ / có lịch mồ côi cần cứu.
  - Gửi link đánh giá sau `done` (kênh thu thập cho R4).
- **Làm 1 lần, nhiều feature dùng.** Nhưng cần chốt: gửi cho AI (bot→admin) hay
  gửi cho KHÁCH (khách phải có Telegram + đã /start bot — tỷ lệ phủ thấp ở VN,
  cân nhắc Zalo/SMS thay thế cho kênh tới khách).
- **Rủi ro nền:** app trên CF Worker → cần webhook/cron cho gửi theo lịch;
  lưu `chat_id`; giữ bot token (secret). Vừa phải, nhưng là hạ tầng thật.

---

## 4. Đề xuất "tốt hơn / liên quan" (audit đã chỉ, PO chưa nêu)

| Đề xuất | Vì sao đáng | Chi phí |
|---------|-------------|---------|
| **Báo nghỉ KTV từ UI** | Backend `POST /api/admin/time-off` ĐÃ có + test đầy đủ, nhưng `src/app` grep rỗng → không nút nào gọi. Thêm 1 nút = mở khoá cả luồng reassign đã build công phu. Lỗ hổng nặng nhất theo audit. | **Rẻ nhất.** Quick win |
| **Đổi giờ (reschedule)** | Khách hiện chỉ huỷ được; muốn dời phải huỷ + đặt lại (mất slot giữa chừng). Rất hay bị yêu cầu | Vừa |
| **Gộp R5+R2 thành 1 Dashboard** | Cùng trả lời "spa hôm nay/tuần này thế nào". Làm rời rạc lãng phí | Tiết kiệm |

---

## 5. R3 Subscribe — TÁCH RIÊNG, chưa làm

- App hiện **không auth, single-tenant** (mọi route mở). Subscribe đòi:
  (a) multi-tenant (mỗi spa 1 workspace) · (b) auth/login · (c) cổng thanh toán
  · (d) feature-gate theo gói + đếm ngày trial.
- Đây là **3-4 tuần nền tảng**, không phải 1 feature.
- **Chỉ đáng làm khi đã quyết bán app cho nhiều spa.** PO hiện "chưa chắc" → gác.
- Nếu sau này làm: đây là món ĐẦU TIÊN phải xong trước mọi feature vendor khác,
  vì nó định hình lại toàn bộ data model (thêm `tenant_id` mọi bảng).

---

## 6. Phụ thuộc giữa các yêu cầu (để xếp thứ tự khi gộp plan)

```
R6 Telegram (enabler)
   ├─> R4 rating (cần kênh gửi link đánh giá)
   └─> nhắc khách / báo lễ tân (giá trị phụ)

R5 Dashboard lưới ──┬─> nền UI cho R2 (KPI + DT theo KTV)
                    └─> nuốt nửa R4 (báo cáo DT/KTV bằng tiền)

R2 aggregate ───────> cần cho lương + thuế + báo cáo R4

R1 combo: độc lập, nhưng nên tách (a nối tiếp → b song song)

R3 subscribe: độc lập & gác; nếu làm phải làm TRƯỚC mọi vendor-feature
```

**Thứ tự đề xuất nếu làm tuần tự (nhóm spa):**
1. Báo nghỉ KTV từ UI (quick win, mở khoá reassign)
2. R5 Dashboard lưới lấp đầy + KPI
3. R2 aggregate DT/lương/thuế (ăn theo #2)
4. R1a combo nối tiếp 1 KTV → R1b song song
5. R6 Telegram (enabler) → R4 rating

---

## 7. Câu hỏi còn mở (cần PO trả lời khi gộp plan)

- R6: Telegram gửi cho **admin/lễ tân** (dễ, phủ 100%) hay cho **khách** (khách
  VN ít dùng Telegram — cân nhắc Zalo/SMS)? Quyết định này đổi hẳn giá trị R4.
- R2: "thuế shop" = chỉ tính tổng DT × thuế suất để tham khảo, hay cần xuất hoá
  đơn/khai báo thật? (nếu thật → nặng, cần chuẩn hoá đơn VN).
- R1: combo song song — 1 khách chiếm 2 KTV cùng lúc có cần 2 phòng/giường
  không? (đụng C9 "phòng như tài nguyên giới hạn" mà PRD đã hoãn).
- R4: rating có gắn định danh khách (SĐT) hay ẩn danh? Ảnh hưởng chống spam.
