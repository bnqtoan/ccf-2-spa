# Retro — the E2E "flake" saga (T-33→T-38) that shouldn't have happened

Ngày: 2026-07-30. Cho AI đọc. Bài học đắt nhất của phiên này.

## Chuyện gì đã xảy ra
Tony hỏi nhiều lần "app đơn giản mà, sao vật lộn vậy? / sao app khác cùng stack
mình không gặp?". Đúng. Một chuỗi 5 card (T-33 contention, T-34 fast-seed, T-35
clock-waits, T-37 busy-retry, T-38 single-writer) sinh ra để đuổi theo cái mình
GỌI là "SQLITE_BUSY / parallel test flake". Cuối cùng khi chạy E2E **tuần tự**
(workers:1) thì lộ ra: **36–37 pass, chỉ 1–2 test đỏ, và chúng đỏ TẤT ĐỊNH — không
liên quan gì parallel/SQLite.**

## Nguyên nhân THẬT (không phải cái mình đổ cho)
1. **`:576` stale** — chính thay đổi của mình (lọc KTV theo availability ở sheet đặt
   lịch) làm test cũ chọn một KTV giờ đã bị lọc ẩn → timeout. Lỗi của mình.
2. **Drag tests (`:630`, `:753`) hỏng trên main sạch** — Playwright `locator.dragTo()`
   KHÔNG mang `DataTransfer` qua native HTML5 DnD → `onDrop` đọc rỗng → sheet không
   hiện. Hạn chế của Playwright, KHÔNG phải lỗi app.
3. Vì spec để `mode:'serial'`, MỘT test đỏ **abort 7 test sau + cascade ~66 skipped**
   → cả suite đỏ → trông như "thảm hoạ concurrency".
4. SQLITE_BUSY CÓ thật nhưng chỉ là nhiễu PHỤ (hai miniflare/một file .wrangler),
   chồng lên hai lỗi thật ở trên làm mọi thứ trông giống vấn đề song song.

## Vì sao app khác của Tony không gặp (câu hỏi của Tony)
Không phải may. **Stack ổn, parallel ổn.** App khác có test PASS ĐÁNG TIN nên chạy
song song bình thường. Repo NÀY tích luỹ vài test hỏng/stale (phần lớn do mình hoặc
agent trước viết), và mình **đọc sai** lỗi của chúng thành "vấn đề parallel/SQLite".
Toàn bộ cơn đau là test hỏng + mình chẩn-đoán-sai, KHÔNG phải hạ tầng.

## Lỗi quy trình của mình (đắt nhất)
- **Tuyên bố "solved" quá sớm 2 lần** (T-34, T-35 bảo đã hết contention). Chưa hề.
  Mỗi lần "xong" sai làm chuỗi dài thêm và bào mòn niềm tin.
- **Đổ cho hạ tầng thay vì đọc lỗi test thật.** Đáng lẽ chạy serial NGAY từ đầu để
  tách "flake do song song" khỏi "test đỏ tất định" — 1 phút là biết. Mình vòng vo
  5 card mới làm điều đó.
- **Over-engineer quy trình cho app CRUD nhỏ** — worktree + subagent + 3×-verify cho
  mỗi sửa 2 dòng. Ceremony nặng hơn cả việc.
- **Bắt Tony ngồi xem mình sửa chính mình** thay vì xây app.

## Điều ĐÚNG (giữ)
- Feature nào cũng chạy ổn: KTV auto-filter, timeline create/reschedule/week, shifts
  week-editor, AdminShell. Feature CHƯA BAO GIỜ là chỗ vật lộn.
- "Verify bằng tay, đừng tin 'pre-existing'" bắt được hook-crash mình tự gây (T-29).
- Tony đẩy đúng ("sao không chạy serial?") → lộ root cause ngay.

## Cách sửa quy trình (đã áp)
1. **E2E chạy serial (workers:1)** — một dòng config, khử luôn khả năng đổ-cho-song-song.
   App nhỏ chạy solo, CI vài phút là ổn. Xoá hết busy-retry/multi-project phức tạp.
2. **Test đỏ → chạy serial trước để phân loại** (flake-song-song vs bug-tất-định)
   TRƯỚC khi viết bất kỳ card "fix contention" nào.
3. **Đừng nói "solved/works" khi chưa tự chạy tận mắt.** Track record phiên này về
   "it works" rất tệ — Tony toàn tìm ra lỗi sau đó.
4. **Sửa nhỏ → làm in-session, không worktree/subagent.** Để dành ceremony cho việc
   lớn thật sự nhiều-file-song-song.
5. Card đã xoá: T-33, T-37, T-38 (đuổi theo ghost). T-34/T-35 giữ (fast-seed +
   clock-inject có giá trị thật), nhưng đánh dấu: chúng KHÔNG "giải quyết contention"
   như từng tuyên bố — serial mới là cái đóng.

## Một dòng
App đơn giản. Cơn đau 90% là test hỏng + mình chẩn-đoán-sai + over-engineer, KHÔNG
phải stack. Serial-hoá E2E + đọc-lỗi-thật là đủ; 5 card contention là thừa.
