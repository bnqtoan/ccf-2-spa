// Định dạng cho màn /admin/overview. Thuần, không phụ thuộc React/API.
// Dùng lại đúng mẫu giờ-địa-phương của timeline/format.ts (không tự chế lại
// timezone). Thêm: format tiền VNĐ và kiểm tra một khung giờ có bận không.

const SPA_TZ = 'Asia/Ho_Chi_Minh'
const WEEKDAY_VN_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SPA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function localParts(epochSec: number) {
  const p = partsFormatter.formatToParts(new Date(epochSec * 1000))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(p.find((x) => x.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

/** "YYYY-MM-DD" theo giờ spa — dùng làm query param `date`. */
export function toDateStr(epochSec: number): string {
  const p = localParts(epochSec)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Số phút kể từ nửa đêm địa phương. */
export function minutesOfLocalDay(epochSec: number): number {
  const p = localParts(epochSec)
  return p.hour * 60 + p.minute
}

function splitDateStr(dateStr: string): { y: number; m: number; d: number } {
  const parts = dateStr.split('-')
  return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) }
}

/** "Hôm nay · T4, 24/07" — nhãn ngày cho thanh điều hướng. */
export function formatDateNav(dateStr: string, todayStr: string): string {
  const { y, m, d } = splitDateStr(dateStr)
  const weekday = WEEKDAY_VN_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  const pad = (n: number) => String(n).padStart(2, '0')
  const label = `${weekday}, ${pad(d)}/${pad(m)}`
  return dateStr === todayStr ? `Hôm nay · ${label}` : label
}

/** Cộng/trừ N ngày vào "YYYY-MM-DD". */
export function addDays(dateStr: string, delta: number): string {
  const { y, m, d } = splitDateStr(dateStr)
  const next = new Date(Date.UTC(y, m - 1, d + delta))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

/** Tiền VNĐ, có dấu chấm ngăn cách nghìn: 350000 → "350.000 đ". */
export function formatVnd(amount: number): string {
  return `${amount.toLocaleString('vi-VN')} đ`
}

/** Tỉ lệ hoa hồng (0.35) → "35%". */
export function formatPct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

/**
 * Một khung giờ [slotStartMin, slotStartMin+slotLenMin) (phút-từ-nửa-đêm) có
 * giao với bất kỳ interval bận nào không. Dùng để tô xanh/xám ô lưới.
 */
export function isSlotBusy(
  slotStartMin: number,
  slotLenMin: number,
  busyIntervals: { start_at: number; end_at: number }[],
): boolean {
  const slotEnd = slotStartMin + slotLenMin
  for (const b of busyIntervals) {
    const bStart = minutesOfLocalDay(b.start_at)
    // end có thể vắt qua nửa đêm → quy về phút trong ngày, nếu <= start thì coi
    // như chạm hết ngày (1440).
    let bEnd = minutesOfLocalDay(b.end_at)
    if (bEnd <= bStart) bEnd = 1440
    if (bStart < slotEnd && bEnd > slotStartMin) return true
  }
  return false
}
