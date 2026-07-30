import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AdminNav from '../../../components/AdminNav'
import Button from '../../../components/Button'
import EmptyState from '../../../components/EmptyState'
import Field from '../../../components/Field'
import Notice from '../../../components/Notice'
import Sheet from '../../../components/Sheet'
import { useSession } from '../../../lib/useSession'
import {
  addAppointmentItem,
  ApiError,
  createAdminBooking,
  createTimeOff,
  getAvailability,
  getReassignQueue,
  getSchedule,
  getScheduleRange,
  getServices,
  rescheduleBooking,
  setBookingStatus,
  type AffectedItem,
  type AvailabilitySlot,
  type ScheduleItem,
  type ScheduleRangeDay,
  type ScheduleResponse,
  type ScheduleStaff,
  type Service,
} from './api'
import { addDays, formatDateNav, formatHm, minutesOfLocalDay, toDateStr } from './format'
import './timeline.css'

// Việt Nam cố định UTC+7, không có DST (đã dùng đúng giả định này ở
// tests/e2e/flows/helpers.ts). Quy đổi (ngày spa + HH:mm) -> epoch giây.
const SPA_UTC_OFFSET_SEC = 7 * 60 * 60

function localDateHmToEpoch(dateStr: string, hh: number, mm: number): number {
  const parts = dateStr.split('-').map(Number)
  const y = parts[0] ?? 0
  const m = parts[1] ?? 1
  const d = parts[2] ?? 1
  return Date.UTC(y, m - 1, d, hh, mm, 0) / 1000 - SPA_UTC_OFFSET_SEC
}

// T-31: week view — 7 ngày Thứ Hai→Chủ Nhật chứa `date` đang xem trên day view
// (day↔week giữ nguyên context, card mục "Chuyển qua lại day ↔ week giữ
// nguyên context"). `format.ts` KHÔNG nằm trong touches của card này nên các
// hàm ngày-giờ dưới đây thuần cục bộ trong file, dùng lại đúng convention
// UTC-noon-anchor mà `addDays`/`toDateStr` của format.ts đã dùng.
function weekdayMonFirst(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const jsDay = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay() // 0=CN..6=T7
  return (jsDay + 6) % 7 // 0=T2..6=CN
}

/** Thứ Hai của tuần chứa `dateStr`. */
function startOfWeek(dateStr: string): string {
  return addDays(dateStr, -weekdayMonFirst(dateStr))
}

const WEEKDAY_VN_FULL = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật']

