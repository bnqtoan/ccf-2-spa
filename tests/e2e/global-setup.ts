import { execFileSync } from 'node:child_process'

/**
 * Dọn D1 local về trạng thái seed sạch TRƯỚC mỗi lần chạy E2E.
 *
 * Vì sao cần: mỗi spec tự tạo fixture riêng (skill/staff/service/variant) và
 * không xoá sau khi xong — đúng chủ ý, vì nhiều spec chạy song song trên cùng
 * một D1 và xoá của nhau sẽ gây đỏ ngẫu nhiên. Nhưng hệ quả là dữ liệu tích
 * luỹ: một lần chạy đầy đủ đẩy số KTV active từ 5 lên 38, và sau vài chục lần
 * chạy lên tới 132 KTV / 90 time-off / 174 booking sống.
 *
 * Hai thứ vỡ theo:
 *  - Hàng chờ reassign là TOÀN CỤC (suy ra từ time_off ∩ booking_items, không
 *    lọc theo ngày). Rác của spec này lọt vào khẳng định của spec kia.
 *  - Timeline render mọi KTV active, nên 132 cột làm mọi phép định vị theo toạ
 *    độ trở nên vô nghĩa.
 *
 * Triệu chứng đặc trưng: từng file chạy riêng thì xanh, chạy chung thì đỏ.
 * Dọn ở đây một lần cho cả lần chạy, thay vì bắt từng spec tự dọn — mỗi spec
 * chỉ biết dữ liệu của chính nó, không biết rác của spec khác.
 */
export default function globalSetup(): void {
  const wipe = [
    'booking_items',
    'appointments',
    'time_off',
    'customers',
    'work_shifts',
    'staff_skills',
    'service_variants',
    'services',
    'staff',
    'skills',
  ]
    .map((t) => `DELETE FROM ${t};`)
    .join(' ')

  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--command', wipe], {
    stdio: 'ignore',
  })
  execFileSync('npm', ['run', 'db:seed:local'], { stdio: 'ignore' })
}
