// Fetch helpers riêng cho sheet "Khách vãng lai" (T-13). Không dùng chung
// `src/app/lib/apiClient.ts` — theo đúng tiền lệ T-11/T-12 (mỗi route tự
// chứa api.ts riêng, tránh đụng độ merge khi nhiều task chạy song song).
//
// Ba endpoint thật đã có (T-16/T-08): GET /api/services,
// GET /api/admin/available-now?variant_id=, POST /api/admin/walk-ins.
// Mọi lỗi từ server có hình dạng { error: { code, message } } (CONVENTIONS §5).

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

export interface AvailableStaff {
  id: number
  name: string
}

export interface WalkInResult {
  appointment: unknown
  item: unknown
  staff: { id: number; name: string }
  customer: { id: number; name: string; phone: string | null }
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

/** `GET /api/services` — danh mục dịch vụ + gói đang bán. */
export async function getServices(): Promise<Service[]> {
  const res = await fetch('/api/services')
  if (!res.ok) return parseErrorAndThrow(res)
  const body = (await res.json()) as { services: Service[] }
  return body.services
}

/**
 * `GET /api/admin/available-now?variant_id=` — KTV rảnh NGAY BÂY GIỜ cho gói
 * này.
 *
 * LƯU Ý: response thật của route này (`src/worker/routes/admin-walkin.ts`,
 * thuộc T-08, ngoài `touches` của T-13 — không được sửa) chỉ trả `{ id }`
 * cho mỗi người, KHÔNG có `name` như card mô tả — đã kiểm chứng bằng
 * `curl`/browser thật, không phải suy đoán. Thiếu `name` khiến `<Avatar>`
 * crash trắng trang khi nhận `undefined` (đã tái hiện bằng browser thật).
 * Hàm này tự bù `name` bằng một lần gọi `GET /api/admin/staff` (T-06, có sẵn,
 * trả toàn bộ KTV kèm tên) và map theo `id` — không sửa route T-08, không tự
 * suy đoán tên, chỉ tra cứu dữ liệu thật.
 */
export async function getAvailableNow(variantId: number): Promise<AvailableStaff[]> {
  const [availRes, staffRes] = await Promise.all([
    fetch(`/api/admin/available-now?variant_id=${encodeURIComponent(String(variantId))}`),
    fetch('/api/admin/staff'),
  ])
  if (!availRes.ok) return parseErrorAndThrow(availRes)
  if (!staffRes.ok) return parseErrorAndThrow(staffRes)

  const availBody = (await availRes.json()) as { staff: { id: number; name?: string }[] }
  const allStaff = (await staffRes.json()) as { id: number; name: string }[]
  const nameById = new Map(allStaff.map((s) => [s.id, s.name]))

  return availBody.staff.map((s) => ({ id: s.id, name: s.name ?? nameById.get(s.id) ?? `KTV #${s.id}` }))
}

/**
 * `POST /api/admin/walk-ins` — tạo appointment khách vãng lai,
 * `status='in_service'`, `start_at=now`. Bỏ trống cả tên và SĐT → "Khách lẻ".
 */
export async function createWalkIn(input: {
  variantId: number
  staffId: number
  name?: string
  phone?: string
}): Promise<WalkInResult> {
  const res = await fetch('/api/admin/walk-ins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      variant_id: input.variantId,
      staff_id: input.staffId,
      customer: { name: input.name, phone: input.phone },
    }),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as WalkInResult
}
