// Fetch helpers cho màn timeline admin (T-12). Ba endpoint thật đã có:
// GET /api/admin/schedule?date=, GET /api/admin/reassign-queue,
// POST /api/admin/bookings/:id/status (T-16 / T-07 / T-05).
//
// Mọi lỗi từ server có hình dạng { error: { code, message } } (CONVENTIONS
// §5) — ném ApiError giữ nguyên `code`, đúng mẫu src/app/lib/apiClient.ts.

export type BookingItemStatus = 'booked' | 'in_service' | 'done' | 'no_show'
export type BookingItemSource = 'online' | 'walk_in' | 'admin'

export interface ScheduleItem {
  id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: BookingItemStatus
  source: BookingItemSource
  customer_name: string
  service_name: string
  variant_name: string
}

export interface ScheduleTimeOff {
  id: number
  start_at: number
  end_at: number
  reason: string | null
}

export interface ScheduleStaff {
  id: number
  name: string
  items: ScheduleItem[]
  time_off: ScheduleTimeOff[]
}

export interface ScheduleResponse {
  date: string
  staff: ScheduleStaff[]
}

export interface ReassignQueueItem {
  item_id: number
  [key: string]: unknown
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}

export class ApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function parseErrorAndThrow(res: Response): Promise<never> {
  let body: Partial<ApiErrorBody> = {}
  try {
    body = (await res.json()) as Partial<ApiErrorBody>
  } catch {
    // body không phải JSON hợp lệ — vẫn ném lỗi chung, không để crash im lặng.
  }
  throw new ApiError(body.error?.code ?? 'UNKNOWN', body.error?.message ?? 'Có lỗi xảy ra')
}

/** `GET /api/admin/schedule?date=` — toàn bộ booking_items + time_off trong ngày, mọi KTV. */
export async function getSchedule(date: string): Promise<ScheduleResponse> {
  const res = await fetch(`/api/admin/schedule?date=${encodeURIComponent(date)}`)
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as ScheduleResponse
}

/**
 * `GET /api/admin/reassign-queue` — item mồ côi do time-off. Nguồn sự thật
 * DUY NHẤT cho "item nào là mồ côi" — không tự suy luận lại ở frontend
 * (PRD §8, nhắc lại trong card T-12).
 */
export async function getReassignQueue(): Promise<ReassignQueueItem[]> {
  const res = await fetch('/api/admin/reassign-queue')
  if (!res.ok) return parseErrorAndThrow(res)
  const body = (await res.json()) as { items: ReassignQueueItem[] }
  return body.items
}

/** `POST /api/admin/bookings/:id/status` — chuyển trạng thái một booking_item. */
export async function setBookingStatus(
  itemId: number,
  status: 'in_service' | 'done' | 'no_show',
): Promise<void> {
  const res = await fetch(`/api/admin/bookings/${itemId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) return parseErrorAndThrow(res)
}
