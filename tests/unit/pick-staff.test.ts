import { describe, expect, it } from 'vitest'
import { pickStaff, type BusyItem } from '../../src/worker/lib/availability.ts'

/**
 * Auto-assign phải TẤT ĐỊNH (PRD §4): ít phút đã đặt nhất trong ngày, hoà thì
 * staff_id nhỏ hơn.
 *
 * Vì sao có file này: test qua tầng API không khoá được luật tiebreak. Đã kiểm
 * bằng mutation test — bỏ hẳn `|| a[0] - b[0]` khỏi hàm sort mà 123 test vẫn
 * xanh, vì thứ tự chèn của Map tình cờ trùng thứ tự staff_id tăng dần. Nếu SQL
 * trả ứng viên theo thứ tự khác (dữ liệu lớn hơn, query đổi, index đổi) thì
 * auto-assign mất tính tất định mà không test nào báo.
 *
 * Các test dưới đây cố tình truyền staffIds theo thứ tự ĐẢO NGƯỢC, nên chúng
 * đỏ ngay khi tiebreak bị bỏ.
 */

const busy = (staff_id: number, minutes: number): BusyItem => ({
  staff_id,
  start_at: 0,
  block_end_at: minutes * 60,
})

describe('pickStaff — auto-assign tất định', () => {
  it('hoà tải thì chọn staff_id nhỏ nhất, dù đầu vào đảo ngược', () => {
    expect(pickStaff([9, 5, 2], [])).toBe(2)
    expect(pickStaff([2, 5, 9], [])).toBe(2)
  })

  it('chọn người ít phút đã đặt nhất, không phụ thuộc thứ tự đầu vào', () => {
    const items = [busy(1, 180), busy(2, 30)]
    expect(pickStaff([1, 2], items)).toBe(2)
    expect(pickStaff([2, 1], items)).toBe(2)
  })

  it('cùng một đầu vào luôn cho cùng kết quả qua nhiều lần gọi', () => {
    const ids = [7, 3, 11, 5]
    const results = new Set(Array.from({ length: 20 }, () => pickStaff(ids, [])))
    expect(results.size).toBe(1)
    expect([...results][0]).toBe(3)
  })

  it('hai người hoà tải ở giữa: vẫn chọn id nhỏ hơn trong hai người đó', () => {
    // staff 1 bận nhiều nhất; 4 và 2 hoà nhau và cùng ít nhất
    const items = [busy(1, 200), busy(4, 45), busy(2, 45)]
    expect(pickStaff([4, 2, 1], items)).toBe(2)
  })

  it('bỏ qua busyItems của người không nằm trong danh sách ứng viên', () => {
    // staff 99 bận kín nhưng không phải ứng viên — không được ảnh hưởng kết quả
    expect(pickStaff([5, 8], [busy(99, 500), busy(5, 60)])).toBe(8)
  })

  it('danh sách ứng viên rỗng trả null', () => {
    expect(pickStaff([], [])).toBeNull()
  })
})
