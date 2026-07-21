// Định dạng ngày giờ / tiền tệ cho luồng đặt lịch. Thuần, không phụ thuộc
// React hay API — cùng phong cách với routes/lookup/format.ts (T-11), nhưng
// file riêng vì `touches` của T-10 không được sửa thư mục lookup/.

const SPA_TZ = 'Asia/Ho_Chi_Minh'
const WEEKDAY_VN_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
const WEEKDAY_VN_LONG = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SPA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function partsOf(epochSec: number) {
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

const pad = (n: number) => String(n).padStart(2, '0')

/** Tách "YYYY-MM-DD" thành 3 số nguyên — tsconfig bật `noUncheckedIndexedAccess`
 * nên không thể tin `split('-')[i]` là `string` không phải `undefined`. */
function splitDateStr(dateStr: string): { y: number; m: number; d: number } {
  const [yStr, mStr, dStr] = dateStr.split('-')
  return { y: Number(yStr), m: Number(mStr), d: Number(dStr) }
}

/** "YYYY-MM-DD" theo giờ địa phương SPA_TZ của epoch cho trước. */
export function dateStrOf(epochSec: number): string {
  const p = partsOf(epochSec)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Danh sách 14 ngày tới dạng "YYYY-MM-DD", bắt đầu từ hôm nay (giờ SPA_TZ). */
export function next14Days(nowSec: number = Math.floor(Date.now() / 1000)): string[] {
  const todayStr = dateStrOf(nowSec)
  const { y, m, d } = splitDateStr(todayStr)
  const base = Date.UTC(y, m - 1, d)
  const out: string[] = []
  for (let i = 0; i < 14; i++) {
    const t = new Date(base + i * 86400_000)
    out.push(`${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`)
  }
  return out
}

/** Thứ trong tuần (0=CN..6=T7) của một chuỗi "YYYY-MM-DD", không lệ thuộc giờ máy khách. */
function weekdayOfDateStr(dateStr: string): number {
  const { y, m, d } = splitDateStr(dateStr)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Nhãn ngắn cho dải ngày cuộn ngang: "Hôm nay" cho ngày đầu, "T3" cho các ngày sau. */
export function dateChipLabel(dateStr: string, isFirst: boolean): string {
  if (isFirst) return 'Hôm nay'
  return WEEKDAY_VN_SHORT[weekdayOfDateStr(dateStr)] ?? ''
}

/** Số ngày trong tháng, ví dụ "24" từ "2026-07-24". */
export function dayOfMonth(dateStr: string): string {
  return pad(splitDateStr(dateStr).d)
}

/** "Thứ Năm, 24/07" — dùng ở màn xác nhận/thành công khi không phải hôm nay. */
export function fullDateLabel(dateStr: string): string {
  const { m, d } = splitDateStr(dateStr)
  return `${WEEKDAY_VN_LONG[weekdayOfDateStr(dateStr)] ?? ''}, ${pad(d)}/${pad(m)}`
}

/** "17:30" từ epoch giây, theo giờ SPA_TZ. */
export function hm(epochSec: number): string {
  const p = partsOf(epochSec)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** "350.000₫" — định dạng VND theo văn phong prototype (dấu chấm phân cách). */
export function formatVnd(amount: number): string {
  return `${Math.round(amount).toLocaleString('vi-VN')}₫`
}

export type DayPart = 'Buổi sáng' | 'Buổi chiều' | 'Buổi tối'

/** Buổi trong ngày của một epoch, dựa trên giờ địa phương SPA_TZ. */
export function dayPartOf(epochSec: number): DayPart {
  const hour = partsOf(epochSec).hour
  if (hour < 12) return 'Buổi sáng'
  if (hour < 17) return 'Buổi chiều'
  return 'Buổi tối'
}
