// Định dạng/quy đổi cho màn Thiết lập admin (T-17). Thuần, không phụ thuộc
// React hay API — theo đúng mẫu src/app/routes/admin/timeline/format.ts.
//
// CẠM BẪY ĐÃ BIẾT (nhắc lại từ card + CONVENTIONS §1): work_shifts.start_min
// và end_min là PHÚT TỪ NỬA ĐÊM GIỜ ĐỊA PHƯƠNG (0..1440), KHÔNG phải epoch.
// Không có timezone nào để quy đổi ở đây — chỉ là số học phút thuần tuý.

export const WEEKDAY_LABELS = [
  'Chủ nhật',
  'Thứ Hai',
  'Thứ Ba',
  'Thứ Tư',
  'Thứ Năm',
  'Thứ Sáu',
  'Thứ Bảy',
] as const

export const BODY_ZONE_LABELS: Record<string, string> = {
  hair: 'Tóc',
  hands: 'Tay',
  feet: 'Chân',
  face: 'Mặt',
  body: 'Toàn thân',
}

/** "HH:MM" (ví dụ "09:00") → phút từ nửa đêm (ví dụ 540). null nếu không hợp lệ. */
export function hmToMinutes(hm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h < 0 || h > 24 || m < 0 || m > 59) return null
  const total = h * 60 + m
  return total >= 0 && total <= 1440 ? total : null
}

/** Phút từ nửa đêm (0..1440) → "HH:MM" để hiển thị lại trong input type="time". */
export function minutesToHm(min: number): string {
  const clamped = Math.max(0, Math.min(1440, min))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Format giá VNĐ không thập phân, có dấu chấm ngăn cách hàng nghìn. */
export function formatVnd(amount: number): string {
  return `${amount.toLocaleString('vi-VN')} đ`
}
