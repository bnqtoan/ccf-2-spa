import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AdminNav from '../../../components/AdminNav'
import Button from '../../../components/Button'
import EmptyState from '../../../components/EmptyState'
import Field from '../../../components/Field'
import Notice from '../../../components/Notice'
import Sheet from '../../../components/Sheet'
import {
  ApiError,
  createTimeOff,
  getReassignQueue,
  getSchedule,
  setBookingStatus,
  type AffectedItem,
  type ScheduleItem,
  type ScheduleResponse,
  type ScheduleStaff,
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

                  return (
                    <div className="ccf-tl-cell" key={`cell-${h}-${s.id}`} data-testid={`cell-${s.id}-${h}`}>
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
          </div>
        )}
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
