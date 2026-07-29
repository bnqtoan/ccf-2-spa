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
  getServices,
  setBookingStatus,
  type AffectedItem,
  type AvailabilitySlot,
  type ScheduleItem,
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

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

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
        {canAddService && (
          <Button variant="primary" size="sm" data-testid="create-booking-open" onClick={openCreateBooking}>
            + Đặt lịch
          </Button>
        )}
      </div>

      {staff.length === 0 ? (
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

                  return (
                    <div
                      className={`ccf-tl-cell${cellIsClickable ? ' ccf-tl-cell--clickable' : ''}`}
                      key={`cell-${h}-${s.id}`}
                      data-testid={`cell-${s.id}-${h}`}
                      onClick={cellIsClickable ? () => openCreateBookingAt(s.id, h) : undefined}
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
                        return (
                          <button
                            type="button"
                            key={item.id}
                            className={`ccf-tl-ev ${cls}${isShort ? ' ccf-tl-ev--short' : ''}`}
                            data-testid={`booking-item-${item.id}`}
                            data-status={item.status}
                            data-orphan={isOrphan ? 'true' : 'false'}
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
