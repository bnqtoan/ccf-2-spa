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
  /** T-32: SĐT khách — nullable (CONVENTIONS §4: khách lẻ chỉ có tên). RBAC đã
   *  lọc ở server (`admin-schedule.ts`): technician chỉ nhận item của chính
   *  mình nên phone chỉ lộ cho KTV đang phục vụ khách đó. */
  customer_phone: string | null
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

/** T-31: một ngày trong response range — cùng hình dạng `staff` như ScheduleResponse. */
export interface ScheduleRangeDay {
  date: string
  staff: ScheduleStaff[]
}

export interface ScheduleRangeResponse {
  from: string
  to: string
  days: ScheduleRangeDay[]
}

/**
 * `GET /api/admin/schedule?from=&to=` — T-31 week view: MỘT request cho cả 7
 * ngày (không lặp `getSchedule` 7 lần tuần tự — cạm bẫy đã ghi trong card).
 */
export async function getScheduleRange(from: string, to: string): Promise<ScheduleRangeResponse> {
  const params = new URLSearchParams({ from, to })
  const res = await fetch(`/api/admin/schedule?${params.toString()}`)
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as ScheduleRangeResponse
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

// --- T-29: tạo lịch trực tiếp trên timeline (click ô trống -> prefill) -----

export interface CreateAdminBookingResult {
  appointment: { id: number; [key: string]: unknown }
  item: { id: number; [key: string]: unknown }
}

/**
 * `POST /api/admin/bookings` — lễ tân tạo một lịch TƯƠNG LAI cho khách (gọi
 * điện / vãng lai) ngay từ timeline: `source='admin'`, `status='booked'`
 * (khác walk-in: không phải "ngay bây giờ", không phải in_service). Gate ở
 * SERVER (owner + lễ tân) — bài học T-28: ẩn nút UI không đủ, KTV gọi thẳng
 * endpoint này vẫn phải nhận 403.
 */
export async function createAdminBooking(input: {
  name: string
  phone?: string
  variant_id: number
  start_at: number
  staff_id: number
}): Promise<CreateAdminBookingResult> {
  const res = await fetch('/api/admin/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as CreateAdminBookingResult
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

// --- T-30: đổi GIỜ / đổi KTV cho một lịch bình thường NGAY trên timeline -----
// (G1/G3). KHÔNG có endpoint mới: dùng lại đúng reschedule NGUYÊN TỬ race-safe
// đã có (src/worker/routes/reschedule.ts, T-24) — hiện chỉ nối vào trang khách
// /lookup. Đổi = MỘT câu UPDATE có guard (rescheduleItemAtomically): hoặc dời
// được, hoặc item CŨ Y NGUYÊN. TUYỆT ĐỐI không ghép cancel+book ở client
// (race → mất lịch âm thầm, đúng thảm hoạ card gọi tên).
//
// Body: { start_at, staff_id? }. Không gửi staff_id = giữ KTV cũ (chỉ đổi giờ).
// Server tự nạp variant từ item nên client KHÔNG cần variant_id. Server áp đúng
// cutoff 2h + skill/shift/slot (advisory cho mã lỗi đẹp, rồi guard nguyên tử là
// trọng tài). Ném `ApiError` giữ nguyên `code` — Sheet dịch sang tiếng Việt:
// SLOT_TAKEN / CANCEL_TOO_LATE / STAFF_LACKS_SKILL / OUTSIDE_SHIFT / VALIDATION.

export interface RescheduleResult {
  item: { id: number; staff_id: number; start_at: number; end_at: number; block_end_at: number; status: string }
  staff: { id: number; name: string } | null
}

export async function rescheduleBooking(
  itemId: number,
  startAt: number,
  staffId?: number,
): Promise<RescheduleResult> {
  const res = await fetch(`/api/bookings/${itemId}/reschedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_at: startAt, ...(staffId !== undefined ? { staff_id: staffId } : {}) }),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as RescheduleResult
}
