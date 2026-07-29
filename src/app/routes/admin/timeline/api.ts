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
  /** T-25: appointment cha của item này — cần để gọi
   *  POST /api/admin/appointments/:id/items (thêm dịch vụ). */
  appointment_id: number
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

export interface AffectedItem {
  item_id: number
  customer_name: string
  customer_phone: string | null
  service_name: string
  start_at: number
  [key: string]: unknown
}

/**
 * `POST /api/admin/time-off` — ghi nhận một kỹ thuật viên nghỉ (PRD §8). KHÔNG
 * bao giờ tự huỷ/tự chuyển lịch: trả về `affected_items` để người xử lý — chính
 * là các item sẽ hiện trong hàng chờ xếp lại. Không throw khi có lịch đè; chỉ
 * throw khi request lỗi thật (validation/mạng).
 */
export async function createTimeOff(input: {
  staff_id: number
  start_at: number
  end_at: number
  reason?: string | null
}): Promise<{ affected_items: AffectedItem[] }> {
  const res = await fetch('/api/admin/time-off', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as { affected_items: AffectedItem[] }
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

// --- T-25: "+ Thêm dịch vụ" trong sheet booking — G6, backend đã có sẵn ----
// (src/worker/routes/admin-appointment-items.ts, KHÔNG sửa). Ba hàm dưới đây
// chỉ GỌI ba endpoint thật đã có: GET /api/services, GET /api/availability,
// POST /api/admin/appointments/:id/items.

export interface ServiceVariant {
  id: number
  name: string
  duration_min: number
  buffer_after_min: number
  price: number
}

export interface Service {
  id: number
  name: string
  body_zone: string
  variants: ServiceVariant[]
}

/** `GET /api/services` — danh mục dịch vụ + gói đang bán. */
export async function getServices(): Promise<Service[]> {
  const res = await fetch('/api/services')
  if (!res.ok) return parseErrorAndThrow(res)
  const body = (await res.json()) as { services: Service[] }
  return body.services
}

export interface AvailabilitySlot {
  start_at: number
  staff_ids: number[]
}

/** `GET /api/availability?variant_id&date` — slot còn trống trong ngày đang xem. */
export async function getAvailability(variantId: number, date: string): Promise<AvailabilitySlot[]> {
  const params = new URLSearchParams({ variant_id: String(variantId), date })
  const res = await fetch(`/api/availability?${params.toString()}`)
  if (!res.ok) return parseErrorAndThrow(res)
  const body = (await res.json()) as { slots: AvailabilitySlot[] }
  return body.slots
}

export interface AddAppointmentItemResult {
  item: { id: number; [key: string]: unknown }
}

/**
 * `POST /api/admin/appointments/:id/items` — thêm một item combo vào một
 * appointment ĐÃ CÓ. Backend re-validate booking đầy đủ + chặn 2 item cùng
 * `body_zone` chồng giờ trong CÙNG appointment (409 ZONE_CONFLICT). Ném
 * `ApiError` giữ nguyên `code` — UI (Sheet) là nơi dịch sang câu tiếng Việt
 * thân thiện, không hiện mã lỗi thô cho lễ tân.
 */
export async function addAppointmentItem(
  appointmentId: number,
  input: { variant_id: number; staff_id: number; start_at: number },
): Promise<AddAppointmentItemResult> {
  const res = await fetch(`/api/admin/appointments/${appointmentId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as AddAppointmentItemResult
}
