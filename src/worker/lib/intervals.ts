// Pure interval algebra. Half-open intervals `[start, end)` — CONVENTIONS §2.
//
// No timezone knowledge, no domain knowledge, no D1. Numbers are opaque:
// this module works equally on epoch seconds or minutes-from-midnight.
//
// The half-open rule is the whole point: `[9:00, 10:00)` and `[10:00, 11:00)`
// are ADJACENT, not overlapping. Getting this wrong silently loses one valid
// slot at every boundary.

export interface Interval {
  start: number
  end: number
}

/** An interval is empty (and therefore meaningless) when it has no width. */
export function isEmpty(a: Interval): boolean {
  return a.end <= a.start
}

/**
 * Overlap test for half-open intervals: `a1 < b2 && a2 < b1` (CONVENTIONS §2).
 * Touching endpoints (`a.end === b.start`) is NOT an overlap.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

/** True when `inner` sits entirely inside `outer` (half-open containment). */
export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end
}

/**
 * Sorts by start (then end) and merges intervals that overlap OR touch.
 * Touching intervals are merged here on purpose: `[0,10)` ∪ `[10,20)` covers
 * exactly `[0,20)` with no gap, so keeping them separate would fabricate a
 * zero-width seam that later fragments free time incorrectly.
 * Empty intervals are dropped.
 */
export function mergeOverlapping(list: Interval[]): Interval[] {
  const sorted = list
    .filter((i) => !isEmpty(i))
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const out: Interval[] = []
  for (const cur of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && cur.start <= last.end) {
      // Overlapping or touching → extend. `Math.max` because a fully-contained
      // interval must not shrink the accumulated one.
      last.end = Math.max(last.end, cur.end)
    } else {
      out.push({ start: cur.start, end: cur.end })
    }
  }
  return out
}

/**
 * Removes every `hole` from `base`, returning the remaining pieces in
 * ascending order. Half-open throughout, so a hole that merely touches `base`
 * at an endpoint removes nothing.
 *
 * Zero-width remainders are never returned.
 */
export function subtract(base: Interval, holes: Interval[]): Interval[] {
  if (isEmpty(base)) return []

  // Merging first means overlapping holes are handled in one linear sweep and
  // can never produce a negative-width remainder.
  const merged = mergeOverlapping(holes.filter((h) => overlaps(base, h)))

  const out: Interval[] = []
  let cursor = base.start
  for (const h of merged) {
    if (h.start > cursor) out.push({ start: cursor, end: h.start })
    cursor = Math.max(cursor, h.end)
    if (cursor >= base.end) break
  }
  if (cursor < base.end) out.push({ start: cursor, end: base.end })
  return out
}

/** `subtract` applied to a list of bases, flattened and kept in order. */
export function subtractAll(bases: Interval[], holes: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const b of bases) out.push(...subtract(b, holes))
  return out
}