/** "Thứ Hai · 21/07" — nhãn cột ngày trong lưới tuần. */
function formatWeekColLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${WEEKDAY_VN_FULL[weekdayMonFirst(dateStr)]} · ${pad(d ?? 0)}/${pad(m ?? 0)}`
}

// Chiều cao một hàng-giờ trên lưới, tính bằng px (đúng prototype dòng 271:
// `.tlcell{height:52px}`). Mọi phép tính top/height của block đều dựa vào
// hằng số này.
const ROW_HEIGHT_PX = 52
// Ngưỡng "block ngắn": chiều cao render dưới mức này thì không đủ chỗ cho 2
// dòng chữ (prototype dòng 775: `hgt<44?' short':''`). Tính theo PIXEL THỰC
// TẾ render ra — không hard-code theo số phút dịch vụ (cạm bẫy card đã nêu).
const SHORT_BLOCK_THRESHOLD_PX = 44

const STATUS_LABEL: Record<string, string> = {
  booked: 'Đã đặt',
  in_service: 'Đang làm',
  done: 'Xong',
  no_show: 'Khách không đến',
}

function statusClass(isOrphan: boolean, status: string, source: string): string {
  if (isOrphan) return 'ccf-tl-ev--orphan'
  if (status === 'in_service') return 'ccf-tl-ev--in_service'
  if (source === 'walk_in') return 'ccf-tl-ev--walk_in'
  return 'ccf-tl-ev--booked'
}

/** Dịch mã lỗi từ reschedule (endpoint nguyên tử T-24) sang câu tiếng Việt
 * thân thiện cho lễ tân — KHÔNG lộ mã lỗi thô. Dùng chung cho cả nút "Đổi giờ"
 * trong sheet lẫn thao tác kéo-thả block (card: surface SLOT_TAKEN /
 * CANCEL_TOO_LATE ... thành câu tiếng Việt). */
function rescheduleErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'SLOT_TAKEN':
        return 'Khung giờ này vừa có người đặt mất. Vui lòng chọn giờ hoặc kỹ thuật viên khác.'
      case 'CANCEL_TOO_LATE':
        return 'Chỉ còn dưới 2 tiếng trước giờ hẹn, không đổi được — vui lòng gọi trực tiếp để sắp lại.'
      case 'STAFF_LACKS_SKILL':
        return 'Kỹ thuật viên này không có kỹ năng của dịch vụ đang đặt.'
      case 'OUTSIDE_SHIFT':
        return 'Khoảng giờ này không nằm trong ca làm việc của kỹ thuật viên.'
      case 'INVALID_TRANSITION':
        return 'Lịch này không còn ở trạng thái đổi được (đã bắt đầu/đã xong/đã huỷ).'
      case 'VALIDATION':
        return err.message
      default:
        return err.message
    }
  }
  return 'Không đổi được lịch. Vui lòng thử lại.'
}

/** Khoảng giờ hiển thị trên lưới: bao trọn mọi item + time_off, cộng thêm 1
 * giờ ở cuối để một booking bắt đầu ở phút cuối giờ không bị cắt cụt
 * (nguyên tắc prototype dòng 738: "one extra hour so a booking starting at
 * 18:xx is not clipped"). Có sàn/trần mặc định 8h-20h để timeline không quá
 * hẹp khi ngày trống lịch.
 */
function computeHourRange(staff: ScheduleStaff[]): { firstHour: number; lastHour: number } {
  let minMinute = 8 * 60
  let maxMinute = 20 * 60
  for (const s of staff) {
    for (const item of s.items) {
      minMinute = Math.min(minMinute, minutesOfLocalDay(item.start_at))
      maxMinute = Math.max(maxMinute, minutesOfLocalDay(item.block_end_at))
    }
    for (const off of s.time_off) {
      minMinute = Math.min(minMinute, minutesOfLocalDay(off.start_at))
      maxMinute = Math.max(maxMinute, minutesOfLocalDay(off.end_at))
    }
  }
  const firstHour = Math.floor(minMinute / 60)
  const lastHour = Math.ceil(maxMinute / 60) // +1 giờ đệm tự nhiên từ ceil
  return { firstHour, lastHour }
}

interface PositionedBlock {
  top: number
  height: number
  bufferHeight: number
}

/** top/height theo phút, quy đổi ra px theo ROW_HEIGHT_PX — công thức giống
 * hệt prototype: `top = (start - hourStart)/60 * rowHeight`. */
function positionItem(item: ScheduleItem, gridStartMinute: number): PositionedBlock {
  const startMin = minutesOfLocalDay(item.start_at)
  const blockEndMin = minutesOfLocalDay(item.block_end_at)
  const bufferMin = Math.max(0, minutesOfLocalDay(item.block_end_at) - minutesOfLocalDay(item.end_at))
  const top = ((startMin - gridStartMinute) / 60) * ROW_HEIGHT_PX
  const height = ((blockEndMin - startMin) / 60) * ROW_HEIGHT_PX
  const bufferHeight = (bufferMin / 60) * ROW_HEIGHT_PX
  return { top, height, bufferHeight }
}

export default function TimelinePage() {
  const todayStr = useMemo(() => toDateStr(Math.floor(Date.now() / 1000)), [])
  const [date, setDate] = useState(todayStr)
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null)
  const [orphanIds, setOrphanIds] = useState<Set<number>>(new Set())
  const [queueCount, setQueueCount] = useState(0)
  // T-31: toggle Day/Week trên qbar. Week KHÔNG có drag/tạo (card "Ngoài") —
  // chỉ đọc, để trả lời câu hỏi lấp-đầy. Đổi ngày ở day view giữ nguyên tuần
  // chứa nó khi bật Week (context giữ nguyên qua lại).
  const [viewMode, setViewMode] = useState<'day' | 'week'>('day')
  const [weekDays, setWeekDays] = useState<ScheduleRangeDay[] | null>(null)
  const [weekLoading, setWeekLoading] = useState(false)
  const [weekError, setWeekError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const navigate = useNavigate()
  const { role } = useSession()
  // T-25: nút "+ Thêm dịch vụ" là thao tác vận hành — owner + lễ tân, KHÔNG
  // technician (card RBAC T-22). Ẩn ở UI là defense-in-depth (server gate ở
  // T-28); server hiện CHƯA gate route này — ghi nhận, không tự sửa ở card này.
  const canAddService = role === 'owner' || role === 'receptionist'

  // G1: "Báo nghỉ" — bấm tên KTV ở đầu cột để mở. Chọn khoảng giờ trong NGÀY
  // đang xem, xác nhận -> POST /api/admin/time-off -> hiện ngay các lịch bị ảnh
  // hưởng (chúng chảy vào hàng chờ xếp lại). Time-off KHÔNG tự huỷ lịch (PRD §8).
  const [timeOffStaff, setTimeOffStaff] = useState<{ id: number; name: string } | null>(null)
  const [offStart, setOffStart] = useState('09:00')
  const [offEnd, setOffEnd] = useState('12:00')
  const [offReason, setOffReason] = useState('')
  const [offSubmitting, setOffSubmitting] = useState(false)
  const [offError, setOffError] = useState<string | null>(null)
  const [offAffected, setOffAffected] = useState<AffectedItem[] | null>(null)

  // T-25: "+ Thêm dịch vụ" trong sheet booking — dựng UI cho backend ĐÃ CÓ
  // (POST /api/admin/appointments/:id/items, admin-appointment-items.ts,
  // KHÔNG sửa). Luồng: chọn dịch vụ -> gói -> giờ (slot của NGÀY đang xem
  // trên timeline) -> KTV rảnh trong slot đó -> submit.
  const [addServiceOpen, setAddServiceOpen] = useState(false)
  const [addServices, setAddServices] = useState<Service[] | null>(null)
  const [addLoadError, setAddLoadError] = useState<string | null>(null)
  const [addServiceId, setAddServiceId] = useState<number | null>(null)
  const [addVariantId, setAddVariantId] = useState<number | null>(null)
  const [addSlots, setAddSlots] = useState<AvailabilitySlot[] | null>(null)
  const [addSlotsLoading, setAddSlotsLoading] = useState(false)
  const [addSlotsError, setAddSlotsError] = useState<string | null>(null)
  const [addStartAt, setAddStartAt] = useState<number | null>(null)
  const [addStaffId, setAddStaffId] = useState<number | null>(null)
  const [addSaving, setAddSaving] = useState(false)
  const [addSaveError, setAddSaveError] = useState<string | null>(null)

  // T-29: "Tạo lịch ngay trên timeline" (G1/G2) — bấm một Ô TRỐNG (KTV × giờ)
  // hoặc nút "+ Đặt lịch" trên qbar -> sheet đặt lịch, prefill sẵn KTV của
  // cột và giờ của dòng vừa bấm (sửa được cả hai). Ghi qua ĐÚNG write-path đã
  // có (POST /api/admin/bookings, source='admin', status='booked') — KHÔNG
  // validate slot/skill/shift mới ở đây (card cạm bẫy #1).
  const [createOpen, setCreateOpen] = useState(false)
  const [createServices, setCreateServices] = useState<Service[] | null>(null)
  const [createLoadError, setCreateLoadError] = useState<string | null>(null)
  const [createServiceId, setCreateServiceId] = useState<number | null>(null)
  const [createVariantId, setCreateVariantId] = useState<number | null>(null)
  const [createStaffId, setCreateStaffId] = useState<number | null>(null)
  const [createTime, setCreateTime] = useState('09:00')
  const [createName, setCreateName] = useState('')
  const [createPhone, setCreatePhone] = useState('')
  const [createSaving, setCreateSaving] = useState(false)
  const [createSaveError, setCreateSaveError] = useState<string | null>(null)

  // T-30: đổi GIỜ / đổi KTV cho lịch bình thường (G1/G3) — hai lối vào cùng
  // dùng MỘT reschedule nguyên tử (rescheduleBooking → POST /api/bookings/:id/
  // reschedule, T-24). KHÔNG viết endpoint mới, KHÔNG cancel+book ở client.
  //
  // (a) Nút "Đổi giờ / Đổi KTV" trong sheet chi tiết → sheet chọn giờ + KTV mới.
  const [rescheduleItem, setRescheduleItem] = useState<ScheduleItem | null>(null)
  const [rsTime, setRsTime] = useState('09:00')
  const [rsStaffId, setRsStaffId] = useState<number | null>(null)
  const [rsSaving, setRsSaving] = useState(false)
  const [rsError, setRsError] = useState<string | null>(null)

  // (b) Kéo-thả block sang cột KTV khác / dòng giờ khác → hộp xác nhận nhẹ →
  // reschedule. `dragItemId` là item đang kéo; `dropTarget` là ô đích khi thả.
  const [dragItemId, setDragItemId] = useState<number | null>(null)
  const [dropConfirm, setDropConfirm] = useState<{
    item: ScheduleItem
    fromStaffName: string
    toStaffId: number
    toStaffName: string
    hour: number
  } | null>(null)
  const [dropSaving, setDropSaving] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)

  function openReschedule(item: ScheduleItem) {
    setRescheduleItem(item)
    setRsTime(formatHm(item.start_at))
    setRsStaffId(null) // mặc định giữ KTV cũ; chọn KTV khác nếu muốn đổi người
    setRsError(null)
  }

  function closeReschedule() {
    setRescheduleItem(null)
    setRsError(null)
  }

  async function handleRescheduleSubmit() {
    if (rescheduleItem === null) return
    const time = parseHm(rsTime)
    if (time === null) {
      setRsError('Giờ không hợp lệ. Nhập theo dạng HH:mm, ví dụ 13:30.')
      return
    }
    setRsSaving(true)
    setRsError(null)
    try {
      const startAt = localDateHmToEpoch(date, time.hh, time.mm)
      // staff_id chỉ gửi khi lễ tân CHỌN đổi sang người khác; không chọn = giữ
      // KTV cũ (server hiểu staff_id undefined = giữ nguyên).
      const staffId = rsStaffId ?? undefined
      await rescheduleBooking(rescheduleItem.id, startAt, staffId)
      setRescheduleItem(null)
      setSelectedItemId(null)
      // Block chuyển đúng vị trí mới NGAY (card: reload grid sau thành công).
      await loadAll()
    } catch (err) {
      setRsError(rescheduleErrorMessage(err))
    } finally {
      setRsSaving(false)
    }
  }

  /** Thả một block (draggedId) lên ô của KTV `toStaffId` ở dòng giờ `hour`.
   * Không gọi API ngay: mở hộp xác nhận nhẹ (card: "xác nhận nhẹ → reschedule")
   * để lễ tân khỏi kéo nhầm. Việc gọi reschedule nguyên tử nằm ở confirmDrop. */
  function handleBlockDrop(draggedId: number, toStaffId: number, toStaffName: string, hour: number) {
    setDragItemId(null)
    if (!Number.isInteger(draggedId) || schedule === null) return
    let found: { item: ScheduleItem; fromStaffId: number; fromStaffName: string } | null = null
    for (const s of schedule.staff) {
      const it = s.items.find((i) => i.id === draggedId)
      if (it) {
        found = { item: it, fromStaffId: s.id, fromStaffName: s.name }
        break
      }
    }
    if (found === null) return
    // Thả đúng chỗ cũ (cùng KTV + cùng giờ bắt đầu) → không làm gì.
    if (found.fromStaffId === toStaffId && minutesOfLocalDay(found.item.start_at) === hour * 60) return
    setDropError(null)
    setDropConfirm({
      item: found.item,
      fromStaffName: found.fromStaffName,
      toStaffId,
      toStaffName,
      hour,
    })
  }

  async function confirmDrop() {
    if (dropConfirm === null) return
    setDropSaving(true)
    setDropError(null)
    try {
      const startAt = localDateHmToEpoch(date, dropConfirm.hour, 0)
      // Đổi cả giờ (hour:00 của dòng đích) lẫn KTV (cột đích) trong MỘT lần gọi
      // nguyên tử. Giữ KTV cũ vẫn gửi staff_id đích (== KTV cũ) — vô hại.
      await rescheduleBooking(dropConfirm.item.id, startAt, dropConfirm.toStaffId)
      setDropConfirm(null)
      setDragItemId(null)
      await loadAll()
    } catch (err) {
      setDropError(rescheduleErrorMessage(err))
    } finally {
      setDropSaving(false)
    }
  }

  function ensureCreateServicesLoaded() {
    if (createServices === null) {
      setCreateLoadError(null)
      getServices()
        .then(setCreateServices)
        .catch(() => setCreateLoadError('Không tải được danh mục dịch vụ. Vui lòng thử lại.'))
    }
  }

  /** Nút "+ Đặt lịch" trên qbar — không prefill KTV/giờ cụ thể. */
  function openCreateBooking() {
    setCreateStaffId(null)
    setCreateTime('09:00')
    setCreateServiceId(null)
    setCreateVariantId(null)
    setCreateName('')
    setCreatePhone('')
    setCreateSaveError(null)
    setCreateOpen(true)
    ensureCreateServicesLoaded()
  }

  /** Bấm một ô trống trên lưới (KTV × giờ) — prefill đúng cột + đúng giờ. */
  function openCreateBookingAt(staffId: number, hour: number) {
    setCreateStaffId(staffId)
    setCreateTime(`${String(hour).padStart(2, '0')}:00`)
    setCreateServiceId(null)
    setCreateVariantId(null)
    setCreateName('')
    setCreatePhone('')
    setCreateSaveError(null)
    setCreateOpen(true)
    ensureCreateServicesLoaded()
  }

  function closeCreateBooking() {
    setCreateOpen(false)
  }

  function handleCreateServiceChange(rawId: string) {
    const id = rawId === '' ? null : Number(rawId)
    setCreateServiceId(id)
    setCreateVariantId(null)
  }

  function handleCreateVariantChange(rawId: string) {
    const id = rawId === '' ? null : Number(rawId)
    setCreateVariantId(id)
  }

  async function handleCreateBookingSubmit() {
    const time = parseHm(createTime)
    if (createVariantId === null || createStaffId === null || time === null || createName.trim() === '') return
    setCreateSaving(true)
    setCreateSaveError(null)
    try {
      const startAt = localDateHmToEpoch(date, time.hh, time.mm)
      await createAdminBooking({
        name: createName.trim(),
        phone: createPhone.trim() || undefined,
        variant_id: createVariantId,
        staff_id: createStaffId,
        start_at: startAt,
      })
      setCreateOpen(false)
      // Block hiện ngay trên timeline (card: "sau khi tạo, hiện ngay").
      await loadAll()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SLOT_TAKEN') {
        setCreateSaveError('Khung giờ này vừa có người đặt mất. Vui lòng chọn giờ hoặc kỹ thuật viên khác.')
      } else if (err instanceof ApiError && err.code === 'STAFF_LACKS_SKILL') {
        setCreateSaveError('Kỹ thuật viên này không có kỹ năng của dịch vụ đã chọn.')
      } else if (err instanceof ApiError && err.code === 'OUTSIDE_SHIFT') {
        setCreateSaveError('Khoảng giờ này không nằm trong ca làm việc của kỹ thuật viên.')
      } else if (err instanceof ApiError) {
        setCreateSaveError(err.message)
      } else {
        setCreateSaveError('Không tạo được lịch. Vui lòng thử lại.')
      }
    } finally {
      setCreateSaving(false)
    }
  }

  function openAddService() {
    setAddServiceOpen(true)
    setAddServiceId(null)
    setAddVariantId(null)
    setAddSlots(null)
    setAddSlotsError(null)
    setAddStartAt(null)
    setAddStaffId(null)
    setAddSaveError(null)
    if (addServices === null) {
      setAddLoadError(null)
      getServices()
        .then(setAddServices)
        .catch(() => setAddLoadError('Không tải được danh mục dịch vụ. Vui lòng thử lại.'))
    }
  }

  function closeAddService() {
    setAddServiceOpen(false)
  }

  function handleAddServiceChange(rawId: string) {
    const id = rawId === '' ? null : Number(rawId)
    setAddServiceId(id)
    setAddVariantId(null)
    setAddSlots(null)
    setAddStartAt(null)
    setAddStaffId(null)
  }

  function handleAddVariantChange(rawId: string) {
    const id = rawId === '' ? null : Number(rawId)
    setAddVariantId(id)
    setAddStartAt(null)
    setAddStaffId(null)
  }

  function pickAddSlot(startAt: number) {
    setAddStartAt(startAt)
    setAddStaffId(null)
  }

  async function handleAddServiceSubmit() {
    if (selectedItem === null || addVariantId === null || addStartAt === null || addStaffId === null) return
    setAddSaving(true)
    setAddSaveError(null)
    try {
      await addAppointmentItem(selectedItem.item.appointment_id, {
        variant_id: addVariantId,
        staff_id: addStaffId,
        start_at: addStartAt,
      })
      setAddServiceOpen(false)
      // Reload lịch để item mới hiện ngay trên timeline (card: KHÔNG chỉ đóng sheet).
      await loadAll()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ZONE_CONFLICT') {
        setAddSaveError('Dịch vụ này trùng vùng cơ thể với dịch vụ đang làm, chọn dịch vụ khác.')
      } else if (err instanceof ApiError && err.code === 'SLOT_TAKEN') {
        setAddSaveError('Khung giờ này vừa bị chiếm mất. Vui lòng chọn giờ hoặc kỹ thuật viên khác.')
      } else if (err instanceof ApiError) {
        setAddSaveError(err.message)
      } else {
        setAddSaveError('Không thêm được dịch vụ. Vui lòng thử lại.')
      }
    } finally {
      setAddSaving(false)
    }
  }

  function openTimeOff(s: { id: number; name: string }) {
    setTimeOffStaff(s)
    setOffStart('09:00')
    setOffEnd('12:00')
    setOffReason('')
    setOffError(null)
    setOffAffected(null)
  }

  function closeTimeOff() {
    setTimeOffStaff(null)
    setOffAffected(null)
    setOffError(null)
  }

  function parseHm(v: string): { hh: number; mm: number } | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
    if (!m) return null
    const hh = Number(m[1])
    const mm = Number(m[2])
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
    return { hh, mm }
  }

  async function handleSubmitTimeOff() {
    if (timeOffStaff === null) return
    setOffError(null)
    const start = parseHm(offStart)
    const end = parseHm(offEnd)
    if (start === null || end === null) {
      setOffError('Giờ không hợp lệ. Nhập theo dạng HH:mm, ví dụ 13:30.')
      return
    }
    const startAt = localDateHmToEpoch(date, start.hh, start.mm)
    const endAt = localDateHmToEpoch(date, end.hh, end.mm)
    if (startAt >= endAt) {
      setOffError('Giờ bắt đầu phải trước giờ kết thúc.')
      return
    }
    setOffSubmitting(true)
    try {
      const { affected_items } = await createTimeOff({
        staff_id: timeOffStaff.id,
        start_at: startAt,
        end_at: endAt,
        reason: offReason.trim() || null,
      })
      setOffAffected(affected_items)
      // Lịch nghỉ mới có thể khiến các item thành mồ côi — tải lại timeline +
      // hàng chờ để cột hiện khối nghỉ và banner cập nhật số.
      await loadAll()
    } catch (err) {
      if (err instanceof ApiError) {
        setOffError(err.message)
      } else {
        setOffError('Không ghi được lịch nghỉ. Vui lòng thử lại.')
      }
    } finally {
      setOffSubmitting(false)
    }
  }

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [scheduleRes, queueItems] = await Promise.all([getSchedule(date), getReassignQueue()])
      setSchedule(scheduleRes)
      // Nguồn sự thật DUY NHẤT cho "item nào là mồ côi" là reassign-queue —
      // không tự suy luận lại bằng cách so start_at với time_off ở đây
      // (PRD §8, nhắc lại trong card T-12).
      setOrphanIds(new Set(queueItems.map((q) => q.item_id)))
      setQueueCount(queueItems.length)
    } catch {
      setError('Không tải được lịch. Vui lòng thử lại.')
    } finally {
      setLoading(false)
    }
  }

  // T-31: MỘT request range cho cả 7 ngày (cạm bẫy card: đừng gọi 7 lần tuần
  // tự). Tuần luôn là Thứ Hai→Chủ Nhật chứa `date` hiện tại (giữ context day↔week).
  const weekStart = useMemo(() => startOfWeek(date), [date])
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart])

  async function loadWeek() {
    setWeekLoading(true)
    setWeekError(null)
    try {
      const res = await getScheduleRange(weekStart, weekEnd)
      setWeekDays(res.days)
    } catch {
      setWeekError('Không tải được lịch tuần. Vui lòng thử lại.')
    } finally {
      setWeekLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  useEffect(() => {
    if (viewMode !== 'week') return
    loadWeek()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, weekStart, weekEnd])

  // T-25: mỗi khi đã chọn gói xong, tải slot còn trống trong NGÀY đang xem
  // trên timeline (không phải "bây giờ" — khác walk-in). variant_id thay đổi
  // hoặc ngày đổi trong lúc sheet mở đều tải lại.
  useEffect(() => {
    if (addVariantId === null) {
      setAddSlots(null)
      return
    }
    let cancelled = false
    setAddSlotsLoading(true)
    setAddSlotsError(null)
    setAddStartAt(null)
    setAddStaffId(null)
    getAvailability(addVariantId, date)
      .then((rows) => {
        if (!cancelled) setAddSlots(rows)
      })
      .catch(() => {
        if (!cancelled) setAddSlotsError('Không tải được khung giờ. Vui lòng thử lại.')
      })
      .finally(() => {
        if (!cancelled) setAddSlotsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [addVariantId, date])

  const selectedItem: { item: ScheduleItem; staffName: string } | null = useMemo(() => {
    if (selectedItemId === null || schedule === null) return null
    for (const s of schedule.staff) {
      const item = s.items.find((i) => i.id === selectedItemId)
      if (item) return { item, staffName: s.name }
    }
    return null
  }, [selectedItemId, schedule])

  async function handleSetStatus(status: 'in_service' | 'done' | 'no_show') {
    if (selectedItemId === null) return
    setStatusError(null)
    try {
      await setBookingStatus(selectedItemId, status)
      // Cập nhật ngay trên timeline không cần tải lại trang: patch tại chỗ,
      // rồi refresh hàng chờ reassign phòng khi transition ảnh hưởng nó.
      setSchedule((prev) => {
        if (prev === null) return prev
        return {
          ...prev,
          staff: prev.staff.map((s) => ({
            ...s,
            items: s.items.map((i) => (i.id === selectedItemId ? { ...i, status } : i)),
          })),
        }
      })
      setSelectedItemId(null)
      getReassignQueue()
        .then((items) => {
          setOrphanIds(new Set(items.map((q) => q.item_id)))
          setQueueCount(items.length)
        })
        .catch(() => {
          // Danh sách hàng chờ không refresh được — banner giữ số cũ, không chặn thao tác chính.
        })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_TRANSITION') {
        setStatusError('Không thể chuyển sang trạng thái này từ trạng thái hiện tại.')
      } else {
        setStatusError('Không cập nhật được trạng thái. Vui lòng thử lại.')
      }
    }
  }

  if (loading && schedule === null) {
    return (
      <div className="ccf-tl-page">
        <AdminNav />
        <p>Đang tải lịch...</p>
      </div>
    )
  }

  if (error && schedule === null) {
    return (
      <div className="ccf-tl-page">
        <AdminNav />
        <Notice tone="warn">{error}</Notice>
        <Button variant="ghost" onClick={loadAll}>
          Thử lại
        </Button>
      </div>
    )
  }

  const staff = schedule?.staff ?? []
  const { firstHour, lastHour } = computeHourRange(staff)
  const hours: number[] = []
  for (let h = firstHour; h <= lastHour; h++) hours.push(h)
  const gridStartMinute = firstHour * 60

  return (
    <div className="ccf-tl-page">
      <AdminNav />
      {queueCount > 0 && (
        <div className="ccf-tl-banner" data-testid="reassign-banner">
          <div className="ccf-tl-banner-ic" aria-hidden="true">
            ⚠️
          </div>
          <div style={{ flex: 1 }}>
            <div className="ccf-tl-banner-title">{queueCount} lịch hẹn cần xếp lại kỹ thuật viên</div>
            <div className="ccf-tl-banner-body">
              Có kỹ thuật viên nghỉ đột xuất. Khách vẫn đang chờ — cần gọi báo và chuyển sang bạn khác.
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            data-testid="reassign-banner-cta"
            onClick={() => navigate('/admin/reassign')}
          >
            Xử lý ngay
          </Button>
        </div>
      )}

      <div className="ccf-tl-qbar">
        <div className="ccf-tl-viewtoggle" role="group" aria-label="Chế độ xem">
          <button
            type="button"
            className={`ccf-tl-toggle-btn${viewMode === 'day' ? ' ccf-tl-toggle-btn--active' : ''}`}
            data-testid="view-toggle-day"
            aria-pressed={viewMode === 'day'}
            onClick={() => setViewMode('day')}
          >
            Ngày
          </button>
          <button
            type="button"
            className={`ccf-tl-toggle-btn${viewMode === 'week' ? ' ccf-tl-toggle-btn--active' : ''}`}
            data-testid="view-toggle-week"
            aria-pressed={viewMode === 'week'}
            onClick={() => setViewMode('week')}
          >
            Tuần
          </button>
        </div>

        {viewMode === 'day' ? (
          <div className="ccf-tl-datenav">
            <button
              type="button"
              aria-label="Ngày trước"
              data-testid="date-prev"
              onClick={() => setDate((d) => addDays(d, -1))}
            >
              ‹
            </button>
            <span className="ccf-tl-cur" data-testid="date-current">
              {formatDateNav(date, todayStr)}
            </span>
            <button
              type="button"
              aria-label="Ngày sau"
              data-testid="date-next"
              onClick={() => setDate((d) => addDays(d, 1))}
            >
              ›
            </button>
          </div>
        ) : (
          <div className="ccf-tl-datenav">
            <button
              type="button"
              aria-label="Tuần trước"
              data-testid="week-prev"
              onClick={() => setDate((d) => addDays(d, -7))}
            >
              ‹
            </button>
            <span className="ccf-tl-cur" data-testid="week-current">
              {formatWeekColLabel(weekStart)} – {formatWeekColLabel(weekEnd)}
            </span>
            <button
              type="button"
              aria-label="Tuần sau"
              data-testid="week-next"
              onClick={() => setDate((d) => addDays(d, 7))}
            >
              ›
            </button>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          data-testid="today-button"
          onClick={() => setDate(todayStr)}
        >
          Hôm nay
        </Button>

        <input
          type="date"
          className="ccf-tl-datepick"
          aria-label="Chọn ngày"
          data-testid="date-picker"
          value={date}
          onChange={(e) => {
            if (e.target.value !== '') setDate(e.target.value)
          }}
        />

        {canAddService && viewMode === 'day' && (
          <Button variant="primary" size="sm" data-testid="create-booking-open" onClick={openCreateBooking}>
            + Đặt lịch
          </Button>
        )}
      </div>

      {viewMode === 'week' ? (
        <WeekView
          weekDays={weekDays}
          loading={weekLoading}
          error={weekError}
          todayStr={todayStr}
          orphanIds={orphanIds}
          onPickDay={(d) => {
            setDate(d)
            setViewMode('day')
          }}
        />
      ) : staff.length === 0 ? (
        <EmptyState icon="🗓️" text="Không có kỹ thuật viên nào đang hoạt động." />
      ) : (
        <div className="ccf-tl">
          <div className="ccf-tl-grid" style={{ '--cols': staff.length } as React.CSSProperties}>
            <div className="ccf-tl-head" style={{ position: 'sticky', left: 0, zIndex: 3 }} />
            {staff.map((s) => (
              <button
                type="button"
                className="ccf-tl-head ccf-tl-head--btn"
                key={s.id}
                data-testid={`staff-head-${s.id}`}
                title={`Báo nghỉ cho ${s.name}`}
                onClick={() => openTimeOff({ id: s.id, name: s.name })}
              >
                {s.name}
                <span className="ccf-tl-head-hint" aria-hidden="true">
                  Báo nghỉ
                </span>
              </button>
            ))}

            {hours.map((h) =>
              [
                <div className="ccf-tl-hour" key={`hour-${h}`}>
                  {String(h).padStart(2, '0')}:00
                </div>,
                ...staff.map((s) => {
                  const hourStartMin = h * 60
                  const hourEndMin = (h + 1) * 60
                  const itemsInHour = s.items.filter((it) => {
                    const startMin = minutesOfLocalDay(it.start_at)
                    return startMin >= hourStartMin && startMin < hourEndMin
                  })
                  const offInHour = s.time_off.find((off) => {
                    const offStartMin = minutesOfLocalDay(off.start_at)
                    return offStartMin >= hourStartMin && offStartMin < hourEndMin
                  })

                  // Ô trống (không có booking, không có khối nghỉ trong giờ này) mở
                  // sheet đặt lịch prefill đúng cột (staff) + đúng giờ (hàng) vừa
                  // bấm (card: "click ô trống -> tạo object prefill"). Chỉ owner/
                  // lễ tân thấy được thao tác này ở UI — server vẫn là gate thật.
                  const isEmptyCell = itemsInHour.length === 0 && offInHour === undefined
                  const cellIsClickable = isEmptyCell && canAddService

                  // T-30: ô là ĐÍCH THẢ khi lễ tân đang kéo một block. Cho phép
                  // thả cả lên ô có/không có booking (giờ mới có thể chồng nhẹ
                  // block khác — server là trọng tài SLOT_TAKEN, không tự chặn ở
                  // client cho "dễ"). Chỉ owner/lễ tân (canAddService) mới thả được.
                  // Handler luôn gắn khi canAddService (KHÔNG gate theo dragItemId):
                  // gate theo dragItemId sẽ khiến ô CHƯA có onDragOver/onDrop ở lần
                  // render đầu của thao tác kéo (setDragItemId là async) → drop rơi.
                  const isDropHighlight = dragItemId !== null && canAddService

                  return (
                    <div
                      className={`ccf-tl-cell${cellIsClickable ? ' ccf-tl-cell--clickable' : ''}${
                        isDropHighlight ? ' ccf-tl-cell--droptarget' : ''
                      }`}
                      key={`cell-${h}-${s.id}`}
                      data-testid={`cell-${s.id}-${h}`}
                      onClick={cellIsClickable ? () => openCreateBookingAt(s.id, h) : undefined}
                      onDragOver={
                        canAddService
                          ? (e) => {
                              // preventDefault bắt buộc để ô trở thành vùng thả hợp lệ.
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'move'
                            }
                          : undefined
                      }
                      onDrop={
                        canAddService
                          ? (e) => {
                              e.preventDefault()
                              const raw = e.dataTransfer.getData('text/plain')
                              const draggedId = Number(raw)
                              if (Number.isInteger(draggedId) && draggedId > 0) {
                                handleBlockDrop(draggedId, s.id, s.name, h)
                              }
                            }
                          : undefined
                      }
                    >
                      {offInHour &&
                        (() => {
                          const startMin = minutesOfLocalDay(offInHour.start_at)
                          const endMin = minutesOfLocalDay(offInHour.end_at)
                          const top = ((startMin - hourStartMin) / 60) * ROW_HEIGHT_PX
                          const height = ((endMin - startMin) / 60) * ROW_HEIGHT_PX
                          return (
                            <div
                              className="ccf-tl-ev ccf-tl-ev--off"
                              data-testid={`time-off-${s.id}`}
                              style={{ top, height: Math.max(height - 2, 0), zIndex: 0 }}
                            >
                              <div className="ccf-tl-ev-name">Nghỉ đột xuất</div>
                              <div>từ {formatHm(offInHour.start_at)}</div>
                            </div>
                          )
                        })()}

                      {itemsInHour.map((item) => {
                        const isOrphan = orphanIds.has(item.id)
                        const { top, height, bufferHeight } = positionItem(item, hourStartMin)
                        const isShort = height < SHORT_BLOCK_THRESHOLD_PX
                        const cls = statusClass(isOrphan, item.status, item.source)
                        // T-30: chỉ lịch 'booked' mới KÉO đổi giờ/KTV được (giống
                        // luật server: chỉ 'booked' reschedule được → tránh cho lễ
                        // tân kéo cái đã bắt đầu/xong rồi nhận INVALID_TRANSITION).
                        // Và chỉ owner/lễ tân (canAddService); technician không kéo.
                        const isDraggable = canAddService && item.status === 'booked'
                        return (
                          <button
                            type="button"
                            key={item.id}
                            className={`ccf-tl-ev ${cls}${isShort ? ' ccf-tl-ev--short' : ''}${
                              isDraggable ? ' ccf-tl-ev--draggable' : ''
                            }`}
                            data-testid={`booking-item-${item.id}`}
                            data-status={item.status}
                            data-orphan={isOrphan ? 'true' : 'false'}
                            draggable={isDraggable}
                            onDragStart={
                              isDraggable
                                ? (e) => {
                                    e.dataTransfer.setData('text/plain', String(item.id))
                                    e.dataTransfer.effectAllowed = 'move'
                                    setDragItemId(item.id)
                                  }
                                : undefined
                            }
                            onDragEnd={isDraggable ? () => setDragItemId(null) : undefined}
                            style={{
                              top,
                              height: Math.max(height - 2, 0),
                              // Booking (đặc biệt mồ côi) luôn nổi lên trên khối nghỉ
                              // (z-index 0). Mồ côi ưu tiên cao nhất trong các block.
                              zIndex: isOrphan ? 3 : 2,
                            }}
                            onClick={() => setSelectedItemId(item.id)}
                          >
                            <div className="ccf-tl-ev-name">{item.customer_name}</div>
                            <div className="ccf-tl-ev-sv">{item.service_name}</div>
                            {bufferHeight > 0 && (
                              <div
                                className="ccf-tl-ev-buf"
                                data-testid={`buffer-${item.id}`}
                                style={{ height: bufferHeight }}
                              />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )
                }),
              ].flat(),
            )}
          </div>
        </div>
      )}

      {viewMode === 'day' && (
        <div className="ccf-tl-legend">
          <span>
            <i style={{ background: 'var(--g-100)', borderLeft: '3px solid var(--g-600)' }} />
            Đã đặt
          </span>
          <span>
            <i style={{ background: '#dbeafe', borderLeft: '3px solid #2563eb' }} />
            Đang làm
          </span>
          <span>
            <i style={{ background: '#fef0d6', borderLeft: '3px solid #d99b16' }} />
            Khách vãng lai
          </span>
          <span>
            <i style={{ background: 'var(--danger-bg)', borderLeft: '3px solid var(--danger)' }} />
            Cần xếp lại
          </span>
          <span>
            <i style={{ background: 'rgba(20,52,42,.12)' }} />
            Thời gian dọn dẹp
          </span>
        </div>
      )}

      <Sheet
        open={selectedItem !== null}
        onClose={() => {
          setSelectedItemId(null)
          setStatusError(null)
        }}
        title={selectedItem?.item.customer_name ?? ''}
        footer={
          <Button variant="ghost" onClick={() => setSelectedItemId(null)}>
            Đóng
          </Button>
        }
      >
        {selectedItem && (
          <div data-testid="booking-sheet">
            <div className="ccf-tl-summary">
              <div className="ccf-tl-sline">
                <span className="ccf-tl-k">Dịch vụ</span>
                <span className="ccf-tl-v">{selectedItem.item.service_name}</span>
              </div>
              <div className="ccf-tl-sline">
                <span className="ccf-tl-k">Giờ</span>
                <span className="ccf-tl-v">
                  {formatHm(selectedItem.item.start_at)} – {formatHm(selectedItem.item.end_at)}
                </span>
              </div>
              <div className="ccf-tl-sline">
                <span className="ccf-tl-k">Dọn dẹp sau</span>
                <span className="ccf-tl-v">
                  {Math.round((selectedItem.item.block_end_at - selectedItem.item.end_at) / 60)} phút
                </span>
              </div>
              <div className="ccf-tl-sline">
                <span className="ccf-tl-k">Kỹ thuật viên</span>
                <span className="ccf-tl-v">{selectedItem.staffName}</span>
              </div>
              <div className="ccf-tl-sline">
                <span className="ccf-tl-k">Trạng thái</span>
                <span className="ccf-tl-v" data-testid="sheet-status">
                  {STATUS_LABEL[selectedItem.item.status] ?? selectedItem.item.status}
                </span>
              </div>
            </div>

            {statusError && (
              <Notice tone="warn" style={{ marginTop: 14 }}>
                {statusError}
              </Notice>
            )}

            <div className="ccf-tl-label">Cập nhật trạng thái</div>
            <div className="ccf-tl-actions">
              <Button
                variant="ghost"
                size="sm"
                data-testid="action-in_service"
                disabled={selectedItem.item.status !== 'booked'}
                onClick={() => handleSetStatus('in_service')}
              >
                Bắt đầu làm
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="action-done"
                disabled={selectedItem.item.status !== 'in_service'}
                onClick={() => handleSetStatus('done')}
              >
                Hoàn thành
              </Button>
              <Button
                variant="danger"
                size="sm"
                data-testid="action-no_show"
                disabled={selectedItem.item.status !== 'booked'}
                onClick={() => handleSetStatus('no_show')}
              >
                Khách không đến
              </Button>
            </div>
            <Notice tone="info" style={{ marginTop: 16 }}>
              “Khách không đến” dùng để ghi nhận lịch sử, không mở lại được slot đã trôi qua.
            </Notice>

            {/* T-30: đổi giờ / đổi KTV — chỉ với lịch 'booked' (server chỉ cho
                'booked' reschedule) và chỉ owner/lễ tân. Ẩn nút khi lịch đã bắt
                đầu/xong để lễ tân không bấm rồi nhận INVALID_TRANSITION. */}
            {canAddService && selectedItem.item.status === 'booked' && (
              <Button
                variant="ghost"
                className="ccf-tl-add-btn"
                data-testid="reschedule-open"
                onClick={() => openReschedule(selectedItem.item)}
              >
                Đổi giờ / Đổi KTV
              </Button>
            )}

            {canAddService && (
              <Button
                variant="ghost"
                className="ccf-tl-add-btn"
                data-testid="add-service-open"
                onClick={openAddService}
              >
                + Thêm dịch vụ
              </Button>
            )}
          </div>
        )}
      </Sheet>

      {/* T-30 (a): sheet chọn giờ + KTV mới → reschedule nguyên tử. Đơn giản
          như sheet "Đặt lịch" của T-29 (giờ tự do + chọn KTV), KHÔNG cần lưới
          availability: server nạp variant từ item + là trọng tài skill/slot/ca,
          trả mã lỗi → dịch sang tiếng Việt. */}
      <Sheet
        open={rescheduleItem !== null}
        onClose={closeReschedule}
        title="Đổi giờ / Đổi kỹ thuật viên"
        footer={
          <>
            <Button variant="ghost" onClick={closeReschedule}>
              Đóng
            </Button>
            <Button
              variant="primary"
              data-testid="reschedule-submit"
              disabled={parseHm(rsTime) === null || rsSaving}
              onClick={handleRescheduleSubmit}
            >
              {rsSaving ? 'Đang đổi...' : 'Xác nhận đổi'}
            </Button>
          </>
        }
      >
        {rescheduleItem && (
          <div data-testid="reschedule-sheet">
            <Notice tone="info" style={{ marginBottom: 14 }}>
              Đổi giờ/kỹ thuật viên là thao tác NGUYÊN TỬ — lịch cũ chỉ mất khi giờ mới
              chắc chắn đặt được. Nếu giờ mới vừa bị chiếm, lịch cũ vẫn còn nguyên.
            </Notice>

            {rsError && (
              <Notice tone="warn" style={{ marginBottom: 12 }} data-testid="reschedule-error">
                {rsError}
              </Notice>
            )}

            <div className="ccf-tl-summary" style={{ marginBottom: 14 }}>
              <div className="ccf-tl-sline">
                <span className="ccf-tl-k">Dịch vụ</span>
                <span className="ccf-tl-v">{rescheduleItem.service_name}</span>
              </div>
              <div className="ccf-tl-sline">
                <span className="ccf-tl-k">Giờ hiện tại</span>
                <span className="ccf-tl-v">{formatHm(rescheduleItem.start_at)}</span>
              </div>
            </div>

            <div className="ccf-tl-label">Giờ mới · {formatDateNav(date, todayStr)}</div>
            <Field
              label="Giờ bắt đầu"
              type="time"
              data-testid="reschedule-time"
              value={rsTime}
              onChange={(e) => setRsTime(e.target.value)}
            />

            <Field
              as="select"
              label="Kỹ thuật viên (giữ nguyên nếu chỉ đổi giờ)"
              data-testid="reschedule-staff-select"
              value={rsStaffId ?? ''}
              onChange={(e) => setRsStaffId(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">— Giữ kỹ thuật viên hiện tại —</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Field>
          </div>
        )}
      </Sheet>

      {/* T-30 (b): xác nhận nhẹ sau khi KÉO block sang cột/giờ khác → reschedule
          nguyên tử. Xác nhận để tránh kéo nhầm; gọi API ở confirmDrop. */}
      <Sheet
        open={dropConfirm !== null}
        onClose={() => {
          setDropConfirm(null)
          setDropError(null)
        }}
        title="Xác nhận đổi lịch"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setDropConfirm(null)
                setDropError(null)
              }}
            >
              Huỷ
            </Button>
            <Button
              variant="primary"
              data-testid="drop-confirm-submit"
              disabled={dropSaving}
              onClick={confirmDrop}
            >
              {dropSaving ? 'Đang đổi...' : 'Đổi lịch'}
            </Button>
          </>
        }
      >
        {dropConfirm && (
          <div data-testid="drop-confirm-sheet">
            {dropError && (
              <Notice tone="warn" style={{ marginBottom: 12 }} data-testid="drop-confirm-error">
                {dropError}
              </Notice>
            )}
            <Notice tone="info">
              Đổi lịch của <strong>{dropConfirm.item.customer_name}</strong> ({dropConfirm.item.service_name})
              <br />
              từ <strong>{dropConfirm.fromStaffName}</strong> lúc {formatHm(dropConfirm.item.start_at)}
              <br />
              sang <strong>{dropConfirm.toStaffName}</strong> lúc{' '}
              {String(dropConfirm.hour).padStart(2, '0')}:00?
            </Notice>
          </div>
        )}
      </Sheet>

      <Sheet
        open={addServiceOpen}
        onClose={closeAddService}
        title="Thêm dịch vụ"
        footer={
          <>
            <Button variant="ghost" onClick={closeAddService}>
              Đóng
            </Button>
            <Button
              variant="primary"
              data-testid="add-service-submit"
              disabled={addStaffId === null || addSaving}
              onClick={handleAddServiceSubmit}
            >
              {addSaving ? 'Đang lưu...' : 'Thêm vào lịch'}
            </Button>
          </>
        }
      >
        <div data-testid="add-service-sheet">
          {addLoadError && <Notice tone="warn">{addLoadError}</Notice>}

          {addSaveError && (
            <Notice tone="warn" style={{ marginBottom: 12 }} data-testid="add-service-error">
              {addSaveError}
            </Notice>
          )}

          <Field
            as="select"
            label="Dịch vụ"
            data-testid="add-service-select"
            value={addServiceId ?? ''}
            onChange={(e) => handleAddServiceChange(e.target.value)}
          >
            <option value="">— Chọn dịch vụ —</option>
            {addServices?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Field>

          {addServiceId !== null &&
            (() => {
              const svc = addServices?.find((s) => s.id === addServiceId) ?? null
              if (svc === null) return null
              return (
                <Field
                  as="select"
                  label="Gói"
                  data-testid="add-variant-select"
                  value={addVariantId ?? ''}
                  onChange={(e) => handleAddVariantChange(e.target.value)}
                >
                  <option value="">— Chọn gói —</option>
                  {svc.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Field>
              )
            })()}

          {addVariantId !== null && (
            <>
              <div className="ccf-tl-label">Giờ bắt đầu · {formatDateNav(date, todayStr)}</div>
              {addSlotsLoading && <p>Đang tải...</p>}
              {addSlotsError && <Notice tone="warn">{addSlotsError}</Notice>}
              {!addSlotsLoading && !addSlotsError && addSlots !== null && (
                <>
                  {addSlots.length === 0 ? (
                    <EmptyState icon="🗓️" text="Không còn khung giờ trống cho gói này trong ngày." />
                  ) : (
                    <div className="ccf-tl-slots">
                      {addSlots.map((slot) => (
                        <button
                          type="button"
                          key={slot.start_at}
                          className={`ccf-tl-slot${addStartAt === slot.start_at ? ' ccf-tl-slot--sel' : ''}`}
                          data-testid={`add-slot-${slot.start_at}`}
                          onClick={() => pickAddSlot(slot.start_at)}
                        >
                          {formatHm(slot.start_at)}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {addStartAt !== null &&
            (() => {
              const chosen = addSlots?.find((s) => s.start_at === addStartAt) ?? null
              if (chosen === null) return null
              return (
                <>
                  <div className="ccf-tl-label">Kỹ thuật viên</div>
                  {chosen.staff_ids.length === 0 ? (
                    <Notice tone="warn" data-testid="add-no-staff-notice">
                      Không có ai rảnh vào giờ này cho gói đã chọn.
                    </Notice>
                  ) : (
                    chosen.staff_ids.map((staffId) => {
                      const staffName = schedule?.staff.find((s) => s.id === staffId)?.name ?? `KTV #${staffId}`
                      return (
                        <button
                          type="button"
                          key={staffId}
                          data-testid={`add-staff-${staffId}`}
                          className={`ccf-tl-staffpick${addStaffId === staffId ? ' ccf-tl-staffpick--sel' : ''}`}
                          onClick={() => setAddStaffId(staffId)}
                        >
                          <div className="ccf-tl-nm">{staffName}</div>
                        </button>
                      )
                    })
                  )}
                </>
              )
            })()}
        </div>
      </Sheet>

      <Sheet
        open={createOpen}
        onClose={closeCreateBooking}
        title="Đặt lịch"
        footer={
          <>
            <Button variant="ghost" onClick={closeCreateBooking}>
              Đóng
            </Button>
            <Button
              variant="primary"
              data-testid="create-booking-submit"
              disabled={
                createVariantId === null ||
                createStaffId === null ||
                createName.trim() === '' ||
                parseHm(createTime) === null ||
                createSaving
              }
              onClick={handleCreateBookingSubmit}
            >
              {createSaving ? 'Đang lưu...' : 'Đặt lịch'}
            </Button>
          </>
        }
      >
        <div data-testid="create-booking-sheet">
          {createLoadError && <Notice tone="warn">{createLoadError}</Notice>}

          {createSaveError && (
            <Notice tone="warn" style={{ marginBottom: 12 }} data-testid="create-booking-error">
              {createSaveError}
            </Notice>
          )}

          <div className="ccf-tl-label">Khách hàng</div>
          <Field
            label="Tên khách"
            data-testid="create-booking-name"
            placeholder="Tên khách hàng"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <Field
            label="Số điện thoại (không bắt buộc)"
            type="tel"
            inputMode="numeric"
            data-testid="create-booking-phone"
            placeholder="0901 234 567"
            value={createPhone}
            onChange={(e) => setCreatePhone(e.target.value)}
          />

          <div className="ccf-tl-label">Dịch vụ</div>
          <Field
            as="select"
            label="Dịch vụ"
            data-testid="create-booking-service-select"
            value={createServiceId ?? ''}
            onChange={(e) => handleCreateServiceChange(e.target.value)}
          >
            <option value="">— Chọn dịch vụ —</option>
            {createServices?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Field>

          {createServiceId !== null &&
            (() => {
              const svc = createServices?.find((s) => s.id === createServiceId) ?? null
              if (svc === null) return null
              return (
                <Field
                  as="select"
                  label="Gói"
                  data-testid="create-booking-variant-select"
                  value={createVariantId ?? ''}
                  onChange={(e) => handleCreateVariantChange(e.target.value)}
                >
                  <option value="">— Chọn gói —</option>
                  {svc.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Field>
              )
            })()}

          <div className="ccf-tl-label">Giờ + kỹ thuật viên · {formatDateNav(date, todayStr)}</div>
          <Field
            label="Giờ bắt đầu"
            type="time"
            data-testid="create-booking-time"
            value={createTime}
            onChange={(e) => setCreateTime(e.target.value)}
          />
          <Field
            as="select"
            label="Kỹ thuật viên"
            data-testid="create-booking-staff-select"
            value={createStaffId ?? ''}
            onChange={(e) => setCreateStaffId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">— Chọn kỹ thuật viên —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Field>
        </div>
      </Sheet>

      <Sheet
        open={timeOffStaff !== null}
        onClose={closeTimeOff}
        title={timeOffStaff ? `Báo nghỉ · ${timeOffStaff.name}` : ''}
        footer={
          offAffected !== null ? (
            <Button variant="primary" onClick={() => navigate('/admin/reassign')} data-testid="time-off-go-queue">
              Sang hàng chờ xử lý
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeTimeOff}>
                Đóng
              </Button>
              <Button
                variant="danger"
                onClick={handleSubmitTimeOff}
                disabled={offSubmitting}
                data-testid="time-off-submit"
              >
                {offSubmitting ? 'Đang ghi...' : 'Xác nhận nghỉ'}
              </Button>
            </>
          )
        }
      >
        {timeOffStaff && (
          <div data-testid="time-off-sheet">
            {offAffected === null ? (
              <>
                <Notice tone="info" style={{ marginBottom: 14 }}>
                  Báo nghỉ cho <strong>{timeOffStaff.name}</strong> trong ngày{' '}
                  <strong>{formatDateNav(date, todayStr)}</strong>. Các lịch đã đặt trong khoảng
                  nghỉ sẽ KHÔNG bị huỷ — chúng chuyển vào hàng chờ để bạn gọi khách và xếp người khác.
                </Notice>
                {offError && (
                  <Notice tone="warn" style={{ marginBottom: 14 }} data-testid="time-off-error">
                    {offError}
                  </Notice>
                )}
                <div className="ccf-tl-off-times">
                  <Field
                    label="Nghỉ từ"
                    type="time"
                    value={offStart}
                    onChange={(e) => setOffStart(e.target.value)}
                    data-testid="time-off-start"
                  />
                  <Field
                    label="Đến"
                    type="time"
                    value={offEnd}
                    onChange={(e) => setOffEnd(e.target.value)}
                    data-testid="time-off-end"
                  />
                </div>
                <Field
                  label="Lý do (tuỳ chọn)"
                  value={offReason}
                  onChange={(e) => setOffReason(e.target.value)}
                  placeholder="Ví dụ: ốm, việc gia đình"
                  data-testid="time-off-reason"
                />
              </>
            ) : (
              <div data-testid="time-off-result">
                <Notice tone="warn" style={{ marginBottom: 14 }}>
                  Đã ghi nhận <strong>{timeOffStaff.name}</strong> nghỉ.
                </Notice>
                {offAffected.length === 0 ? (
                  <p>Không có lịch nào trong khoảng nghỉ — không cần xếp lại ai.</p>
                ) : (
                  <>
                    <div className="ccf-tl-label">
                      {offAffected.length} lịch cần xếp lại (đã vào hàng chờ)
                    </div>
                    <ul className="ccf-tl-off-affected" data-testid="time-off-affected-list">
                      {offAffected.map((it) => (
                        <li key={it.item_id}>
                          {formatHm(it.start_at)} · {it.customer_name} — {it.service_name}
                          {it.customer_phone ? ` · ${it.customer_phone}` : ''}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </Sheet>
    </div>
  )
}

// T-31: week view — 7 cột ngày, MỖI ngày đủ thông tin để trả lời câu hỏi lấp-đầy
// ("còn chỗ trống ở đâu"), KHÔNG có drag/tạo (card mục "Ngoài" — giữ tương tác
// đầy đủ cho day view của T-29/T-30). Cách rẻ: đếm số lịch (booked/in_service)
// + số lịch mồ côi mỗi KTV trong ngày, hiện thành badge; bấm ngày để nhảy sang
// day view đúng ngày đó (chuyển view giữ nguyên context — card mục "giữ nguyên
// context" khi qua lại day↔week).
interface WeekViewProps {
  weekDays: ScheduleRangeDay[] | null
  loading: boolean
  error: string | null
  todayStr: string
  orphanIds: Set<number>
  onPickDay: (dateStr: string) => void
}

const LIVE_STATUSES = new Set(['booked', 'in_service'])

function WeekView({ weekDays, loading, error, todayStr, orphanIds, onPickDay }: WeekViewProps) {
  if (loading && weekDays === null) {
    return <p>Đang tải lịch tuần...</p>
  }
  if (error && weekDays === null) {
    return <Notice tone="warn">{error}</Notice>
  }
  if (weekDays === null) return null

  return (
    <div className="ccf-tl-week" data-testid="week-grid">
      {weekDays.map((day) => {
        const isToday = day.date === todayStr
        const totalLive = day.staff.reduce(
          (sum, s) => sum + s.items.filter((i) => LIVE_STATUSES.has(i.status)).length,
          0,
        )
        const totalOrphan = day.staff.reduce(
          (sum, s) => sum + s.items.filter((i) => orphanIds.has(i.id)).length,
          0,
        )
        const isEmpty = totalLive === 0

        return (
          <button
            type="button"
            key={day.date}
            className={`ccf-tl-weekday${isToday ? ' ccf-tl-weekday--today' : ''}`}
            data-testid={`week-day-${day.date}`}
            onClick={() => onPickDay(day.date)}
          >
            <div className="ccf-tl-weekday-head">
              <span className="ccf-tl-weekday-label">{formatWeekColLabel(day.date)}</span>
              {isToday && <span className="ccf-tl-weekday-todaytag">Hôm nay</span>}
            </div>

            {isEmpty ? (
              <div className="ccf-tl-weekday-empty" data-testid={`week-day-empty-${day.date}`}>
                Trống lịch
              </div>
            ) : (
              <div className="ccf-tl-weekday-count" data-testid={`week-day-count-${day.date}`}>
                {totalLive} lịch hẹn
              </div>
            )}
            {totalOrphan > 0 && (
              <div className="ccf-tl-weekday-orphan" data-testid={`week-day-orphan-${day.date}`}>
                {totalOrphan} cần xếp lại
              </div>
            )}

            <div className="ccf-tl-weekday-staff">
              {day.staff.map((s) => {
                const liveCount = s.items.filter((i) => LIVE_STATUSES.has(i.status)).length
                const hasTimeOff = s.time_off.length > 0
                return (
                  <div className="ccf-tl-weekday-srow" key={s.id} data-testid={`week-day-${day.date}-staff-${s.id}`}>
                    <span className="ccf-tl-weekday-sname">{s.name}</span>
                    {hasTimeOff && (
                      <span className="ccf-tl-weekday-sbadge ccf-tl-weekday-sbadge--off" aria-label="Nghỉ">
                        Nghỉ
                      </span>
                    )}
                    <span
                      className={`ccf-tl-weekday-sbadge${liveCount === 0 ? ' ccf-tl-weekday-sbadge--free' : ''}`}
                    >
                      {liveCount === 0 ? 'Rảnh' : liveCount}
                    </span>
                  </div>
                )
              })}
            </div>
          </button>
        )
      })}
    </div>
  )
}
