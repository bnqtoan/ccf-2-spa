// Fetch helpers riêng cho màn tra cứu lịch (T-11). KHÔNG dùng chung
// `src/app/api/client.ts` — file đó thuộc T-10 (đang chạy song song), sửa nó
// dễ đụng độ merge. Đây là bản tối giản, tự chứa trong thư mục lookup/.

export interface CustomerBooking {
  appointment_id: number
  item_id: number
  start_at: number
  end_at: number
  block_end_at: number
  status: 'booked' | 'in_service' | 'done' | 'cancelled' | 'no_show'
  source: string
  staff_id: number
  staff_name: string
  service_name: string
  variant_name: string
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

/** `GET /api/bookings?phone=` — lịch hẹn của một số điện thoại (T-04/T-11). */
export async function getBookingsByPhone(phone: string): Promise<CustomerBooking[]> {
  const res = await fetch(`/api/bookings?phone=${encodeURIComponent(phone)}`)
  const body = (await res.json()) as { bookings?: CustomerBooking[] } & Partial<ApiErrorBody>
  if (!res.ok) {
    throw new ApiError(body.error?.code ?? 'UNKNOWN', body.error?.message ?? 'Có lỗi xảy ra')
  }
  return body.bookings ?? []
}

/**
 * `POST /api/bookings/:id/cancel` — khách tự huỷ (T-05).
 * Ném `ApiError` khi server từ chối (409 CANCEL_TOO_LATE, 409
 * INVALID_TRANSITION, 404 NOT_FOUND...) để UI tự quyết định hiển thị gì —
 * đặc biệt là nhánh CANCEL_TOO_LATE bất ngờ phải đổi sang hotline, không hiện
 * mã lỗi thô (card T-11, mục "Xử lý bấm Huỷ lịch").
 */
export async function cancelBooking(itemId: number): Promise<void> {
  const res = await fetch(`/api/bookings/${itemId}/cancel`, { method: 'POST' })
  if (!res.ok) {
    const body = (await res.json()) as Partial<ApiErrorBody>
    throw new ApiError(body.error?.code ?? 'UNKNOWN', body.error?.message ?? 'Có lỗi xảy ra')
  }
}
