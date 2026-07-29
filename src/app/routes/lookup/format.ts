// Định dạng ngày giờ / tiền tệ cho màn tra cứu lịch. Thuần, không phụ thuộc
// React hay API — dễ test độc lập nếu cần sau này.

const SPA_TZ = 'Asia/Ho_Chi_Minh'
const WEEKDAY_VN = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SPA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function parts(epochSec: number) {
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

/** Ngày local hiện tại theo SPA_TZ, dạng "y-m-d" để so sánh "hôm nay". */
function localDateKey(epochSec: number): string {
  const p = parts(epochSec)
  return `${p.year}-${p.month}-${p.day}`
}

/** "Hôm nay · 17:30" hoặc "Thứ Năm, 24/07 · 14:00" — theo văn phong prototype. */
export function formatWhen(epochSec: number, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const p = parts(epochSec)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(p.hour)}:${pad(p.minute)}`
  const isToday = localDateKey(epochSec) === localDateKey(nowSec)
  if (isToday) return `Hôm nay · ${hm}`
  const weekday = WEEKDAY_VN[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]
  return `${weekday}, ${pad(p.day)}/${pad(p.month)} · ${hm}`
}

/** Số giờ còn lại (có thể âm nếu đã qua) từ `nowSec` đến `startAtSec`. */
export function hoursUntil(startAtSec: number, nowSec: number = Math.floor(Date.now() / 1000)): number {
  return (startAtSec - nowSec) / 3600
}

// --- Helper cho grid ĐỔI GIỜ (T-24) — mở lại lưới chọn giờ ngay trong màn
// tra cứu. Cùng phong cách với routes/booking/format.ts nhưng file riêng vì
// touches T-24 gồm thư mục lookup/, không đụng booking/. ---

const pad = (n: number) => String(n).padStart(2, '0')
const WEEKDAY_VN_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

function splitDateStr(dateStr: string): { y: number; m: number; d: number } {
  const [yStr, mStr, dStr] = dateStr.split('-')
  return { y: Number(yStr), m: Number(mStr), d: Number(dStr) }
}

function weekdayOfDateStr(dateStr: string): number {
  const { y, m, d } = splitDateStr(dateStr)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** "YYYY-MM-DD" theo giờ SPA_TZ của epoch — khớp param `date` của availability. */
export function dateStrOf(epochSec: number): string {
  const p = parts(epochSec)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** 14 ngày tới dạng "YYYY-MM-DD", bắt đầu từ hôm nay (giờ SPA_TZ). */
export function next14Days(nowSec: number = Math.floor(Date.now() / 1000)): string[] {
  const { y, m, d } = splitDateStr(dateStrOf(nowSec))
  const base = Date.UTC(y, m - 1, d)
  const out: string[] = []
  for (let i = 0; i < 14; i++) {
    const t = new Date(base + i * 86400_000)
    out.push(`${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`)
  }
  return out
}

/** Nhãn ngắn dải ngày: "Hôm nay" cho ngày đầu, "T3"… cho các ngày sau. */
export function dateChipLabel(dateStr: string, isFirst: boolean): string {
  if (isFirst) return 'Hôm nay'
  return WEEKDAY_VN_SHORT[weekdayOfDateStr(dateStr)] ?? ''
}

/** Ngày trong tháng, ví dụ "24". */
export function dayOfMonth(dateStr: string): string {
  return pad(splitDateStr(dateStr).d)
}

/** "17:30" từ epoch giây, theo giờ SPA_TZ. */
export function hm(epochSec: number): string {
  const p = parts(epochSec)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

export type DayPart = 'Buổi sáng' | 'Buổi chiều' | 'Buổi tối'

/** Buổi trong ngày của một epoch, theo giờ SPA_TZ. */
export function dayPartOf(epochSec: number): DayPart {
  const hour = parts(epochSec).hour
  if (hour < 12) return 'Buổi sáng'
  if (hour < 17) return 'Buổi chiều'
  return 'Buổi tối'
}
