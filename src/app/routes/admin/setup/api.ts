// Fetch helpers cho màn Thiết lập admin (T-17). 19 endpoint thật đã có ở
// src/worker/routes/admin-crud.ts (T-06) — file này chỉ gọi, không tự đoán
// hình dạng (đối chiếu code thật khi viết, không chỉ đọc tóm tắt trong card).
//
// Mọi lỗi từ server có hình dạng { error: { code, message } } (CONVENTIONS
// §5) — ném ApiError giữ nguyên `code`, đúng mẫu src/app/lib/apiClient.ts và
// src/app/routes/admin/timeline/api.ts.
//
// LƯU Ý: file này KHÔNG được đặt ở src/app/api/ — thư mục đó bị Worker nuốt
// (run_worker_first: ["/api/*"] khớp theo tiền tố URL dev, không phải theo
// đường dẫn file, nhưng để an toàn tuyệt đối mọi helper fetch của SPA nằm ở
// src/app/lib/ hoặc trong route con như ở đây — xem CONVENTIONS §7).

export type BodyZone = 'hair' | 'hands' | 'feet' | 'face' | 'body'

export interface Skill {
  id: number
  name: string
}

export interface Staff {
  id: number
  name: string
  phone: string | null
  active: number
}

export interface Service {
  id: number
  name: string
  skill_id: number
  body_zone: BodyZone
  active: number
}

export interface ServiceVariant {
  id: number
  service_id: number
  name: string
  duration_min: number
  buffer_after_min: number
  price: number
  active: number
}

export interface WorkShift {
  id: number
  staff_id: number
  weekday: number
  start_min: number
  end_min: number
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}

export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function parseErrorAndThrow(res: Response): Promise<never> {
  let body: Partial<ApiErrorBody> = {}
  try {
    body = (await res.json()) as Partial<ApiErrorBody>
  } catch {
    // body không phải JSON hợp lệ — vẫn ném lỗi chung, không để crash im lặng.
  }
  throw new ApiError(body.error?.code ?? 'UNKNOWN', body.error?.message ?? 'Có lỗi xảy ra', res.status)
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as T
}

async function sendJson<T>(url: string, method: 'POST' | 'PATCH', payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) return parseErrorAndThrow(res)
  return (await res.json()) as T
}

async function sendDelete(url: string): Promise<void> {
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok) return parseErrorAndThrow(res)
}

// ---------- Skills ----------

export const getSkills = (): Promise<Skill[]> => getJson('/api/admin/skills')

export const createSkill = (name: string): Promise<Skill> =>
  sendJson('/api/admin/skills', 'POST', { name })

export const deleteSkill = (id: number): Promise<void> => sendDelete(`/api/admin/skills/${id}`)

// ---------- Staff ----------

export const getStaff = (): Promise<Staff[]> => getJson('/api/admin/staff')

export const createStaff = (name: string, phone: string | null): Promise<Staff> =>
  sendJson('/api/admin/staff', 'POST', { name, phone })

export const updateStaff = (
  id: number,
  patch: { name?: string; phone?: string | null; active?: boolean },
): Promise<Staff> => sendJson(`/api/admin/staff/${id}`, 'PATCH', patch)

/** Skill IDs hiện gán cho một nhân viên — để mở sheet với đúng ô đã tick,
 * thay vì dựng trạng thái mù theo thao tác. Backend bổ sung endpoint đọc này
 * sau T-06 (ban đầu chỉ có write). */
export const getStaffSkillIds = (staffId: number): Promise<number[]> =>
  getJson<{ skill_ids: number[] }>(`/api/admin/staff/${staffId}/skills`).then((r) => r.skill_ids)

export const assignSkillToStaff = (staffId: number, skillId: number): Promise<void> =>
  sendJson(`/api/admin/staff/${staffId}/skills`, 'POST', { skill_id: skillId })

export const unassignSkillFromStaff = (staffId: number, skillId: number): Promise<void> =>
  sendDelete(`/api/admin/staff/${staffId}/skills/${skillId}`)

// ---------- Services ----------

export const getServices = (): Promise<Service[]> => getJson('/api/admin/services')

export const createService = (name: string, skillId: number, bodyZone: BodyZone): Promise<Service> =>
  sendJson('/api/admin/services', 'POST', { name, skill_id: skillId, body_zone: bodyZone })

export const updateService = (
  id: number,
  patch: { name?: string; skill_id?: number; body_zone?: BodyZone; active?: boolean },
): Promise<Service> => sendJson(`/api/admin/services/${id}`, 'PATCH', patch)

// ---------- Variants ----------

export const getVariants = (): Promise<ServiceVariant[]> => getJson('/api/admin/variants')

export const createVariant = (input: {
  service_id: number
  name: string
  duration_min: number
  buffer_after_min: number
  price: number
}): Promise<ServiceVariant> => sendJson('/api/admin/variants', 'POST', input)

export const updateVariant = (
  id: number,
  patch: Partial<{
    name: string
    duration_min: number
    buffer_after_min: number
    price: number
    active: boolean
  }>,
): Promise<ServiceVariant> => sendJson(`/api/admin/variants/${id}`, 'PATCH', patch)

// ---------- Shifts ----------

export const getShifts = (): Promise<WorkShift[]> => getJson('/api/admin/shifts')

export const createShift = (input: {
  staff_id: number
  weekday: number
  start_min: number
  end_min: number
}): Promise<WorkShift> => sendJson('/api/admin/shifts', 'POST', input)

export const updateShift = (
  id: number,
  patch: Partial<{ staff_id: number; weekday: number; start_min: number; end_min: number }>,
): Promise<WorkShift> => sendJson(`/api/admin/shifts/${id}`, 'PATCH', patch)

export const deleteShift = (id: number): Promise<void> => sendDelete(`/api/admin/shifts/${id}`)
