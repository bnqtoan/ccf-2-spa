// Định dạng ngày giờ cho màn timeline admin. Thuần, không phụ thuộc React hay
// API — theo đúng mẫu src/app/routes/lookup/format.ts.

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

export interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export function localParts(epochSec: number): LocalParts {
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

/** "YYYY-MM-DD" theo giờ địa phương spa — dùng làm query param `date`. */
export function toDateStr(epochSec: number): string {
  const p = localParts(epochSec)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** "HH:mm" theo giờ địa phương spa. */
export function formatHm(epochSec: number): string {
  const p = localParts(epochSec)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** Số phút kể từ nửa đêm địa phương của epoch đã cho. */
export function minutesOfLocalDay(epochSec: number): number {
  const p = localParts(epochSec)
  return p.hour * 60 + p.minute
}

function splitDateStr(dateStr: string): { y: number; m: number; d: number } {
  const parts = dateStr.split('-')
  return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) }
}

/** "Hôm nay · Thứ Hai, 21/07" — nhãn ngày cho thanh điều hướng. */
export function formatDateNav(dateStr: string, todayStr: string): string {
  const { y, m, d } = splitDateStr(dateStr)
  const weekday = WEEKDAY_VN_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  const pad = (n: number) => String(n).padStart(2, '0')
  const label = `${weekday}, ${pad(d)}/${pad(m)}`
  return dateStr === todayStr ? `Hôm nay · ${label}` : label
}

/** Cộng/trừ N ngày vào một "YYYY-MM-DD", trả về "YYYY-MM-DD" mới. */
export function addDays(dateStr: string, delta: number): string {
  const { y, m, d } = splitDateStr(dateStr)
  const next = new Date(Date.UTC(y, m - 1, d + delta))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}
