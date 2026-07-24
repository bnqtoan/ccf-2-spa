# Kết quả — PILOT thẩm định phương pháp audit "người lạ"

Mục tiêu của pilot này KHÔNG phải chạy đủ 10 job × N vòng, mà là **kiểm xem
phương pháp trong AUDIT-EXPERIMENT-HANDOFF.md có cho tín hiệu đáng tin không**
trước khi bỏ công chạy full. Chạy lát mỏng nhất mà vẫn động tới mọi bộ phận của
phương pháp: 1 worktree, app chạy + seed thật, 2 job tương phản (1 kỳ vọng PASS
làm control, 1 kỳ vọng FAIL), mỗi job 1 agent "người lạ" (Canary browser, không
đọc source).

Nhánh: `audit/pilot` (blind — không có `PRODUCT-AUDIT.md`). Không đụng main.
Ngày chạy: 2026-07-24. App: dev server local :5174, D1 local seed sạch.

---

## 1. Ma trận job × vòng (pilot = 1 vòng)

| # | Actor | Job | Kỳ vọng (handoff §5) | Kết quả thực | Khớp? |
|---|---|---|---|---|---|
| 1 | Khách | Đặt lịch massage chiều mai | PASS | **SUCCEEDED** | ✅ |
| 5 | Lễ tân | KTV Lan báo ốm — xử lý lịch bị ảnh hưởng | FAIL (không có nút báo nghỉ) | **STUCK** — đúng chỗ + tệ hơn dự đoán | ✅ (và hơn) |

**Phương pháp phân biệt được flow chạy được với flow gãy** — đây là điều kiện
sống-còn của một phương pháp audit. Nếu cả 2 cùng PASS hoặc cùng FAIL thì phương
pháp vô dụng; ở đây control PASS, ca thử FAIL đúng chỗ.

---

## 2. Job 1 (control) — SUCCEEDED

Khách lạ đặt được Massage 60' chiều mai (T7 25/07, 14:00), tự đi một mạch từ
trang chủ → chọn dịch vụ → gói → ngày → giờ → nhập tên/SĐT → xác nhận. Không
phải đoán URL, không back trình duyệt.

Bonus (con-mắt-không-biết bắt được friction dù JOB vẫn PASS):
- "🗓️ Ngày này đã kín lịch" hiện ngay khi mặc định là HÔM NAY → dễ tưởng cả spa
  hết chỗ. (mặc định nên là ngày còn slot, hoặc đổi câu chữ)
- Màn cuối "MÃ ĐẶT LỊCH · 3" — số 3 trông như ID nội bộ, khách không biết dùng
  làm gì.

→ Control hợp lệ: phương pháp KHÔNG phải cỗ máy kêu-FAIL-mọi-thứ.

---

## 3. Job 5 (ca thử) — STUCK, và tệ hơn audit sơ bộ dự đoán

Lễ tân lạ KHÔNG hoàn thành được "báo Lan nghỉ + xếp lại khách". Chuỗi tắc:

1. Mở app ra trang KHÁCH, không có link vào khu quản lý → phải **tự đoán gõ
   `/admin`** (structural gap: dấu hiệu "phải đoán route").
2. Bấm tên "Lan" ở timeline → không làm gì.
3. Bảng chi tiết lịch chỉ có "Bắt đầu làm / Hoàn thành / Khách không đến" —
   **không có đổi KTV, không có báo nghỉ**.
4. "Hàng chờ xếp lại" ghi đúng việc ("lịch bị ảnh hưởng khi KTV nghỉ đột xuất")
   nhưng **trống trơn** và không có nút để báo nghỉ → nó chỉ là màn hiển thị
   HẬU-KỲ, không có đường vào.
5. Thứ gần nhất: "Cho ngưng làm" trong Thiết lập > Nhân viên — **câu chữ mơ hồ**
   (nghe như nghỉ việc hẳn, không phải nghỉ ốm 1 hôm).

