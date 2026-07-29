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

/** R1a serial-combo availability. `coverable: false` = no single technician
 * holds every skill the chosen combo needs — the "shown before commit" gate. */
export interface ComboAvailability {
  coverable: boolean
  slots: AvailabilitySlot[]
}

export interface ComboBookingResult {
  appointment: { id: number; [key: string]: unknown }
  items: Array<{ id: number; staff_id?: number; start_at?: number; end_at?: number; [key: string]: unknown }>
  /** Serial: the single technician. Parallel: null (see `staff_by_id`). */
  staff: { id: number; name: string } | null
  /** Parallel only: the roster of the DIFFERENT technicians, one per leg, so the
   *  UI can show "ai làm gì lúc nào". Undefined for serial. */
  staff_by_id?: Array<{ id: number; name: string }>
  mode?: 'serial' | 'parallel'
}

/** How a combo is served. serial = 1 KTV nối tiếp (R1a); parallel = nhiều KTV
 *  cùng lúc (R1b). */
export type ComboMode = 'serial' | 'parallel'

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

// --- PAYMENT track: online payment at booking time -------------------------
// The intent is DISCRIMINATED by `kind`: SePay returns a QR to render + wait
// on; PayPal returns a redirect URL. The UI switches on `kind` — it must not
// treat them as the same shape. Never leak a raw gateway error to the customer;
// this layer forwards the `code` and the UI translates it.

export type PaymentProviderId = 'sepay' | 'paypal'

export type PaymentIntent =
  | {
      kind: 'qr'
      qrData: string | null
      qrImageUrl: string | null
      code: string
      accountNumber: string
      amountVnd: number
    }
  | { kind: 'redirect'; approveUrl: string; providerOrderId: string }

export interface CreatePaymentResult {
  order_ref: string
  provider: PaymentProviderId
  intent: PaymentIntent
}

export interface PaymentStatusResult {
  order_ref: string
  provider: PaymentProviderId
  status: 'pending' | 'paid' | 'failed' | 'expired'
  amount_vnd: number
  appointment_id: number | null
  paid_at: number | null
}

/** `POST /api/payments/create` — starts a payment for an existing appointment.
 *  Returns the discriminated intent (qr | redirect). */
export async function createPayment(payload: {
  appointment_id: number
  amount_vnd: number
  provider: PaymentProviderId
  description?: string
}): Promise<CreatePaymentResult> {
  const res = await fetch('/api/payments/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as CreatePaymentResult
}

/** `GET /api/payments/:orderRef` — poll whether the money has landed. */
export async function getPaymentStatus(orderRef: string): Promise<PaymentStatusResult> {
  const res = await fetch(`/api/payments/${encodeURIComponent(orderRef)}`)
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as PaymentStatusResult
}

/**
 * `POST /api/combo/availability` — R1a serial combo. Returns `coverable`
 * (does any single technician hold every skill the chosen variants need?) plus
 * the day's slots big enough for the whole chain. `coverable: false` is a
 * legitimate answer, NOT an error — the UI shows it before the customer commits.
 */
export async function getComboAvailability(
  variantIds: number[],
  date: string,
  opts?: { staffId?: number; mode?: ComboMode },
): Promise<ComboAvailability> {
  const res = await fetch('/api/combo/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      variant_ids: variantIds,
      date,
      ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
      // Parallel ignores staff_id (N techs); only pass it for serial.
      ...(opts?.staffId !== undefined && opts.mode !== 'parallel' ? { staff_id: opts.staffId } : {}),
    }),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as ComboAvailability
}

export interface ComboBookingPayload {
  customer: { name: string; phone: string }
  variant_ids: number[]
  start_at: number
  staff_id?: number
  mode?: ComboMode
}

/** `POST /api/combo/bookings` — creates ONE appointment with N serial items on
 * one technician. Throws `ApiError` (STAFF_LACKS_SKILL / SLOT_TAKEN / …) which
 * the UI translates; never leaks a raw code to the customer. */
export async function createComboBooking(payload: ComboBookingPayload): Promise<ComboBookingResult> {
  const res = await fetch('/api/combo/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as ComboBookingResult
}
