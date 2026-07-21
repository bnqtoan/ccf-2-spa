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
