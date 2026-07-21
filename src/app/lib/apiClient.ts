// Fetch helpers cho luồng khách đặt lịch (T-10). Ba hàm gọi 3 endpoint thật
// đã có: GET /api/services, GET /api/availability, POST /api/bookings.
//
// Mọi lỗi từ server có hình dạng { error: { code, message } } (CONVENTIONS
// §5). Ở đây ta ném `ApiError` giữ nguyên `code` để UI tự quyết định hiển thị
// gì — KHÔNG bao giờ để nguyên object lỗi hiện thẳng ra màn hình khách. UI là
// nơi dịch `code` sang câu tiếng Việt tự nhiên, file này chỉ chuyển tiếp.

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

export interface AvailabilitySlot {
  start_at: number
  staff_ids: number[]
}

export interface BookingPayload {
  customer: { name: string; phone: string }
  variant_id: number
  start_at: number
  staff_id?: number
}

export interface BookingResult {
  appointment: { id: number; [key: string]: unknown }
  item: { id: number; [key: string]: unknown }
  staff: { id: number; name: string } | null
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

/** `GET /api/services` — danh sách dịch vụ active kèm variants active lồng sẵn. */
export async function getServices(): Promise<Service[]> {
  const res = await fetch('/api/services')
  if (!res.ok) return parseErrorAndThrow(res)
  const body = (await res.json()) as { services: Service[] }
  return body.services
}

/** `GET /api/availability?variant_id&date[&staff_id]` — slot còn trống trong ngày. */
export async function getAvailability(
  variantId: number,
  date: string,
  staffId?: number,
): Promise<AvailabilitySlot[]> {
  const params = new URLSearchParams({ variant_id: String(variantId), date })
  if (staffId !== undefined) params.set('staff_id', String(staffId))
  const res = await fetch(`/api/availability?${params.toString()}`)
  if (!res.ok) return parseErrorAndThrow(res)
  const body = (await res.json()) as { slots: AvailabilitySlot[] }
  return body.slots
}

/**
 * `POST /api/bookings` — tạo lịch hẹn. Ném `ApiError` khi server từ chối:
 * 409 SLOT_TAKEN/STAFF_LACKS_SKILL/OUTSIDE_SHIFT, 422 VALIDATION, 404
 * NOT_FOUND. UI (bước xác nhận) là nơi quyết định 409 SLOT_TAKEN nghĩa là gì
 * với khách — file này chỉ chuyển tiếp `code` nguyên vẹn.
 */
export async function createBooking(payload: BookingPayload): Promise<BookingResult> {
  const res = await fetch('/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as BookingResult
}