**Gap MỚI, nghiêm trọng — audit sơ bộ (§5) không ghi:** khi lễ tân dùng động
tác gần nhất ("Cho ngưng làm" Lan), lịch của "Khach Seed 1" **biến mất khỏi
timeline chứ KHÔNG vào hàng chờ xếp lại** — không thành "cần xếp lại", không báo
ai. Khách bị *giấu mất* đúng nghĩa "bị bỏ rơi". Agent xác nhận lại bằng cách
"Kích hoạt lại" Lan → lịch hiện lại, chứng minh là bị GIẤU chứ không xoá.

→ Đây chính là giá trị con-mắt-không-biết-code: người xây sẽ không bao giờ bấm
"Cho ngưng làm" để báo ốm (họ biết đó là nút sai), nên không thấy cái bẫy
mất-dữ-liệu-thị-giác này. Người lạ đi thẳng vào nó.

Đối chiếu backend: API `POST /api/admin/time-off` (báo nghỉ) và
`POST /api/admin/bookings/:id/reassign` (xếp lại) ĐỀU TỒN TẠI. Xác nhận đúng
giả thuyết trung tâm: **backend đủ, UI không cho người dùng với tới.**

---

## 4. Phương pháp có chạy không? (retro — đây là đầu ra chính của pilot)

| Câu hỏi kiểm phương pháp | Trả lời |
|---|---|
| App boot + seed được không? (điểm gãy #1 của cả thí nghiệm) | ✅ `npm ci`+migrate+seed+dev :5174 sạch một lần |
| Agent có giữ "mù" (không đọc source) không? | ✅ Canary automate-agent chỉ có Read/Bash/browser; cả 2 thuật lại thuần thao tác UI, không trích code |
| Phương pháp phân biệt PASS vs FAIL không? | ✅ control PASS, ca thử FAIL đúng chỗ |
| Verdict rõ để tổng hợp không? | ✅ ép format "VERDICT: SUCCEEDED / STUCK — <chỗ>" → điền ma trận §1 thẳng |
| Con-mắt-không-biết bắt gap MỚI ngoài audit sơ bộ không? | ✅ bẫy "giấu lịch khi ngưng KTV" — giá trị lõi của thí nghiệm |
| Chi phí / job | Job1 ~21k tok, ~2ph, 8 tool-use · Job5 ~30k tok, ~3ph, 12 tool-use |
| Dữ liệu tình huống có sẵn không? | ✅ seed đã có Lan booked "Khach Seed 1" hôm nay → Job5 có khách thật để xử lý, không cần seed thêm |

**Kết luận: phương pháp CHẠY.** Đáng scale lên full 10-job × N-vòng.

---

## 5. Điều chỉnh cho lần chạy full (rút từ pilot)

1. **Nhiều vòng để đo LẶP LẠI, không phải nhiều job/1 vòng.** Pilot 1 vòng đã
   khớp dự đoán; giá trị "gap thật vs agent đọc lệch" chỉ hiện khi chạy cùng job
   qua ≥3 vòng độc lập (handoff §6). Ưu tiên độ sâu (nhiều vòng) hơn độ rộng.
2. **Parallel qua cmux worktree khác port** (5174/5175/5176) — pilot chạy tuần
   tự trên 1 server để lấy control sạch; full nên song song để nhanh. Mỗi
   worktree D1 riêng nên không đụng dữ liệu.
3. **Giữ ép-format verdict** — "VERDICT: …" ở dòng đầu giúp tổng hợp ma trận
   không phải đọc lại cả narrative.
4. **Seed đã đủ tình huống cho Job 5** (Lan có khách hôm nay). Với Job 2/3
   (khách huỷ/đổi giờ) cần seed booking >2h của khách có SĐT — chuẩn bị trước.
5. **Ghi cả friction ở job PASS** (như "kín lịch"/"MÃ · 3" ở Job 1) — không chỉ
   PASS/FAIL. Đó là tín hiệu UX phụ, miễn phí, đáng giữ.

---

## 6. Ranh giới đã tuân (§7)

- Không merge/push `audit/pilot` về main. Không deploy. Không sửa app để vá gap.
- Agent không đọc source. main giữ nguyên `c31f54f`.
