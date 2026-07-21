// Fetch helpers riêng cho màn "Hàng chờ xếp lại" + sheet "Chuyển kỹ thuật
// viên" (T-13). Không dùng chung `src/app/lib/apiClient.ts` (tiền lệ
// T-11/T-12: mỗi route tự chứa api.ts riêng, tránh đụng độ merge).
//
// Bốn endpoint thật đã có (T-07): GET /api/admin/reassign-queue,
// GET /api/admin/bookings/:id/reassign-candidates,
// POST /api/admin/bookings/:id/reassign, POST /api/admin/bookings/:id/cancel.
// Mọi lỗi từ server có hình dạng { error: { code, message } } (CONVENTIONS §5).

export interface QueueItem {
  item_id: number
  appointment_id: number
  staff_id: number
  staff_name: string
  customer_id: number
  customer_name: string
  customer_phone: string | null
  service_name: string
  variant_name: string
  variant_id: number
  duration_min: number
  buffer_after_min: number
  skill_id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: string
}

export type IneligibleReason = 'STAFF_LACKS_SKILL' | 'OUTSIDE_SHIFT' | 'ON_TIME_OFF' | 'SLOT_TAKEN' | 'VALIDATION'

export interface Candidate {
  staff: { id: number; name: string; active: number }
  eligible: boolean
  reason: IneligibleReason | null
  message: string | null
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

/** `GET /api/admin/reassign-queue` — item mồ côi do time-off, toàn cục (không lọc theo ngày). */
export async function getReassignQueue(): Promise<QueueItem[]> {
  const res = await fetch('/api/admin/reassign-queue')
  if (!res.ok) return parseErrorAndThrow(res)
  const body = (await res.json()) as { items: QueueItem[] }
  return body.items
}

/**
 * `GET /api/admin/bookings/:id/reassign-candidates` — MỌI KTV khác đang hoạt
 * động, mỗi người kèm `eligible` + `reason` (lấy nguyên văn, không tự diễn
 * giải lại — card nhấn lại điểm này).
 */
export async function getReassignCandidates(itemId: number): Promise<Candidate[]> {
  const res = await fetch(`/api/admin/bookings/${itemId}/reassign-candidates`)
  if (!res.ok) return parseErrorAndThrow(res)
  const body = (await res.json()) as { candidates: Candidate[] }
  return body.candidates
}

/** `POST /api/admin/bookings/:id/reassign` — chuyển item sang KTV khác. */
export async function reassignBooking(itemId: number, staffId: number): Promise<void> {
  const res = await fetch(`/api/admin/bookings/${itemId}/reassign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staff_id: staffId }),
  })
  if (!res.ok) return parseErrorAndThrow(res)
}

/** `POST /api/admin/bookings/:id/cancel` — admin huỷ, không giới hạn cutoff. */
export async function cancelBooking(itemId: number): Promise<void> {
  const res = await fetch(`/api/admin/bookings/${itemId}/cancel`, { method: 'POST' })
  if (!res.ok) return parseErrorAndThrow(res)
}
