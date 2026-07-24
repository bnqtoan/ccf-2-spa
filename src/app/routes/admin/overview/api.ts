// Fetch helpers cho màn /admin/overview (Track C — R5 lấp đầy + R2 doanh
// thu/lương). Chỉ gọi endpoint thật ở src/worker/routes/admin-overview.ts,
// không tự đoán hình dạng. Mọi lỗi server có dạng { error: { code, message } }
// (CONVENTIONS §5) — giữ nguyên mẫu ApiError của các route con khác.

export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    let body: Partial<ApiErrorBody> = {}
    try {
      body = (await res.json()) as Partial<ApiErrorBody>
    } catch {
      // body không phải JSON — vẫn ném lỗi chung, không crash im lặng.
    }
    throw new ApiError(
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? 'Có lỗi xảy ra',
      res.status,
    )
  }
  return (await res.json()) as T
}

export interface BusyInterval {
  start_at: number
  end_at: number
}

export interface OverviewStaff {
  id: number
  name: string
  commission_rate: number
  revenue: number
  done_count: number
  /** null = không tính được (KTV nghỉ cả ngày hoặc không có ca hôm đó). */
  occupancy_pct: number | null
  available_min: number
  busy_min: number
  has_shift: boolean
  on_leave: boolean
  busy_intervals: BusyInterval[]
}

export interface OverviewKpi {
  revenue: number
  done_count: number
  occupancy_pct: number | null
  no_show_count: number
}

export interface OverviewResponse {
  date: string
  kpi: OverviewKpi
  staff: OverviewStaff[]
}

export type Period = 'day' | 'week' | 'month'

export interface StaffEarnings {
  staff_id: number
  name: string
  period: Period
  period_start: number
  period_end: number
  revenue: number
  done_count: number
  commission_rate: number
  payroll: number
}

export const getOverview = (date: string): Promise<OverviewResponse> =>
  getJson(`/api/admin/overview?date=${encodeURIComponent(date)}`)

export const getStaffEarnings = (
  staffId: number,
  period: Period,
  date: string,
): Promise<StaffEarnings> =>
  getJson(
    `/api/admin/staff-earnings?staff_id=${staffId}&period=${period}&date=${encodeURIComponent(date)}`,
  )
