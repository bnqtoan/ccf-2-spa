import { useEffect, useMemo, useState } from 'react'
import Button from '../../../components/Button'
import EmptyState from '../../../components/EmptyState'
import Notice from '../../../components/Notice'
import Sheet from '../../../components/Sheet'
import {
  ApiError,
  getReassignQueue,
  getSchedule,
  setBookingStatus,
  type ScheduleItem,
  type ScheduleResponse,
  type ScheduleStaff,
} from './api'
import { addDays, formatDateNav, formatHm, minutesOfLocalDay, toDateStr } from './format'
import './timeline.css'

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
        <p>Đang tải lịch...</p>
      </div>
    )
  }

  if (error && schedule === null) {
    return (
      <div className="ccf-tl-page">
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
            onClick={() => {
              // T-13 (màn hàng chờ reassign) chưa xong tại thời điểm viết card
              // này — placeholder tạm: cuộn lên đầu trang thay vì điều hướng.
              // Ghi rõ trong "Đã làm gì".
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }}
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
              <div className="ccf-tl-head" key={s.id} data-testid={`staff-head-${s.id}`}>
                {s.name}
              </div>
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
    </div>
  )
}
