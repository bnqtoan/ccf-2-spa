// Local-time helpers for the spa timezone. Pure — no D1, no request context.
//
// CONVENTIONS §1: the DB stores UTC epoch seconds; `work_shifts.start_min` /
// `end_min` are minutes from LOCAL midnight. Every conversion between the two
// lives here.
//
// THE TRAP: a Worker runs in UTC, so `new Date(epoch).getDay()` /
// `.getHours()` answer for UTC, not for the spa. 2026-07-22 in Vietnam begins
// at 17:00 UTC on 2026-07-21 — a whole different UTC calendar day. Every
// function below goes through `Intl.DateTimeFormat` with `SPA_TZ` instead of
// any local getter on `Date`.

export const SPA_TZ = 'Asia/Ho_Chi_Minh'

/** The booking grid: slots may only start on a multiple of this, local time. */
export const GRID_MIN = 15

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// One formatter, reused. `en-CA` yields ISO-ish `YYYY-MM-DD, HH:mm:ss` but we
// read the parts explicitly rather than parsing the formatted string.
const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SPA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export interface LocalParts {
  year: number
  month: number // 1..12
  day: number // 1..31
  hour: number // 0..23
  minute: number
  second: number
}

/** Decomposes an epoch (seconds) into wall-clock parts in `SPA_TZ`. */
export function localParts(epochSec: number): LocalParts {
  const parts = partsFormatter.formatToParts(new Date(epochSec * 1000))
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type)
    if (p === undefined) throw new Error(`missing date part: ${type}`)
    return Number(p.value)
  }
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** UTC offset of `SPA_TZ` at a given instant, in seconds (+25200 for VN). */
function tzOffsetSec(epochSec: number): number {
  const p = localParts(epochSec)
  // What the same wall-clock reading would be if it were UTC.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000
  return asUtc - epochSec
}

/**
 * Epoch of a local wall-clock time in `SPA_TZ`.
 *
 * Resolved by iteration rather than by assuming a fixed offset: guess with the
 * UTC interpretation, measure the real offset there, correct, then re-measure
 * once in case the correction crossed a DST boundary. Vietnam has had no DST
 * since 1975, but the algorithm must not depend on that fact.
 */
export function localToEpoch(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second) / 1000
  let guess = asUtc - tzOffsetSec(asUtc)
  guess = asUtc - tzOffsetSec(guess)
  return guess
}

/** Parses a strict `YYYY-MM-DD` string. Returns null when malformed. */
export function parseDateStr(dateStr: string): { year: number; month: number; day: number } | null {
  if (!DATE_RE.test(dateStr)) return null
  const year = Number(dateStr.slice(0, 4))
  const month = Number(dateStr.slice(5, 7))
  const day = Number(dateStr.slice(8, 10))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // Round-trip guard: rejects 2026-02-31 and friends, which Date.UTC would
  // silently roll over into March.
  const epoch = localToEpoch(year, month, day, 12)
  const p = localParts(epoch)
  if (p.year !== year || p.month !== month || p.day !== day) return null
  return { year, month, day }
}

/**
 * `[start, end)` epoch bounds of a LOCAL calendar day.
 * `end` is the next local midnight, computed from the next calendar day rather
 * than by adding 86400 (a DST day is not 24h).
 */
export function localDayBounds(dateStr: string): { start: number; end: number } {
  const d = parseDateStr(dateStr)
  if (d === null) throw new Error(`invalid date: ${dateStr}`)
  const start = localToEpoch(d.year, d.month, d.day, 0, 0, 0)
  // Local noon of the same day + 24h lands safely inside the next local day
  // even across a DST shift; read its calendar date, then take ITS midnight.
  const nextDayish = localParts(start + 36 * 3600)
  const end = localToEpoch(nextDayish.year, nextDayish.month, nextDayish.day, 0, 0, 0)
  return { start, end }
}

/** Weekday (0 = Sunday .. 6 = Saturday) of a local calendar date. */
export function weekdayOf(dateStr: string): number {
  const d = parseDateStr(dateStr)
  if (d === null) throw new Error(`invalid date: ${dateStr}`)
  // Date.UTC + getUTCDay is safe here: we ask for the weekday of the calendar
  // date itself, with no instant/timezone conversion in between.
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()
}

/**
 * Anchors `work_shifts.start_min` / `end_min` (minutes from local midnight)
 * onto a concrete day. Goes back through the local calendar so a DST day
 * cannot shift the wall-clock time of a shift.
 */
export function minutesToEpoch(dayStart: number, minutes: number): number {
  const p = localParts(dayStart)
  return localToEpoch(p.year, p.month, p.day, 0, minutes, 0)
}

/** Minutes elapsed since local midnight of the day containing `epochSec`. */
export function minutesOfLocalDay(epochSec: number): number {
  const p = localParts(epochSec)
  return p.hour * 60 + p.minute + p.second / 60
}

/**
 * Grid check in LOCAL time — deliberately not `epoch % 900 === 0`.
 * The two coincide only when the UTC offset is itself a multiple of 15
 * minutes. Vietnam (+07:00) happens to qualify; other zones (+05:45 Kathmandu)
 * do not, and the coincidence must not be load-bearing.
 */
export function isOnGrid(epochSec: number): boolean {
  const p = localParts(epochSec)
  return p.second === 0 && p.minute % GRID_MIN === 0
}

/** Smallest grid-aligned instant `>= epochSec` (local-time grid). */
export function ceilToGrid(epochSec: number): number {
  const p = localParts(epochSec)
  const mins = p.hour * 60 + p.minute
  const rounded = Math.ceil((mins + (p.second > 0 ? 1 / 60 : 0)) / GRID_MIN) * GRID_MIN
  return localToEpoch(p.year, p.month, p.day, 0, rounded, 0)
}
